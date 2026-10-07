// Package agentpath finds the agent CLIs (claude, codex, …) on a box the way
// the person's own terminal would.
//
// berthd runs as a systemd user service or a launchd agent, with the PATH it
// was installed with. Shipyard's own installer puts agents in ~/.local/bin,
// which that PATH has; but `npm i -g @anthropic-ai/claude-code` under nvm,
// fnm, volta, a custom npm prefix, bun or Homebrew puts the CLI in a folder
// only the person's interactive shell knows (nvm lives in ~/.bashrc, which a
// login shell alone never reads). So an agent is looked for, in order:
//
//  1. through the person's shell, interactive and login ($SHELL -lic), as a
//     terminal would start it, reading only what lies between markers so a
//     banner or a prompt the rc files print can't be mistaken for a path;
//  2. on berthd's own PATH;
//  3. where installers put agents: ~/.local/bin, `npm prefix -g`/bin, nvm's
//     default alias (then its other versions), fnm's default, volta, bun,
//     pnpm, ~/.npm-global and Homebrew.
//
// The shell's answer wins when both an npm install and Shipyard's exist, as it
// does in the person's terminal. What is found is kept per command, with the
// PATH to launch it with (the folder it is in, then the shell's PATH, so an
// npm CLI's `#!/usr/bin/env node` finds the node beside it), until Refresh
// asks again: doctor, Add agents and integrations do, and the app's Look
// again in Settings › Boxes.
package agentpath

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Commands are the agent CLIs Shipyard starts, looked for together.
var Commands = []string{"claude", "codex", "opencode", "gemini", "cursor-agent", "pi", "grok"}

// Found is where an agent's command is.
type Found struct {
	Command string `json:"command"`
	// Path is the executable, absolute.
	Path string `json:"path"`
	// Via says how it was found: "shell" (the person's shell resolves it),
	// "path" (berthd's own PATH) or "dir" (a folder installers use).
	Via string `json:"via"`
	// Install is how it was installed, when the path says: "npm",
	// "Homebrew", "bun", "volta", "pnpm", or "" (a native installer's).
	Install string `json:"install,omitempty"`
	// Version is the first line of `<path> --version`, when it answered.
	Version string `json:"version,omitempty"`
	// PATH is what to launch it with: its folder first, then the shell's
	// PATH (or berthd's), so its own child tools (node) are found.
	PATH string `json:"-"`
}

// Finder looks for agent CLIs and keeps what it found.
type Finder struct {
	// Home is the person's home folder.
	Home string
	// Shell is their shell; "" skips asking it.
	Shell string
	// Env is what the shell and npm run with; nil means this process's.
	Env []string
	// Timeout bounds the shell (default 10s).
	Timeout time.Duration
	// TTL is how long an answer is used before it is looked for again in
	// the background (default 10 minutes).
	TTL time.Duration
	// LookPath searches berthd's own PATH; nil means exec.LookPath.
	LookPath func(string) (string, error)
	// SystemDirs are Homebrew's and the system's folders, after home's;
	// nil means the defaults (tests empty them).
	SystemDirs []string
	// NoVersion skips running `--version`; NoNPM, asking npm for its
	// global prefix.
	NoVersion, NoNPM bool
	// NoCache looks every time, keeping nothing (tests).
	NoCache bool

	mu       sync.Mutex
	found    map[string]Found // "" Path: looked for, not there
	at       time.Time
	shellOK  bool
	shellErr string
	shellRan time.Duration
	busy     chan struct{} // closed when the running lookup ends
	versions map[string]versionEntry
}

type versionEntry struct {
	mod     time.Time
	version string
}

var (
	defaultOnce sync.Once
	def         *Finder
)

// Default is this process's finder: the user's home and shell.
func Default() *Finder {
	defaultOnce.Do(func() {
		home, _ := os.UserHomeDir()
		def = &Finder{Home: home, Shell: userShell()}
	})
	return def
}

// ForHome is Default for this user's home, and for another (a test's) a
// finder that only looks in that home's folders, never at the shell.
func ForHome(home string) *Finder {
	d := Default()
	if home == "" || filepath.Clean(home) == filepath.Clean(d.Home) {
		return d
	}
	return &Finder{Home: home, Env: []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}, NoVersion: true, NoNPM: true, NoCache: true}
}

// home is Home, or this user's when it is empty.
func (f *Finder) home() string {
	if f.Home != "" {
		return f.Home
	}
	h, _ := os.UserHomeDir()
	return h
}

func (f *Finder) timeout() time.Duration {
	if f.Timeout > 0 {
		return f.Timeout
	}
	return 10 * time.Second
}

func (f *Finder) ttl() time.Duration {
	if f.TTL > 0 {
		return f.TTL
	}
	return 10 * time.Minute
}

func (f *Finder) env() []string {
	if f.Env != nil {
		return f.Env
	}
	return os.Environ()
}

func (f *Finder) lookPath(name string) (string, error) {
	if f.LookPath != nil {
		return f.LookPath(name)
	}
	return exec.LookPath(name)
}

// Find is where command is, from what was found last; the first call looks
// (once, for every agent), and an answer older than TTL is looked for again
// in the background while the old one is used.
func (f *Finder) Find(command string) (Found, bool) {
	if f.NoCache {
		res, _ := f.lookup(context.Background(), uniq([]string{command}))
		r := res[command]
		return r, r.Path != ""
	}
	f.mu.Lock()
	r, known := f.found[command]
	if known && time.Since(f.at) > f.ttl() && f.busy == nil {
		// Marked fresh now, so only one lookup starts.
		f.at = time.Now()
		go f.Refresh(context.Background())
	}
	f.mu.Unlock()
	if !known {
		r = f.look(context.Background(), false, command)[command]
	}
	return r, r.Path != ""
}

// Has reports whether command is found.
func (f *Finder) Has(command string) bool {
	_, ok := f.Find(command)
	return ok
}

// Status is what the last lookup saw of the shell, for doctor.
type Status struct {
	Shell string
	// OK says the shell answered; Error says why not.
	OK    bool
	Error string
	Took  time.Duration
	At    time.Time
}

// Status says how the last lookup went.
func (f *Finder) Status() Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return Status{Shell: f.Shell, OK: f.shellOK, Error: f.shellErr, Took: f.shellRan, At: f.at}
}

// Refresh looks for every agent again (and extra commands), now: after
// whatever lookup is already running, never at the same time.
func (f *Finder) Refresh(ctx context.Context, extra ...string) map[string]Found {
	return f.look(ctx, true, extra...)
}

// look waits for a lookup already running; then, when fresh is asked for or
// a command is still unknown, it looks itself.
func (f *Finder) look(ctx context.Context, fresh bool, extra ...string) map[string]Found {
	f.mu.Lock()
	for f.busy != nil {
		ch := f.busy
		f.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			f.mu.Lock()
			out := copyFound(f.found)
			f.mu.Unlock()
			return out
		}
		f.mu.Lock()
	}
	if !fresh && f.found != nil {
		known := true
		for _, c := range extra {
			if _, ok := f.found[c]; !ok {
				known = false
			}
		}
		if known {
			out := copyFound(f.found)
			f.mu.Unlock()
			return out
		}
	}
	ch := make(chan struct{})
	f.busy = ch
	names := append([]string(nil), Commands...)
	for c := range f.found {
		names = append(names, c)
	}
	f.mu.Unlock()
	names = uniq(append(names, extra...))

	res, st := f.lookup(ctx, names)

	f.mu.Lock()
	f.found, f.at = res, time.Now()
	f.shellOK, f.shellErr, f.shellRan = st.OK, st.Error, st.Took
	f.busy = nil
	out := copyFound(f.found)
	f.mu.Unlock()
	close(ch)
	return out
}

// Forget drops what was found, so the next Find looks again.
func (f *Finder) Forget() {
	f.mu.Lock()
	f.found = nil
	f.mu.Unlock()
}

// All is what was found of Commands, in their order, looking first if
// nothing has been.
func (f *Finder) All() []Found {
	f.mu.Lock()
	empty := f.found == nil
	f.mu.Unlock()
	if empty {
		f.Refresh(context.Background())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Found
	for _, c := range Commands {
		if r := f.found[c]; r.Path != "" {
			out = append(out, r)
		}
	}
	return out
}

func copyFound(m map[string]Found) map[string]Found {
	out := make(map[string]Found, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func uniq(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s != "" && !seen[s] && safeName.MatchString(s) {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// SafeName reports whether s is a plain program name, the only kind looked
// for.
func SafeName(s string) bool { return safeName.MatchString(s) }

// safeName is what a command may be: a plain program name.
var safeName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._+-]*$`)

// lookup finds names: the shell first, then berthd's PATH and the folders.
func (f *Finder) lookup(ctx context.Context, names []string) (map[string]Found, Status) {
	st := Status{Shell: f.Shell}
	shell := ShellAnswer{}
	if f.Shell != "" {
		t0 := time.Now()
		var err error
		shell, err = AskShell(ctx, f.Shell, append(names, "npm", "node"), f.env(), f.timeout())
		st.Took = time.Since(t0)
		if err != nil {
			st.Error = err.Error()
		} else {
			st.OK = true
		}
	}
	basePATH := envValue(f.env(), "PATH")
	launchBase := basePATH
	if shell.PATH != "" {
		launchBase = joinPATH(shell.PATH, basePATH)
	}
	out := map[string]Found{}
	var dirs []string
	dirsDone := false
	for _, name := range names {
		if p := shell.Commands[name]; p != "" {
			out[name] = f.describe(name, p, "shell", launchBase)
			continue
		}
		if p, err := f.lookPath(name); err == nil && filepath.IsAbs(p) {
			out[name] = f.describe(name, p, "path", launchBase)
			continue
		}
		if !dirsDone {
			dirs, dirsDone = f.Dirs(ctx, shell), true
		}
		found := false
		for _, d := range append(agentDirs(f.home(), name), dirs...) {
			p := filepath.Join(d, name)
			if executable(p) {
				out[name] = f.describe(name, p, "dir", launchBase)
				found = true
				break
			}
		}
		if !found {
			out[name] = Found{Command: name}
		}
	}
	// Versions run in parallel: node takes a moment to start.
	if !f.NoVersion {
		// The map is only read while they run and written after, as
		// ranging over it while a goroutine writes to it is a race.
		var todo []string
		for name, r := range out {
			if r.Path != "" && name != "npm" && name != "node" {
				todo = append(todo, name)
			}
		}
		versions := make([]string, len(todo))
		var wg sync.WaitGroup
		for i, name := range todo {
			wg.Add(1)
			go func(i int, r Found) {
				defer wg.Done()
				versions[i] = f.version(ctx, r)
			}(i, out[name])
		}
		wg.Wait()
		for i, name := range todo {
			r := out[name]
			r.Version = versions[i]
			out[name] = r
		}
	}
	return out, st
}

// describe is a Found for path, with how it was installed and its PATH.
func (f *Finder) describe(name, path, via, base string) Found {
	dir := filepath.Dir(path)
	return Found{Command: name, Path: path, Via: via, Install: installKind(f.home(), path), PATH: joinPATH(dir, base)}
}

// agentDirs are where an agent's own installer puts it, outside the
// common folders.
func agentDirs(home, name string) []string {
	switch name {
	case "claude":
		return []string{filepath.Join(home, ".claude", "local")}
	case "opencode":
		return []string{filepath.Join(home, ".opencode", "bin")}
	case "grok":
		return []string{filepath.Join(home, ".grok", "bin")}
	}
	return nil
}

// Dirs are the folders agents are installed to, in the order they are
// looked in after the shell and berthd's PATH: Shipyard's own (~/.local/bin),
// npm's global prefix, nvm's default and then its other Node versions,
// fnm's likewise, volta, bun, pnpm, ~/.npm-global, then Homebrew and the
// system's.
func (f *Finder) Dirs(ctx context.Context, shell ShellAnswer) []string {
	home := f.home()
	env := f.env()
	var dirs []string
	add := func(d ...string) { dirs = append(dirs, d...) }
	add(filepath.Join(home, ".local", "bin"))
	if p := f.npmPrefix(ctx, shell); p != "" {
		add(filepath.Join(p, "bin"))
	}
	add(nvmDirs(home, envValue(env, "NVM_DIR"))...)
	add(fnmDirs(home, envValue(env, "FNM_DIR"), envValue(env, "XDG_DATA_HOME"))...)
	volta := envValue(env, "VOLTA_HOME")
	if volta == "" {
		volta = filepath.Join(home, ".volta")
	}
	add(filepath.Join(volta, "bin"))
	bun := envValue(env, "BUN_INSTALL")
	if bun == "" {
		bun = filepath.Join(home, ".bun")
	}
	add(filepath.Join(bun, "bin"))
	if p := envValue(env, "PNPM_HOME"); p != "" {
		add(p)
	}
	if runtime.GOOS == "darwin" {
		add(filepath.Join(home, "Library", "pnpm"))
	} else {
		add(filepath.Join(home, ".local", "share", "pnpm"))
	}
	add(filepath.Join(home, ".npm-global", "bin"), filepath.Join(home, ".npm-packages", "bin"), filepath.Join(home, ".linuxbrew", "bin"))
	sys := f.SystemDirs
	if sys == nil {
		sys = []string{"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/bin", "/snap/bin"}
	}
	add(sys...)
	return dirs
}

// npmPrefix is `npm prefix -g`, from the npm the shell has, else one in
// nvm's or fnm's default Node, else berthd's.
func (f *Finder) npmPrefix(ctx context.Context, shell ShellAnswer) string {
	if f.NoNPM {
		return ""
	}
	npm := shell.Commands["npm"]
	pathEnv := shell.PATH
	if npm == "" {
		var dirs []string
		if nvm := nvmDirs(f.home(), envValue(f.env(), "NVM_DIR")); len(nvm) > 0 {
			dirs = append(dirs, nvm[0])
		}
		if fnm := fnmDirs(f.home(), envValue(f.env(), "FNM_DIR"), envValue(f.env(), "XDG_DATA_HOME")); len(fnm) > 0 {
			dirs = append(dirs, fnm[0])
		}
		for _, d := range dirs {
			if executable(filepath.Join(d, "npm")) {
				npm = filepath.Join(d, "npm")
				break
			}
		}
	}
	if npm == "" {
		if p, err := f.lookPath("npm"); err == nil {
			npm = p
		}
	}
	if npm == "" {
		return ""
	}
	if pathEnv == "" {
		pathEnv = envValue(f.env(), "PATH")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, npm, "prefix", "-g")
	cmd.Env = setEnv(f.env(), "PATH", joinPATH(filepath.Dir(npm), pathEnv))
	cmd.Stdin = nil
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	p := strings.TrimSpace(lastLine(string(out)))
	if !filepath.IsAbs(p) {
		return ""
	}
	return p
}

// nvmDirs are nvm's Node versions' bin folders: its default alias first,
// then the rest, newest first.
func nvmDirs(home, nvmDir string) []string {
	if nvmDir == "" {
		nvmDir = filepath.Join(home, ".nvm")
	}
	root := filepath.Join(nvmDir, "versions", "node")
	versions := versionDirs(root)
	if len(versions) == 0 {
		return nil
	}
	var out []string
	if v := nvmDefault(nvmDir, versions); v != "" {
		out = append(out, filepath.Join(root, v, "bin"))
	}
	for _, v := range versions {
		d := filepath.Join(root, v, "bin")
		if len(out) == 0 || out[0] != d {
			out = append(out, d)
		}
	}
	return out
}

// nvmDefault resolves nvm's default alias ("22", "lts/*", "node", "v20.11.0",
// or another alias) to one of versions (newest first).
func nvmDefault(nvmDir string, versions []string) string {
	b, err := os.ReadFile(filepath.Join(nvmDir, "alias", "default"))
	if err != nil {
		return ""
	}
	alias := strings.TrimSpace(string(b))
	for i := 0; i < 8; i++ {
		switch {
		case alias == "node" || alias == "stable":
			return versions[0]
		case strings.HasPrefix(alias, "lts/") || !looksLikeVersion(alias):
			b, err := os.ReadFile(filepath.Join(nvmDir, "alias", filepath.FromSlash(alias)))
			if err != nil {
				return ""
			}
			alias = strings.TrimSpace(string(b))
			continue
		}
		want := strings.TrimPrefix(alias, "v")
		for _, v := range versions {
			got := strings.TrimPrefix(v, "v")
			if got == want || strings.HasPrefix(got, want+".") {
				return v
			}
		}
		return ""
	}
	return ""
}

func looksLikeVersion(s string) bool {
	s = strings.TrimPrefix(s, "v")
	return s != "" && s[0] >= '0' && s[0] <= '9'
}

// fnmDirs are fnm's Node versions' bin folders: its default alias first,
// then the rest, newest first.
func fnmDirs(home, fnmDir, xdgData string) []string {
	var roots []string
	if fnmDir != "" {
		roots = append(roots, fnmDir)
	}
	if xdgData != "" {
		roots = append(roots, filepath.Join(xdgData, "fnm"))
	}
	roots = append(roots, filepath.Join(home, ".local", "share", "fnm"), filepath.Join(home, ".fnm"))
	if runtime.GOOS == "darwin" {
		roots = append(roots, filepath.Join(home, "Library", "Application Support", "fnm"))
	}
	var out []string
	for _, root := range roots {
		if def := filepath.Join(root, "aliases", "default", "bin"); isDir(def) {
			out = append(out, def)
		}
		base := filepath.Join(root, "node-versions")
		for _, v := range versionDirs(base) {
			out = append(out, filepath.Join(base, v, "installation", "bin"))
		}
	}
	return out
}

// versionDirs are the vX.Y.Z folders in dir, newest first.
func versionDirs(dir string) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if looksLikeVersion(e.Name()) {
			out = append(out, e.Name())
		}
	}
	sort.Slice(out, func(i, j int) bool { return versionLess(out[j], out[i]) })
	return out
}

// versionLess compares vX.Y.Z by number.
func versionLess(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return a < b
}

func versionParts(v string) [3]int {
	var out [3]int
	for i, p := range strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3) {
		n := 0
		for _, c := range p {
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
		}
		out[i] = n
	}
	return out
}

// installKind says how path was installed, from where it is and what it
// links to.
func installKind(home, path string) string {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		real = path
	}
	for _, p := range []string{path, real} {
		switch {
		case strings.Contains(p, "/.volta/"):
			return "volta"
		case strings.Contains(p, "/.bun/"):
			return "bun"
		case strings.Contains(p, "/pnpm/") || strings.Contains(p, "/.pnpm/"):
			return "pnpm"
		}
	}
	switch {
	case strings.Contains(real, "/node_modules/"), strings.Contains(path, "/.nvm/"), strings.Contains(path, "/fnm/"), strings.Contains(path, "/.npm-global/"):
		return "npm"
	case strings.Contains(real, "/Cellar/"), strings.Contains(real, "/Caskroom/"):
		return "Homebrew"
	}
	return ""
}

// version is the first line `path --version` prints, kept while the file
// is unchanged.
func (f *Finder) version(ctx context.Context, r Found) string {
	real, err := filepath.EvalSymlinks(r.Path)
	if err != nil {
		real = r.Path
	}
	info, err := os.Stat(real)
	if err != nil {
		return ""
	}
	f.mu.Lock()
	if e, ok := f.versions[real]; ok && e.mod.Equal(info.ModTime()) {
		f.mu.Unlock()
		return e.version
	}
	f.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Path, "--version")
	cmd.Env = setEnv(f.env(), "PATH", r.PATH)
	cmd.Dir = f.home()
	cmd.WaitDelay = time.Second
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out, _ := cmd.Output()
	v := ""
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" {
			v = l
			break
		}
	}
	if len(v) > 80 {
		v = v[:80]
	}
	f.mu.Lock()
	if f.versions == nil {
		f.versions = map[string]versionEntry{}
	}
	f.versions[real] = versionEntry{mod: info.ModTime(), version: v}
	f.mu.Unlock()
	return v
}

// Describe is a Found in one line: "Claude Code 2.1.3 · ~/.nvm/…/claude (npm)".
func Describe(r Found, home string) string {
	var b strings.Builder
	if r.Version != "" {
		b.WriteString(r.Version)
		b.WriteString(" · ")
	}
	b.WriteString(Tilde(r.Path, home))
	if r.Install != "" {
		b.WriteString(" (" + r.Install + ")")
	}
	return b.String()
}

// Tilde writes home as ~.
func Tilde(p, home string) string {
	if home != "" && (p == home || strings.HasPrefix(p, home+string(filepath.Separator))) {
		return "~" + p[len(home):]
	}
	return p
}

// ——— the shell ———

// ShellAnswer is what the person's shell said: each command's path ("" when
// it has none) and its PATH.
type ShellAnswer struct {
	Commands map[string]string
	PATH     string
}

const (
	markPATH = "__BERTH_AGENT_PATH__"
	markCmd  = "__BERTH_AGENT_CMD__"
)

// posixScript prints PATH and each command's path between markers. An alias
// or a function of the same name is dropped first, so only a program counts.
const posixScript = `printf '\n` + markPATH + `%s` + markPATH + `\n' "$PATH"
for n in "$@"; do
  unalias "$n" >/dev/null 2>&1
  unset -f "$n" >/dev/null 2>&1
  p=$(command -v "$n" 2>/dev/null)
  printf '` + markCmd + `%s=%s` + markCmd + `\n' "$n" "$p"
done`

const fishScript = `printf '\n` + markPATH + `%s` + markPATH + `\n' (string join : $PATH)
for n in $argv
  set -l p (command -v $n 2>/dev/null)
  printf '` + markCmd + `%s=%s` + markCmd + `\n' $n "$p"
end`

// posixShells take `-lic SCRIPT ARG0 ARGS…`.
var posixShells = map[string]bool{"bash": true, "zsh": true, "sh": true, "dash": true, "ksh": true, "mksh": true, "yash": true}

// AskShell asks shell, interactive and login as a terminal starts it, where
// each of names is and what its PATH is. It runs in a session of its own
// with no terminal and nothing on stdin, so an rc file can neither take a
// terminal over nor wait for an answer, and is killed (with whatever it
// started) after timeout.
func AskShell(ctx context.Context, shell string, names []string, env []string, timeout time.Duration) (ShellAnswer, error) {
	base := filepath.Base(shell)
	var args []string
	switch {
	case base == "fish":
		args = append([]string{"-l", "-i", "-c", fishScript}, names...)
	case posixShells[base]:
		args = append([]string{"-l", "-i", "-c", posixScript, "berth"}, names...)
	default:
		return ShellAnswer{}, fmt.Errorf("%s is not a shell Shipyard knows how to ask", base)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Env = env
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Cancel = func() error {
		// The shell and anything its rc files started.
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = time.Second
	var stdout bytes.Buffer
	cmd.Stdout = &limitWriter{w: &stdout, n: 1 << 20}
	err := cmd.Run()
	ans := ParseShell(stdout.Bytes())
	if ans.PATH == "" && len(ans.Commands) == 0 {
		if ctx.Err() != nil {
			return ans, fmt.Errorf("%s did not answer within %s", base, timeout)
		}
		if err != nil {
			return ans, fmt.Errorf("%s: %v", base, err)
		}
		return ans, fmt.Errorf("%s printed no answer", base)
	}
	return ans, nil
}

var cmdLine = regexp.MustCompile(markCmd + `([^=\n]+)=([^\n]*?)` + markCmd)

// ParseShell reads what the scripts print, past anything else the shell's
// startup files print around it. A command's path counts only when it is
// absolute and executable.
func ParseShell(out []byte) ShellAnswer {
	ans := ShellAnswer{Commands: map[string]string{}}
	if i := bytes.Index(out, []byte(markPATH)); i >= 0 {
		rest := out[i+len(markPATH):]
		if j := bytes.Index(rest, []byte(markPATH)); j >= 0 {
			ans.PATH = string(rest[:j])
		}
	}
	for _, m := range cmdLine.FindAllSubmatch(out, -1) {
		name, p := string(m[1]), strings.TrimSpace(string(m[2]))
		if p != "" && filepath.IsAbs(p) && executable(p) {
			ans.Commands[name] = p
		} else if _, ok := ans.Commands[name]; !ok {
			ans.Commands[name] = ""
		}
	}
	return ans
}

type limitWriter struct {
	w interface{ Write([]byte) (int, error) }
	n int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	q := p
	if len(q) > l.n {
		q = q[:l.n]
	}
	l.n -= len(q)
	l.w.Write(q)
	return len(p), nil
}

// ——— small helpers ———

func executable(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

func isDir(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if v, ok := strings.CutPrefix(env[i], key+"="); ok {
			return v
		}
	}
	return ""
}

func setEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, key+"=") {
			out = append(out, kv)
		}
	}
	return append(out, key+"="+value)
}

// joinPATH joins PATH lists, each folder once, dropping empty and relative
// ones.
func joinPATH(lists ...string) string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, d := range filepath.SplitList(l) {
			if d == "" || !filepath.IsAbs(d) {
				continue
			}
			d = filepath.Clean(d)
			if !seen[d] {
				seen[d] = true
				out = append(out, d)
			}
		}
	}
	return strings.Join(out, string(os.PathListSeparator))
}

// JoinPATH is joinPATH for callers: each folder once, in order.
func JoinPATH(lists ...string) string { return joinPATH(lists...) }

// userShell is the user's login shell: $SHELL, else the account's.
func userShell() string {
	if s := os.Getenv("SHELL"); filepath.IsAbs(s) {
		return s
	}
	if runtime.GOOS == "darwin" {
		if u := os.Getenv("USER"); u != "" {
			out, err := exec.Command("dscl", ".", "-read", "/Users/"+u, "UserShell").Output()
			if err == nil {
				if f := strings.Fields(string(out)); len(f) == 2 && filepath.IsAbs(f[1]) {
					return f[1]
				}
			}
		}
		return "/bin/zsh"
	}
	if b, err := os.ReadFile("/etc/passwd"); err == nil {
		uid := strconv.Itoa(os.Getuid())
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Split(line, ":")
			if len(f) >= 7 && f[2] == uid && filepath.IsAbs(f[6]) {
				return f[6]
			}
		}
	}
	return "/bin/sh"
}
