package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/statefile"
)

// secretExec is how a worktree's service gets its secrets: its unit runs
// `berthd secret exec -- PROGRAM...` with the references in its environment
// and their names in BERTH_SECRET_VARS, and this resolves them in memory and
// replaces itself with the program. The unit file on disk only ever holds
// the references. Terminal and agent sessions in a worktree with secrets run
// behind it too, since tmux would otherwise take the values as arguments. A
// reference that cannot be resolved leaves its variable unset, and the box
// hears about it and announces it as a secret.failed event.
//
// An agent runs it itself to use a saved secret in one command:
// --env K=box://NAME puts the value in K for that command alone, and
// --file K=box://NAME writes it to a private temporary file, puts the
// file's path in K, and removes the file when the command ends. These
// must resolve: one that can't stops the command.
func secretExec(b boxHome, args []string) error {
	fs := flag.NewFlagSet("secret exec", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	socket := fs.String("socket", b.socket(), "the box's local API socket")
	var envRefs, fileRefs refFlags
	fs.Var(&envRefs, "env", "VAR=REF: the value of REF in VAR, for this command")
	fs.Var(&fileRefs, "file", "VAR=REF: a temporary file holding REF's value, its path in VAR")
	if err := fs.Parse(args); err != nil {
		return err
	}
	argv := fs.Args()
	if len(argv) == 0 {
		return errors.New("usage: berthd secret exec [--socket PATH] [--env VAR=REF]... [--file VAR=REF]... -- PROGRAM [ARGS...]")
	}
	refs := map[string]string{}
	for _, k := range strings.Split(os.Getenv(box.SecretVarsEnv), ",") {
		if k = strings.TrimSpace(k); k != "" {
			refs[k] = os.Getenv(k)
			// Never pass a reference on as if it were the value.
			os.Unsetenv(k)
		}
	}
	os.Unsetenv(box.SecretVarsEnv)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	values, failed := b.boxSecrets().ResolveAll(ctx, refs, nil)
	rep := box.SecretReport{Location: os.Getenv("BERTH_LOCATION"), Name: os.Getenv("BERTH_WORKTREE_NAME"), Path: os.Getenv("BERTH_WORKTREE_PATH")}
	for k, v := range values {
		os.Setenv(k, v)
		rep.Results = append(rep.Results, box.SecretResult{Variable: k, Ref: refs[k]})
	}
	for k, err := range failed {
		fmt.Fprintf(os.Stderr, "berthd: %s is not set: %s (%s)\n", k, err, refs[k])
		rep.Results = append(rep.Results, box.SecretResult{Variable: k, Ref: refs[k], Reason: err.Error()})
	}
	if len(rep.Results) > 0 {
		reportSecrets(*socket, rep)
	}
	asked := map[string]string{}
	for k, ref := range envRefs {
		asked[k] = ref
	}
	for k, ref := range fileRefs {
		asked[k] = ref
	}
	got, bad := b.boxSecrets().ResolveAll(ctx, asked, nil)
	if len(bad) > 0 {
		var msgs []string
		for k, err := range bad {
			msgs = append(msgs, fmt.Sprintf("%s (%s): %s", k, asked[k], err))
		}
		sort.Strings(msgs)
		return errors.New("could not resolve " + strings.Join(msgs, "; "))
	}
	for k := range envRefs {
		os.Setenv(k, got[k])
	}
	bin, err := exec.LookPath(argv[0])
	if err != nil {
		return err
	}
	if len(fileRefs) == 0 {
		return syscall.Exec(bin, argv, os.Environ())
	}
	files := map[string]string{}
	for k := range fileRefs {
		files[k] = got[k]
	}
	code, err := runWithFiles(bin, argv, files)
	if err != nil {
		return err
	}
	if code != 0 {
		return exitCode(code)
	}
	return nil
}

// refFlags is a repeated VAR=REF flag.
type refFlags map[string]string

func (r *refFlags) String() string { return "" }

func (r *refFlags) Set(v string) error {
	k, ref, ok := strings.Cut(v, "=")
	if !ok || !envVarName.MatchString(k) {
		return fmt.Errorf("%q is not VAR=REF", v)
	}
	if err := box.ValidateSecretRef(ref); err != nil {
		return err
	}
	if *r == nil {
		*r = refFlags{}
	}
	(*r)[k] = ref
	return nil
}

var envVarName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// secretFileDir is where --file writes: a folder in memory when the box
// has one, so the value never reaches a disk.
func secretFileDir() string {
	if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			return d
		}
	}
	if st, err := os.Stat("/dev/shm"); err == nil && st.IsDir() {
		return "/dev/shm"
	}
	return os.TempDir()
}

// runWithFiles runs a program with each value in a file of its own,
// readable by this user only, and each variable naming its file. The files
// go when the program ends, and when this is stopped by a signal, which it
// passes on to the program first.
func runWithFiles(bin string, argv []string, values map[string]string) (int, error) {
	dir, err := os.MkdirTemp(secretFileDir(), "berth-secret-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(dir)
	env := os.Environ()
	for k, v := range values {
		p := filepath.Join(dir, k)
		if err := os.WriteFile(p, []byte(v), 0o600); err != nil {
			return 0, err
		}
		env = append(env, k+"="+p)
	}
	cmd := exec.Command(bin, argv[1:]...)
	cmd.Env, cmd.Stdin, cmd.Stdout, cmd.Stderr = env, os.Stdin, os.Stdout, os.Stderr
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT)
	defer signal.Stop(sigs)
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	for {
		select {
		case s := <-sigs:
			cmd.Process.Signal(s)
		case err := <-done:
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				if st, ok := ee.Sys().(syscall.WaitStatus); ok && st.Signaled() {
					return 128 + int(st.Signal()), nil
				}
				return ee.ExitCode(), nil
			}
			return 0, err
		}
	}
}

// reportSecrets tells the box, if berthd is running, which variables
// resolved and which could not and why, so the app can say so. Never a
// value.
func reportSecrets(socket string, rep box.SecretReport) {
	if _, err := os.Stat(socket); err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	box.NewClient(box.NewLocal(socket)).ReportSecrets(ctx, rep)
}

// opSessionFile keeps the session `berthd secret signin` made, for berthd's
// reads of op:// references.
func (b boxHome) opSessionFile() string { return filepath.Join(b.dir, "op-session") }

// boxSecrets is how this box reads secrets, outside berthd serve too.
func (b boxHome) boxSecrets() *box.Secrets {
	host, _ := os.Hostname()
	return &box.Secrets{SessionFile: b.opSessionFile(), Box: host, Stores: b.secretStores()}
}

// secretStores are the secrets saved through secret cards, which berthd
// serve saves and any process on the box reads.
func (b boxHome) secretStores() *box.SecretStores {
	host, _ := os.Hostname()
	return &box.SecretStores{Dir: b.dir, Box: host}
}

// secretSignin signs the box's op in to 1Password, in the terminal it runs
// in, and keeps the session for berthd: a team setup's 1Password step runs
// it, and so can the box's user. `op signin` on its own only signs in the
// shell it runs in, which berthd can't see. With --check it only says
// whether berthd can read 1Password now (exit 0) or not (exit 1), asking
// nothing.
func secretSignin(b boxHome, args []string) error {
	fs := flag.NewFlagSet("secret signin", flag.ContinueOnError)
	check := fs.Bool("check", false, "only check whether berthd can read 1Password on this box")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s := b.boxSecrets()
	var opEnv []string
	if dir, err := statefile.UserDir(); err == nil {
		opEnv = box.LoadOpEnv(filepath.Join(dir, "env.json"))
	}
	ctx := context.Background()
	bin, err := s.OpBinary()
	if err != nil {
		fmt.Fprintln(os.Stderr, "op, the 1Password CLI, is not installed on this box. Install it (https://developer.1password.com/docs/cli/get-started/), then try again.")
		return exitCode(127)
	}
	if who, err := s.OpWhoami(ctx, opEnv); err == nil {
		fmt.Printf("1Password: this box is signed in%s.\n", firstLine(who, " as "))
		return nil
	} else if *check {
		fmt.Fprintln(os.Stderr, err)
		return exitCode(1)
	}
	fmt.Println("Sign op in to your 1Password account. If this box has none yet, op asks to add")
	fmt.Println("one: your sign-in address (such as my.1password.com), email, Secret Key and")
	fmt.Println("password. You type them here; Shipyard never sees them. It keeps only op's session,")
	fmt.Println("readable by you alone, so the box can read the team's shared keys.")
	fmt.Println()
	cmd := exec.Command(bin, "signin")
	cmd.Env = append(os.Environ(), opEnv...)
	cmd.Stdin, cmd.Stderr = os.Stdin, os.Stderr
	var out strings.Builder
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "op signin did not finish:", err)
		return exitCode(1)
	}
	vars := box.ParseOpSignin(out.String())
	if len(vars) > 0 {
		if err := box.SaveOpSession(b.opSessionFile(), vars); err != nil {
			return err
		}
	}
	who, err := s.OpWhoami(ctx, opEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "op signed in, but berthd still can't read 1Password:", err)
		return exitCode(1)
	}
	fmt.Printf("\n1Password: signed in%s. berthd reads op:// references with this session; op ends it\n", firstLine(who, " as "))
	fmt.Println("after 30 minutes unused, and then this asks again. A service account never ends:")
	fmt.Println("put OP_SERVICE_ACCOUNT_TOKEN in ~/.berth/env.json instead.")
	return nil
}

func firstLine(s, prefix string) string {
	s = strings.TrimSpace(strings.SplitN(s, "\n", 2)[0])
	if s == "" {
		return ""
	}
	return prefix + s
}

// exitCode ends berthd with a status, after what was printed.
type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("exit status %d", int(e)) }
