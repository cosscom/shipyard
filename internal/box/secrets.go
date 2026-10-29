package box

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/wire"
)

// Secrets: an environment value can name a secret instead of holding it, so
// a kit or a repository's .berth/config.json can be shared, even publicly,
// without containing one.
//
//	"DATABASE_PASSWORD": "op://dev/shop-db/password"   1Password, through the box's op CLI
//	"STRIPE_KEY": "env://STRIPE_TEST_KEY"             a variable from berthd's own environment
//	"ACME_TOKEN": "box://ACME_TOKEN"                  a secret saved on the box (secretstore.go)
//	"ACME_KEY": "gcp://projects/acme/secrets/ACME_KEY" one saved in Secret Manager
//
// References are resolved on the box, when a worktree's environment is
// built for a session, hook, flow or service. Resolved values live in memory
// for a few minutes and nowhere else: never in a log, an event, an API
// response or an error message, and on disk only in the store a person saved
// them to. A reference that cannot be resolved leaves its variable unset, and
// the box says so once with a secret.failed event.

// secretSchemes are the providers a reference can name besides the saved
// secrets' stores, which register their own (secretstore.go).
var secretSchemes = map[string]bool{"op": true, "env": true}

// IsSecretRef says whether v names a secret rather than holding a value.
func IsSecretRef(v string) bool {
	scheme, _, ok := strings.Cut(v, "://")
	return ok && (secretSchemes[scheme] || secretProviderByScheme(scheme) != nil)
}

// opRef is 1Password's own syntax: op://vault/item/[section/]field, with an
// optional query such as ?attribute=otp.
var opRef = regexp.MustCompile(`^op://[^/?\x00-\x1f]+(/[^/?\x00-\x1f]+){2,3}(\?[A-Za-z0-9_=&.-]+)?$`)

// ValidateSecretRef reports what is wrong with a reference someone wrote.
func ValidateSecretRef(ref string) error {
	scheme, rest, _ := strings.Cut(ref, "://")
	switch scheme {
	case "op":
		if !opRef.MatchString(ref) {
			return fmt.Errorf("%q is not a 1Password reference; they look like op://vault/item/field", ref)
		}
		return nil
	case "env":
		if !envName.MatchString(rest) {
			return fmt.Errorf("%q is not a variable reference; they look like env://NAME", ref)
		}
		return nil
	}
	if p := secretProviderByScheme(scheme); p != nil {
		return p.ValidateRef(ref)
	}
	return fmt.Errorf("%q is not a secret reference; use op://vault/item/field, env://NAME or box://NAME", ref)
}

// validateEnvRefs checks the references among env's values.
func validateEnvRefs(env map[string]string) error {
	for k, v := range env {
		if IsSecretRef(v) {
			if err := ValidateSecretRef(v); err != nil {
				return fmt.Errorf("%s: %w", k, err)
			}
		}
	}
	return nil
}

const (
	secretTTL     = 5 * time.Minute
	secretFailTTL = 30 * time.Second
	secretTimeout = 15 * time.Second
	// How long one failure stays announced before the box says it again.
	secretReportEvery = 10 * time.Minute
)

// opFolders are where the 1Password CLI installs itself, which a service
// manager's PATH may leave out. "~" is the box user's home.
var opFolders = []string{"~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"}

var errNoOp = errors.New("the 1Password CLI (op) is not installed on this box")

// ErrOpSignedOut is a read that failed because op is not signed in on the
// box: no account added yet, or a sign-in that ended.
var ErrOpSignedOut = errors.New("1Password isn't signed in")

// opSignedOut matches what op says when it has no account or session to
// read with, rather than prompting (it can't: berthd runs it without a
// terminal).
var opSignedOut = regexp.MustCompile(`(?i)(not (currently )?signed in|no accounts? (configured|found)|add an account|sign ?in to (your|an) account|session (has )?expired|authentication required|account is not signed|you are not signed in|(op|1password) signin|could not connect to the 1password app|connecting to desktop app)`)

// signedOutError says what to do, naming the box.
func signedOutError(box string) error {
	if box == "" {
		box, _ = os.Hostname()
	}
	return fmt.Errorf("%w on %s: sign in from Team setup or run `berthd secret signin` on the box", ErrOpSignedOut, box)
}

// Secrets resolves references and keeps what it resolved, briefly.
type Secrets struct {
	// Op is the 1Password CLI to run; empty uses $BERTH_OP, or finds op on
	// PATH, then in the usual install folders.
	Op string
	// TTL is how long a resolved value is kept; FailTTL how long a failure
	// is, so a broken reference does not run op for every hook. Timeout
	// bounds one op read.
	TTL, FailTTL, Timeout time.Duration
	// SessionFile keeps the op session `berthd secret signin` made
	// (OP_SESSION_<account>=<token>), which every read passes to op. Empty
	// reads none.
	SessionFile string
	// Box names the box in errors; empty is the hostname.
	Box string
	// Stores reads the secrets saved through secret cards (box://, gcp://);
	// nil reads none.
	Stores *SecretStores

	mu       sync.Mutex
	cache    map[string]*secretEntry
	reported map[string]time.Time
}

type secretEntry struct {
	done  chan struct{}
	value string
	err   error
}

// defaultSecrets serves boxes made without their own.
var defaultSecrets = &Secrets{}

func (b *Box) secrets() *Secrets {
	if b.Secrets != nil {
		return b.Secrets
	}
	return defaultSecrets
}

func orDefault(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

// Forget drops what was resolved for ref, so a replaced value is read anew.
func (s *Secrets) Forget(ref string) {
	s.mu.Lock()
	delete(s.cache, ref)
	s.mu.Unlock()
}

// Resolve returns ref's value, from memory when it was resolved in the last
// few minutes unless fresh is set. opEnv adds settings for the 1Password CLI
// (OP_SERVICE_ACCOUNT_TOKEN, OP_ACCOUNT) to berthd's own environment. Errors
// say what went wrong and never contain a value.
func (s *Secrets) Resolve(ctx context.Context, ref string, opEnv []string, fresh bool) (string, error) {
	for {
		s.mu.Lock()
		if s.cache == nil {
			s.cache = map[string]*secretEntry{}
		}
		e := s.cache[ref]
		if e == nil || fresh {
			break // with s.mu held
		}
		s.mu.Unlock()
		// Someone is resolving it already, or did a moment ago.
		select {
		case <-e.done:
			if e.err == nil || !isCancel(e.err) {
				return e.value, e.err
			}
			// Their caller gave up; try again on ours.
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	e := &secretEntry{done: make(chan struct{})}
	s.cache[ref] = e
	s.mu.Unlock()

	v, err := s.lookup(ctx, ref, opEnv)
	keep := orDefault(s.TTL, secretTTL)
	if err != nil {
		keep = orDefault(s.FailTTL, secretFailTTL)
	}
	s.mu.Lock()
	e.value, e.err = v, err
	if err != nil && isCancel(err) && s.cache[ref] == e {
		// The caller gave up, which says nothing about the reference.
		delete(s.cache, ref)
	}
	s.mu.Unlock()
	close(e.done)
	// The value leaves memory when its time is up, not at the next lookup.
	time.AfterFunc(keep, func() {
		s.mu.Lock()
		if s.cache[ref] == e {
			delete(s.cache, ref)
		}
		s.mu.Unlock()
	})
	return v, err
}

func isCancel(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// ResolveAll resolves every variable's reference at once. A variable that
// could not be resolved is in failed with the reason, and not in values.
func (s *Secrets) ResolveAll(ctx context.Context, refs map[string]string, opEnv []string) (values map[string]string, failed map[string]error) {
	values, failed = map[string]string{}, map[string]error{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for k, ref := range refs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := s.Resolve(ctx, ref, opEnv, false)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failed[k] = err
			} else {
				values[k] = v
			}
		}()
	}
	wg.Wait()
	return values, failed
}

func (s *Secrets) lookup(ctx context.Context, ref string, opEnv []string) (string, error) {
	if err := ValidateSecretRef(ref); err != nil {
		return "", err
	}
	scheme, rest, _ := strings.Cut(ref, "://")
	switch scheme {
	case "env":
		v, ok := os.LookupEnv(rest)
		if !ok {
			return "", fmt.Errorf("%s is not set in berthd's environment", rest)
		}
		return v, nil
	case "op":
		return s.opRead(ctx, ref, opEnv)
	}
	if s.Stores != nil && secretProviderByScheme(scheme) != nil {
		return s.Stores.Resolve(ctx, ref)
	}
	return "", fmt.Errorf("no provider for %s:// references", scheme)
}

// OpBinary is the 1Password CLI these secrets run.
func (s *Secrets) OpBinary() (string, error) { return s.opBinary() }

func (s *Secrets) opBinary() (string, error) {
	op := s.Op
	if op == "" {
		op = os.Getenv("BERTH_OP")
	}
	if op != "" {
		if _, err := os.Stat(op); err != nil {
			return "", errNoOp
		}
		return op, nil
	}
	if p, err := exec.LookPath("op"); err == nil {
		return p, nil
	}
	home, _ := os.UserHomeDir()
	for _, dir := range opFolders {
		if rest, ok := strings.CutPrefix(dir, "~/"); ok {
			if home == "" {
				continue
			}
			dir = filepath.Join(home, rest)
		}
		p := filepath.Join(dir, "op")
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
	}
	return "", errNoOp
}

// opRead runs `op read REF`. op signs in with OP_SERVICE_ACCOUNT_TOKEN when
// it is set, or the session `berthd secret signin` kept, or the box user's
// own op otherwise. It never asks: see opCommand.
func (s *Secrets) opRead(ctx context.Context, ref string, opEnv []string) (string, error) {
	bin, err := s.opBinary()
	if err != nil {
		return "", err
	}
	timeout := orDefault(s.Timeout, secretTimeout)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := s.opCommand(ctx, bin, opEnv, "read", ref)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("op read timed out after %s", timeout)
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if opSignedOut.MatchString(stderr.String()) {
			return "", signedOutError(s.Box)
		}
		msg := opMessage(stderr.String())
		if out := strings.TrimSpace(stdout.String()); out != "" && strings.Contains(msg, out) {
			msg = ""
		}
		if msg == "" {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				return "", fmt.Errorf("op read failed (exit status %d)", ee.ExitCode())
			}
			return "", errors.New("op read failed")
		}
		return "", fmt.Errorf("op: %s", msg)
	}
	v := stdout.String()
	v = strings.TrimSuffix(v, "\n")
	v = strings.TrimSuffix(v, "\r")
	return v, nil
}

// opCommand runs op with no terminal to ask on. Without one it can't sit at
// "add an account? [Y/n]" or a password prompt in a service's terminal, as
// it did when it inherited the terminal it ran in: it opens /dev/tty itself,
// so stdin alone is not enough. In a session of its own it has no
// controlling terminal, and says it isn't signed in instead.
func (s *Secrets) opCommand(ctx context.Context, bin string, opEnv []string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(append(os.Environ(), opEnv...), ReadOpSession(s.SessionFile)...)
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = time.Second
	return cmd
}

// OpWhoami checks op can read with what berthd gives it, without asking:
// nil when it is signed in (a service account, a kept session, the
// desktop app), ErrOpSignedOut when not, or why it couldn't tell.
func (s *Secrets) OpWhoami(ctx context.Context, opEnv []string) (string, error) {
	bin, err := s.opBinary()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, orDefault(s.Timeout, secretTimeout))
	defer cancel()
	cmd := s.opCommand(ctx, bin, opEnv, "whoami")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("op whoami timed out")
		}
		if msg := stderr.String(); opSignedOut.MatchString(msg) || msg == "" {
			return "", signedOutError(s.Box)
		}
		return "", fmt.Errorf("op: %s", opMessage(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

var opSessionVar = regexp.MustCompile(`^OP_SESSION_[A-Za-z0-9_]{1,64}$`)

// ReadOpSession is the session variables kept in file, as KEY=VALUE.
func ReadOpSession(file string) []string {
	if file == "" {
		return nil
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok && opSessionVar.MatchString(k) && v != "" {
			out = append(out, k+"="+v)
		}
	}
	return out
}

// opExport reads `op signin`'s output: export OP_SESSION_<id>="<token>".
var opExport = regexp.MustCompile(`(?m)^\s*(?:export\s+)?(OP_SESSION_[A-Za-z0-9_]{1,64})="?([^"\s]+)"?\s*;?\s*$`)

// ParseOpSignin finds the session variables in `op signin`'s output.
func ParseOpSignin(out string) []string {
	var vars []string
	for _, m := range opExport.FindAllStringSubmatch(out, -1) {
		vars = append(vars, m[1]+"="+m[2])
	}
	return vars
}

// SaveOpSession keeps session variables for berthd's reads, readable by
// the box's user only.
func SaveOpSession(file string, vars []string) error {
	var b strings.Builder
	b.WriteString("# 1Password CLI sessions from `berthd secret signin`; op ends one after 30 minutes unused.\n")
	for _, kv := range vars {
		if k, _, ok := strings.Cut(kv, "="); ok && opSessionVar.MatchString(k) {
			b.WriteString(kv + "\n")
		}
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	return statefile.Write(file, []byte(b.String()))
}

// LoadOpEnv is the 1Password CLI's settings from the box's environment
// file (OP_SERVICE_ACCOUNT_TOKEN, OP_ACCOUNT).
func LoadOpEnv(envFile string) []string {
	if envFile == "" {
		return nil
	}
	e, err := loadBoxEnv(envFile)
	if err != nil {
		return nil
	}
	return opEnvOf(e.Env)
}

var opLogPrefix = regexp.MustCompile(`^\[ERROR\]\s+\d{4}/\d\d/\d\d \d\d:\d\d:\d\d\s*`)

// opMessage is op's last error line, without its log prefix, kept short.
func opMessage(stderr string) string {
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	msg := strings.TrimSpace(opLogPrefix.ReplaceAllString(strings.TrimSpace(lines[len(lines)-1]), ""))
	if utf8.RuneCountInString(msg) > 200 {
		msg = string([]rune(msg)[:200]) + "…"
	}
	return msg
}

// opEnvOf picks the 1Password CLI's settings out of the box's environment
// file, so a service-account token can live there.
func opEnvOf(env map[string]string) []string {
	var out []string
	for k, v := range env {
		if strings.HasPrefix(k, "OP_") && !IsSecretRef(v) {
			out = append(out, k+"="+v)
		}
	}
	sort.Strings(out)
	return out
}

// resolveWorktreeSecrets resolves a worktree's references, announcing each
// failure once and each recovery after one.
func (b *Box) resolveWorktreeSecrets(ctx context.Context, location string, wt Worktree, refs map[string]string, opEnv []string) map[string]string {
	if len(refs) == 0 {
		return nil
	}
	values, failed := b.secrets().ResolveAll(ctx, refs, opEnv)
	if ctx.Err() != nil {
		return values
	}
	b.announceSecrets(location, wt, refs, failed, "")
	return values
}

// announceSecrets sends secret.failed for a failure not announced in the
// last few minutes, and secret.resolved for one that was and now resolves.
func (b *Box) announceSecrets(location string, wt Worktree, refs map[string]string, failed map[string]error, origin string) {
	s := b.secrets()
	now := time.Now()
	for k, ref := range refs {
		key := location + "\x00" + k + "\x00" + ref
		data := map[string]any{"location": location, "name": wt.Name, "path": wt.Path, "variable": k, "ref": ref}
		s.mu.Lock()
		if s.reported == nil {
			s.reported = map[string]time.Time{}
		}
		last, was := s.reported[key]
		announce := false
		if err, bad := failed[k]; bad {
			if !was || now.Sub(last) > secretReportEvery {
				s.reported[key], announce = now, true
				data["reason"] = err.Error()
			}
		} else if was {
			delete(s.reported, key)
			announce = true
		}
		s.mu.Unlock()
		if !announce || b.Events == nil {
			continue
		}
		e := events.Event{Type: "secret.resolved", Box: b.Name, Origin: origin, Data: data}
		if reason, ok := data["reason"].(string); ok {
			e.Type, e.Error = "secret.failed", reason
		}
		b.Events.Publish(e)
	}
}

// SecretReport is what `berthd secret exec` tells the box after resolving a
// session's or service's references in its own process: which resolved, and
// which failed and why. Never a value.
type SecretReport struct {
	Location string         `json:"location"`
	Name     string         `json:"name"`
	Path     string         `json:"path"`
	Results  []SecretResult `json:"results"`
}

type SecretResult struct {
	Variable string `json:"variable"`
	Ref      string `json:"ref"`
	// Reason is why it could not be resolved; empty when it was.
	Reason string `json:"reason,omitempty"`
}

// reportSecrets takes a wrapper's report, from the box's own socket only.
func (b *Box) reportSecrets(w http.ResponseWriter, r *http.Request) error {
	if !wire.IsLocal(r.Context()) {
		return httpError{http.StatusForbidden, "secret reports come from this box's own socket"}
	}
	var rep SecretReport
	if err := decode(r, &rep); err != nil {
		return err
	}
	refs, failed := map[string]string{}, map[string]error{}
	for _, res := range rep.Results {
		if !envName.MatchString(res.Variable) || !IsSecretRef(res.Ref) {
			return badRequest("%q is not a variable naming a secret", res.Variable)
		}
		refs[res.Variable] = res.Ref
		if res.Reason != "" {
			failed[res.Variable] = errors.New(res.Reason)
		}
	}
	b.announceSecrets(rep.Location, Worktree{Name: rep.Name, Path: rep.Path}, refs, failed, origin(r))
	writeJSON(w, map[string]bool{"ok": true})
	return nil
}

// SecretTest is what testing a reference reports: whether it resolved, and
// the value's length, never the value.
type SecretTest struct {
	OK     bool   `json:"ok"`
	Length *int   `json:"length,omitempty"`
	Error  string `json:"error,omitempty"`
}

func (b *Box) testSecret(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Ref string `json:"ref"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	ref := strings.TrimSpace(req.Ref)
	var res SecretTest
	if err := ValidateSecretRef(ref); err != nil {
		res.Error = err.Error()
		writeJSON(w, res)
		return nil
	}
	var opEnv []string
	if e, err := loadBoxEnv(b.EnvFile); err == nil {
		opEnv = opEnvOf(e.Env)
	}
	v, err := b.secrets().Resolve(r.Context(), ref, opEnv, true)
	if err != nil {
		res.Error = err.Error()
	} else {
		n := utf8.RuneCountInString(v)
		res.OK, res.Length = true, &n
	}
	writeJSON(w, res)
	return nil
}

// SecretVarsEnv names the variables whose values `berthd secret exec`
// resolves before it runs a program.
const SecretVarsEnv = "BERTH_SECRET_VARS"

// secretWrap is the command that runs a program with env's references
// resolved: `berthd secret exec [--socket S] --`, to put before the program.
// It adds the references to env as they are, and their names.
func (b *Box) secretWrap(env, refs map[string]string) ([]string, error) {
	self, err := b.self()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(refs))
	for k, ref := range refs {
		env[k] = ref
		names = append(names, k)
	}
	sort.Strings(names)
	env[SecretVarsEnv] = strings.Join(names, ",")
	wrap := []string{self, "secret", "exec"}
	if b.Socket != "" {
		wrap = append(wrap, "--socket", b.Socket)
	}
	return append(wrap, "--"), nil
}

// createSession starts a session in dir with its worktree's environment.
// tmux takes a session's environment as arguments (new-session -e K=V),
// which other processes can read, so a worktree with secrets passes only
// their references and runs the pane's program behind `berthd secret exec`,
// which resolves them in its own memory and replaces itself with the
// program. Without secrets a session starts exactly as it always has.
func (b *Box) createSession(ctx context.Context, name, location, dir, command string) (Session, error) {
	return b.createAgentSession(ctx, name, location, dir, command, "")
}

// createAgentSession starts a session for the agent preset agent ("" for
// a plain command).
func (b *Box) createAgentSession(ctx context.Context, name, location, dir, command, agent string) (Session, error) {
	return b.createAgentSessionWith(ctx, name, location, dir, command, agent, nil, nil)
}

// createAgentSessionWith is createAgentSession with more environment and
// tmux options (a structured agent's: claudedriver.go).
func (b *Box) createAgentSessionWith(ctx context.Context, name, location, dir, command, agent string, extraEnv []string, labels map[string]string) (Session, error) {
	env, wrap := b.sessionEnv(ctx, dir)
	return b.Sessions.create(ctx, name, location, dir, command, agent, append(env, extraEnv...), wrap, labels)
}

func (b *Box) sessionEnv(ctx context.Context, dir string) (env, wrap []string) {
	loc, wt, ok := b.worktreeAt(ctx, dir)
	if !ok {
		return nil, nil
	}
	p, err := b.worktreeEnv(ctx, loc.Name, wt)
	if err != nil {
		return nil, nil
	}
	if len(p.refs) == 0 {
		return p.env, nil
	}
	vars := map[string]string{}
	for _, kv := range p.env {
		k, v, _ := strings.Cut(kv, "=")
		vars[k] = v
	}
	wrap, err = b.secretWrap(vars, p.refs)
	if err != nil {
		// Without the wrapper, the session starts without its secrets.
		return p.env, nil
	}
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		env = append(env, k+"="+vars[k])
	}
	return env, wrap
}
