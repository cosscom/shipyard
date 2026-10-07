package box

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/doctor"
)

// tmuxDirs are searched for tmux after PATH. berthd started by the app or
// launchd on a Mac inherits a minimal PATH without Homebrew's, so a tmux
// installed there would otherwise look missing; and the guided install puts
// Shipyard's own tmux in ~/.local/bin when a box has none, which a service's
// PATH may lack. A variable so tests can point it elsewhere.
var tmuxDirs = append([]string{"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"}, localBin()...)

func localBin() []string {
	if home, err := os.UserHomeDir(); err == nil {
		return []string{filepath.Join(home, ".local", "bin")}
	}
	return nil
}

// tmuxFound caches where tmux was found. Only a find is kept, so a box
// that lacked tmux finds it once it is installed, without a restart.
var tmuxFound struct {
	sync.Mutex
	path string
}

// tmuxPath is the tmux every call to berth's tmux server runs, or
// errTmuxMissing.
func tmuxPath() (string, error) {
	tmuxFound.Lock()
	defer tmuxFound.Unlock()
	if tmuxFound.path != "" {
		if info, err := os.Stat(tmuxFound.path); err == nil && !info.IsDir() {
			return tmuxFound.path, nil
		}
		tmuxFound.path = ""
	}
	p, err := findTmux()
	if err != nil {
		return "", err
	}
	tmuxFound.path = p
	return p, nil
}

func findTmux() (string, error) {
	if p, err := exec.LookPath("tmux"); err == nil {
		return p, nil
	}
	for _, dir := range tmuxDirs {
		p := filepath.Join(dir, "tmux")
		if info, err := os.Stat(p); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", errTmuxMissing
}

// resetTmuxPath forgets where tmux was found, for tests.
func resetTmuxPath() {
	tmuxFound.Lock()
	tmuxFound.path = ""
	tmuxFound.Unlock()
}

// tmuxTimeout bounds one tmux command.
var tmuxTimeout = 15 * time.Second

// tmuxCommand is a command to berth's tmux server, with its own deadline.
// The cancel func must be called once it has run.
//
// -u: launchd starts berthd with no locale (and systemd may), and a tmux
// client that doesn't think it speaks UTF-8 prints formats with every tab
// and non-ASCII character as "_" (tmux 3.7 does). berthd reads its
// sessions back as tab-separated fields, so no session could start.
func (s *Sessions) tmuxCommand(ctx context.Context, args ...string) (*exec.Cmd, context.Context, context.CancelFunc, error) {
	bin, err := tmuxPath()
	if err != nil {
		return nil, nil, nil, err
	}
	if s.trace != nil {
		s.trace(args)
	}
	cctx, cancel := context.WithTimeout(ctx, tmuxTimeout)
	return exec.CommandContext(cctx, bin, append([]string{"-u", "-L", tmuxSocket, "-f", s.Config}, args...)...), cctx, cancel, nil
}

// runTmux runs cmd and says why it failed in words: its exit status, that
// it timed out, or that it could not run at all.
func runTmux(ctx, cctx context.Context, cmd *exec.Cmd) ([]byte, error) {
	out, err := cmd.CombinedOutput()
	if err == nil {
		return out, nil
	}
	if ctx.Err() == nil && errors.Is(cctx.Err(), context.DeadlineExceeded) {
		return out, fmt.Errorf("timed out after %s", tmuxTimeout)
	}
	if ctx.Err() != nil {
		return out, ctx.Err()
	}
	return out, err
}

// tmuxError is a failed tmux command, with tmux's own words when it said
// any and always why it failed, so no one sees an empty reason.
func tmuxError(cmd string, out []byte, err error) error {
	if errors.Is(err, errTmuxMissing) {
		return err
	}
	msg := strings.TrimSpace(string(out))
	if err == nil {
		err = errors.New("failed")
	}
	if msg == "" {
		return fmt.Errorf("tmux %s: %w", cmd, err)
	}
	return fmt.Errorf("tmux %s: %w: %s", cmd, err, msg)
}

// Requirements says what this box needs to run agents and what it has,
// so the app can say what to install before it starts one.
type Requirements struct {
	OS     string             `json:"os"`
	Tmux   ToolRequirement    `json:"tmux"`
	Agents []AgentRequirement `json:"agents"`
}

type ToolRequirement struct {
	Found bool   `json:"found"`
	Path  string `json:"path,omitempty"`
	// Install is the command that installs it here, to type for the
	// user; Manager the package manager it uses. ManagerMissing says the
	// usual one (Homebrew, on a Mac) isn't there, and Help where to get it.
	Install        string `json:"install,omitempty"`
	Manager        string `json:"manager,omitempty"`
	ManagerMissing bool   `json:"manager_missing,omitempty"`
	Help           string `json:"help,omitempty"`
}

type AgentRequirement struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
	Found   bool   `json:"found"`
	Path    string `json:"path,omitempty"`
	Install string `json:"install,omitempty"`
}

// agentInstalls are the built-in agents' install commands.
var agentInstalls = map[string]string{
	"claude":   "npm install -g @anthropic-ai/claude-code",
	"codex":    "npm install -g @openai/codex",
	"opencode": "npm install -g opencode-ai",
	"gemini":   "npm install -g @google/gemini-cli",
	"cursor":   "curl https://cursor.com/install -fsS | bash",
	"grok":     "curl -fsSL https://x.ai/cli/install.sh | bash",
}

// tmuxRequirement is whether tmux is here and, when it isn't, how to get it.
func tmuxRequirement() ToolRequirement {
	if p, err := tmuxPath(); err == nil {
		return ToolRequirement{Found: true, Path: p}
	}
	return tmuxInstall(runtime.GOOS, haveTool)
}

func haveTool(name string) bool {
	if _, err := exec.LookPath(name); err == nil {
		return true
	}
	for _, dir := range tmuxDirs {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

// tmuxInstall is how to install tmux on goos, with have saying which
// package managers there are.
func tmuxInstall(goos string, have func(string) bool) ToolRequirement {
	if goos == "darwin" {
		if have("brew") {
			return ToolRequirement{Install: "brew install tmux", Manager: "brew"}
		}
		// Homebrew first (Help), then this.
		return ToolRequirement{Install: "brew install tmux", Manager: "brew", ManagerMissing: true, Help: "https://brew.sh"}
	}
	for _, m := range []struct{ bin, cmd string }{
		{"apt-get", "sudo apt install tmux"},
		{"dnf", "sudo dnf install tmux"},
		{"yum", "sudo yum install tmux"},
		{"pacman", "sudo pacman -S tmux"},
		{"zypper", "sudo zypper install tmux"},
		{"apk", "sudo apk add tmux"},
		{"brew", "brew install tmux"},
	} {
		if have(m.bin) {
			return ToolRequirement{Install: m.cmd, Manager: strings.TrimSuffix(m.bin, "-get")}
		}
	}
	return ToolRequirement{Help: "https://github.com/tmux/tmux/wiki/Installing"}
}

// tmuxInstallHint is one line saying how to install tmux here, for doctor.
func tmuxInstallHint() string {
	r := tmuxInstall(runtime.GOOS, haveTool)
	switch {
	case r.ManagerMissing:
		return "Install Homebrew (" + r.Help + "), then: " + r.Install
	case r.Install != "":
		return r.Install
	}
	return "Install tmux with your package manager: " + r.Help
}

// TmuxPath is the tmux berth runs, found as every box call finds it.
func TmuxPath() (string, error) { return tmuxPath() }

// TmuxCheck is doctor's report on tmux, with how to install it here.
func TmuxCheck() doctor.Check {
	if p, err := tmuxPath(); err == nil {
		return doctor.Check{Area: "Worktrees and sessions", Name: "tmux", Status: doctor.OK, Detail: p}
	}
	return doctor.Check{Area: "Worktrees and sessions", Name: "tmux", Status: doctor.Fail,
		Detail: "not installed (or not on berthd's PATH, nor in " + strings.Join(tmuxDirs, ", ") + "); Shipyard runs every agent in tmux", Fix: tmuxInstallHint()}
}

// requirements answers GET /v1/requirements: what this box needs to run
// agents, which of it is here, and how to install the rest.
func (b *Box) requirements(w http.ResponseWriter, r *http.Request) error {
	req := Requirements{OS: runtime.GOOS, Tmux: tmuxRequirement(), Agents: []AgentRequirement{}}
	for _, p := range builtinAgents {
		a := AgentRequirement{ID: p.ID, Name: p.Name, Command: p.Command, Install: agentInstalls[p.ID]}
		if f, ok := agentFound(p.Command); ok {
			a.Found, a.Path, a.Install = true, f.Path, ""
		} else if path, ok := doctor.Tool(p.Command); ok {
			a.Found, a.Path, a.Install = true, path, ""
		}
		req.Agents = append(req.Agents, a)
	}
	writeJSON(w, req)
	return nil
}
