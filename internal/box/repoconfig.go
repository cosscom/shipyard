package box

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/statefile"
)

// What a repository asks of every worktree: its own ports, environment,
// services and hooks. A repository can commit this in .berth/config.json,
// and a box can add to it or override it for that location alone, for what
// should not be committed (a database password, a box's own paths).

// WorktreeService is a long-running program each worktree runs, such as its dev
// server. It gets the worktree's environment, so it can listen on
// $BERTH_PORT.
type WorktreeService struct {
	Name string `json:"name"`
	Run  string `json:"run"`
	// Autostart starts it when the worktree is created, after setup.
	Autostart bool `json:"autostart,omitempty"`
	// Terminal runs it in a terminal of its own (a tmux session) instead of
	// in the background, which the app shows as a tab: its output live, and
	// Ctrl-C there stops it. Title names that tab; the name does otherwise.
	Terminal bool   `json:"terminal,omitempty"`
	Title    string `json:"title,omitempty"`
}

// serviceTitleMax is the longest a service's tab title can be.
const serviceTitleMax = 48

var serviceName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// validate reports what is wrong with config someone wrote.
func (c RepoConfig) validate() error {
	if c.Ports < 0 || c.Ports > maxPortsPerWorktree {
		return fmt.Errorf("ports must be between 0 and %d", maxPortsPerWorktree)
	}
	seen := map[string]bool{}
	for _, s := range c.Services {
		if !serviceName.MatchString(s.Name) {
			return fmt.Errorf("service name %q must be lowercase letters, digits and dashes", s.Name)
		}
		if seen[s.Name] {
			return fmt.Errorf("two services are called %s", s.Name)
		}
		seen[s.Name] = true
		if strings.TrimSpace(s.Run) == "" {
			return fmt.Errorf("service %s has nothing to run", s.Name)
		}
		if len([]rune(s.Title)) > serviceTitleMax || strings.ContainsAny(s.Title, "\r\n\t") {
			return fmt.Errorf("service %s: title must be one line of at most %d characters", s.Name, serviceTitleMax)
		}
	}
	for k := range c.Env {
		if !envName.MatchString(k) {
			return fmt.Errorf("%q is not an environment variable name", k)
		}
	}
	if err := validateEnvRefs(c.Env); err != nil {
		return err
	}
	if c.Secrets != nil {
		if err := c.Secrets.validate(); err != nil {
			return err
		}
	}
	if err := ValidateFlows(c.Flows); err != nil {
		return err
	}
	if c.Login != nil {
		if err := c.Login.validate(); err != nil {
			return err
		}
	}
	return hooks.Validate(c.Hooks)
}

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Merge lays local over repo, as a box does with its own config.
func Merge(repo, local RepoConfig) RepoConfig { return merge(repo, local) }

// merge lays local over repo: scalars and env entries replace, services and
// agents replace by name, and hooks add up.
func merge(repo, local RepoConfig) RepoConfig {
	out := repo
	if local.Setup != "" {
		out.Setup = local.Setup
	}
	if local.Archive != "" {
		out.Archive = local.Archive
	}
	if local.Check != "" {
		out.Check = local.Check
	}
	if local.Ports != 0 {
		out.Ports = local.Ports
	}
	if len(local.Env) > 0 {
		out.Env = map[string]string{}
		for k, v := range repo.Env {
			out.Env[k] = v
		}
		for k, v := range local.Env {
			out.Env[k] = v
		}
	}
	out.Services = mergeBy(repo.Services, local.Services, func(s WorktreeService) string { return s.Name })
	out.Agents = mergeBy(repo.Agents, local.Agents, func(a AgentPreset) string { return a.ID })
	out.Hooks = append(append([]hooks.Hook{}, repo.Hooks...), local.Hooks...)
	out.Flows = mergeBy(repo.Flows, local.Flows, func(f Flow) string { return f.ID })
	out.BrowserAllow = append(append([]string{}, repo.BrowserAllow...), local.BrowserAllow...)
	if local.Shots != nil {
		out.Shots = local.Shots
	}
	// A login is whole: the script and its users go together.
	if local.Login != nil {
		out.Login = local.Login
	}
	if local.ReviewButton != nil {
		out.ReviewButton = local.ReviewButton
	}
	if local.KeepMain != nil {
		out.KeepMain = local.KeepMain
	}
	// Where secrets go is the box's to say alone.
	out.Secrets = local.Secrets
	return out
}

func mergeBy[T any](base, over []T, key func(T) string) []T {
	out := append([]T{}, base...)
	for _, o := range over {
		replaced := false
		for i := range out {
			if key(out[i]) == key(o) {
				out[i], replaced = o, true
			}
		}
		if !replaced {
			out = append(out, o)
		}
	}
	return out
}

// Config is a location's config as the app shows and edits it.
type Config struct {
	// Repo is the repository's .berth/config.json as this box applies it,
	// read-only here. Until the file is trusted that is its ports alone;
	// RepoTrust.Wants holds the rest.
	Repo     *RepoConfig `json:"repo"`
	RepoPath string      `json:"repo_path"`
	// RepoTrust says whether this box runs the repository's config.
	RepoTrust RepoTrust `json:"repo_trust"`
	// Kit is the kit installed for the location, if any.
	Kit *InstalledKit `json:"kit,omitempty"`
	// Local is this box's own config for the location.
	Local     RepoConfig `json:"local"`
	Effective RepoConfig `json:"effective"`
	// ReviewButton is whether PRs opened from the project's worktrees get
	// the "Review in Shipyard" button, and from where (reviewbutton.go):
	// the team's team.json counts too, which Effective doesn't hold.
	ReviewButton *ReviewButtonState `json:"review_button,omitempty"`
}

// Config reads a location's config. A broken repository file is reported
// rather than silently ignored, since it would change what worktrees get.
func (l *Locations) Config(ctx context.Context, name string) (Config, error) {
	saved, err := l.saved(name)
	if err != nil {
		return Config{}, err
	}
	out := Config{RepoPath: filepath.Join(saved.Path, RepoConfigFile)}
	repo, trust, err := repoLayer(saved)
	if err != nil {
		return Config{}, err
	}
	out.RepoTrust = trust
	if trust.State != RepoTrustNone {
		out.Repo = &repo
	}
	if saved.Config != nil {
		out.Local = *saved.Config
	}
	// Scripts set the older way count as local config.
	if saved.Setup != "" {
		out.Local.Setup = saved.Setup
	}
	if saved.Archive != "" {
		out.Local.Archive = saved.Archive
	}
	out.Kit = saved.Kit
	out.Effective = layered(repo, saved.Kit, out.Local)
	return out, nil
}

// layered is what a location runs with: the repository's config, then its
// kit's, then this box's own. repo must be what repoLayer gives, so an
// untrusted repository adds nothing that runs.
func layered(repo RepoConfig, kit *InstalledKit, local RepoConfig) RepoConfig {
	if kit != nil {
		repo = merge(repo, kit.Config)
	}
	return merge(repo, local)
}

func (l *Locations) saved(name string) (savedLocation, error) {
	all, err := l.read()
	if err != nil {
		return savedLocation{}, err
	}
	for _, s := range all {
		if s.Name == name {
			return s, nil
		}
	}
	return savedLocation{}, ErrUnknownLocation
}

// SetLocalConfig replaces this box's own config for a location.
func (l *Locations) SetLocalConfig(name string, c RepoConfig) error {
	if err := c.validate(); err != nil {
		return err
	}
	return l.update(func(all []savedLocation) ([]savedLocation, error) {
		for i := range all {
			if all[i].Name == name {
				cc := c
				all[i].Config = &cc
				// The config now holds the scripts.
				all[i].Setup, all[i].Archive = "", ""
				return all, nil
			}
		}
		return nil, ErrUnknownLocation
	})
}

// Ports: each worktree gets a stable block of ports of its own, so two
// worktrees of one app never fight over 3000.

const (
	portBase            = 41000
	portLimit           = 48999
	portBlock           = 10
	maxPortsPerWorktree = portBlock
)

// PortAlloc remembers which block each worktree has, by path.
type PortAlloc struct {
	Path string
	mu   sync.Mutex
}

func (p *PortAlloc) load() map[string]int {
	m := map[string]int{}
	if b, err := os.ReadFile(p.Path); err == nil {
		json.Unmarshal(b, &m)
	}
	return m
}

// For returns dir's first port, giving it a free block if it has none.
// Blocks of worktrees whose folder is gone are reused.
func (p *PortAlloc) For(dir string) (int, error) {
	if p == nil {
		return 0, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	m := p.load()
	if port, ok := m[dir]; ok {
		return port, nil
	}
	used := map[int]bool{}
	for path, port := range m {
		if _, err := os.Stat(path); err != nil {
			delete(m, path)
			continue
		}
		used[port] = true
	}
	for port := portBase; port+portBlock-1 <= portLimit; port += portBlock {
		if !used[port] {
			m[dir] = port
			b, _ := json.MarshalIndent(m, "", "  ")
			return port, statefile.Write(p.Path, b)
		}
	}
	return 0, fmt.Errorf("every port block from %d to %d is taken", portBase, portLimit)
}

// Release frees dir's block.
func (p *PortAlloc) Release(dir string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	m := p.load()
	if _, ok := m[dir]; ok {
		delete(m, dir)
		b, _ := json.MarshalIndent(m, "", "  ")
		statefile.Write(p.Path, b)
	}
}

var nonIdent = regexp.MustCompile(`[^a-z0-9]+`)

// WorktreeEnv is what everything run in a worktree gets: berth's variables
// for it, then the location's env with those variables expanded, with
// secret references resolved. A reference that cannot be resolved leaves its
// variable out, and the box announces it with a secret.failed event.
func (b *Box) WorktreeEnv(ctx context.Context, location string, wt Worktree) ([]string, error) {
	p, err := b.worktreeEnv(ctx, location, wt)
	if err != nil {
		return nil, err
	}
	values := b.resolveWorktreeSecrets(ctx, p.location, wt, p.refs, p.opEnv)
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	env := p.env
	for _, k := range keys {
		env = append(env, k+"="+values[k])
	}
	return env, nil
}

// worktreeEnvParts is a worktree's environment before its secrets are
// resolved.
type worktreeEnvParts struct {
	location string
	// env is every variable that holds a value, as KEY=VALUE.
	env []string
	// refs are the variables that name a secret, with its reference.
	refs map[string]string
	// opEnv configures the 1Password CLI from the box's environment file.
	opEnv []string
}

func (b *Box) worktreeEnv(ctx context.Context, location string, wt Worktree) (worktreeEnvParts, error) {
	loc, err := b.Locations.Get(ctx, location)
	if err != nil {
		return worktreeEnvParts{}, err
	}
	cfg, err := b.Locations.Config(ctx, location)
	if err != nil {
		return worktreeEnvParts{}, err
	}
	vars := map[string]string{
		"BERTH_BOX":           b.Name,
		"BERTH_LOCATION":      loc.Name,
		"BERTH_ROOT_PATH":     loc.Path,
		"BERTH_WORKTREE_PATH": wt.Path,
		"BERTH_WORKTREE_NAME": wt.Name,
		// Safe in database and container names: shop_fix_checkout.
		"BERTH_WORKTREE_SLUG": strings.Trim(nonIdent.ReplaceAllString(strings.ToLower(loc.Name+"_"+wt.Name), "_"), "_"),
		"BERTH_BRANCH":        wt.Branch,
	}
	if cfg.Kit != nil {
		vars["BERTH_KIT_DIR"] = cfg.Kit.Dir
	}
	// BERTH_URL is the worktree's private URL as the human opens it on the
	// laptop (its proxy on :1377), which the agent's browser opens too.
	if u := worktreeURL(b.Name, loc.Name, wt); u != "" {
		vars["BERTH_URL"] = u
	}
	// A browser an agent runs itself (Playwright MCP, say) goes through
	// the worktree's browser proxy: confined like berth's own.
	if b.BrowserProxies != nil {
		if p, err := b.BrowserProxies.For(b, wt.Path); err == nil {
			vars["BERTH_BROWSER_PROXY"] = p.Addr()
			vars["PLAYWRIGHT_MCP_PROXY_SERVER"] = p.Addr()
			vars["PLAYWRIGHT_MCP_PROXY_BYPASS"] = "<-loopback>"
		}
	}
	if port, err := b.Locations.Ports.For(wt.Path); err != nil {
		return worktreeEnvParts{}, err
	} else if port > 0 {
		vars["BERTH_PORT"] = strconv.Itoa(port)
		for i := 1; i < max(cfg.Effective.Ports, 1); i++ {
			vars["BERTH_PORT_"+strconv.Itoa(i)] = strconv.Itoa(port + i)
		}
	}
	// The box's own environment comes first; the project's overrides it.
	boxEnv, err := loadBoxEnv(b.EnvFile)
	if err != nil {
		return worktreeEnvParts{}, err
	}
	merged := map[string]string{}
	for k, v := range boxEnv.Env {
		merged[k] = v
	}
	for k, v := range cfg.Effective.Env {
		merged[k] = v
	}
	// A pull request opened for review gets the team's shared keys, as any
	// worktree does, and never the reviewer's own (prreview.go).
	if _, mark := b.Locations.reviewAt(wt.Path); mark != nil && wt.Path != "" {
		for _, k := range mark.Withheld {
			delete(merged, k)
		}
		vars["BERTH_REVIEW"] = strconv.Itoa(mark.PR)
		vars["BERTH_REVIEW_REPO"] = mark.Repo
		vars["BERTH_REVIEW_SHA"] = mark.SHA
		vars["BERTH_WITHHELD"] = strings.Join(mark.Withheld, ",")
	}
	// Many dev servers read PORT (the hello sample, Express, Next.js): give
	// it the worktree's own in every terminal, agent and service, unless the
	// box or the project sets it. Without it every worktree's `npm start`
	// took the same default port, and on a Mac, where a server's folder was
	// not known, its worktree's URL led nowhere.
	if _, ok := merged["PORT"]; !ok && vars["BERTH_PORT"] != "" {
		vars["PORT"] = vars["BERTH_PORT"]
	}
	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	p := worktreeEnvParts{location: loc.Name, env: make([]string, 0, len(vars)+len(keys)), refs: map[string]string{}, opEnv: opEnvOf(boxEnv.Env)}
	for k, v := range vars {
		p.env = append(p.env, k+"="+v)
	}
	sort.Strings(p.env)
	for _, k := range keys {
		// A reference is resolved as it is: a secret's value is never
		// expanded, so a $ in a password stays a $.
		if IsSecretRef(merged[k]) {
			p.refs[k] = merged[k]
			continue
		}
		v := os.Expand(merged[k], func(name string) string {
			if v, ok := vars[name]; ok {
				return v
			}
			return os.Getenv(name)
		})
		p.env = append(p.env, k+"="+v)
	}
	return p, nil
}

// envForDir is the worktree environment for dir, or nothing when dir is not
// in a location.
func (b *Box) envForDir(ctx context.Context, dir string) []string {
	loc, wt, ok := b.worktreeAt(ctx, dir)
	if !ok {
		return nil
	}
	env, err := b.WorktreeEnv(ctx, loc.Name, wt)
	if err != nil {
		return nil
	}
	return env
}

// worktreeAt finds the location and worktree containing dir.
func (b *Box) worktreeAt(ctx context.Context, dir string) (Location, Worktree, bool) {
	locs, err := b.Locations.List(ctx)
	if err != nil {
		return Location{}, Worktree{}, false
	}
	var best Worktree
	var bestLoc Location
	for _, l := range locs {
		for _, w := range l.Worktrees {
			if (dir == w.Path || strings.HasPrefix(dir, w.Path+string(filepath.Separator))) && len(w.Path) > len(best.Path) {
				best, bestLoc = w, l
			}
		}
	}
	return bestLoc, best, best.Path != ""
}

func (b *Box) getConfig(w http.ResponseWriter, r *http.Request) error {
	c, err := b.Locations.Config(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	st := b.reviewButtonFor(r.PathValue("name"))
	c.ReviewButton = &st
	writeJSON(w, c)
	return nil
}

func (b *Box) putConfig(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Local RepoConfig `json:"local"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	name := r.PathValue("name")
	if err := b.before(r, "config.change", map[string]any{"location": name}); err != nil {
		return err
	}
	if err := b.Locations.SetLocalConfig(name, req.Local); err != nil {
		if err == ErrUnknownLocation {
			return err
		}
		return badRequest("%v", err)
	}
	b.publish(r, "config.changed", map[string]any{"location": name})
	return b.getConfig(w, r)
}

var urlLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// worktreeURL is http://<worktree>.<location>.<box>.localhost:1377 (the main
// checkout: <location>.<box>.localhost:1377), or "" when a name cannot be a
// hostname label. A laptop whose proxy is on port 80 drops the port; the
// agent's browser accepts either.
func worktreeURL(box, location string, wt Worktree) string {
	labels := []string{strings.ToLower(wt.Name), strings.ToLower(location), strings.ToLower(box)}
	if wt.Main {
		labels = labels[1:]
	}
	for _, l := range labels {
		if !urlLabel.MatchString(l) {
			return ""
		}
	}
	return "http://" + strings.Join(labels, ".") + ".localhost:1377"
}
