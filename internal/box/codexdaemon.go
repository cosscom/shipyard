package box

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Codex runs every session's hooks from one shared app-server daemon when
// it can, and the daemon has the environment of whichever session started
// it: its BERTH_SESSION, so every Codex session's hooks would report as
// that one (cosscom/shipyard#8). An interactive Codex that berthd starts
// gets --no-daemon, which keeps it off a daemon even one that is already
// running, when this box's Codex knows the flag.

// codexCommand is p's command for an interactive Codex, with --no-daemon
// when this box's Codex takes it; any other agent's command as it is.
func codexCommand(p AgentPreset) string {
	if p.ID != "codex" || strings.Contains(p.Command, "--no-daemon") || !codexNoDaemon(p.Command) {
		return p.Command
	}
	return p.Command + " --no-daemon"
}

// codexNoDaemon says whether command runs a Codex that takes --no-daemon:
// its --help says so, read once per binary. A test sets it.
var codexNoDaemon = func(command string) bool {
	words := strings.Fields(command)
	if len(words) == 0 || filepath.Base(words[0]) != "codex" {
		return false
	}
	f, ok := agentFound(words[0])
	if !ok {
		return false
	}
	st, err := os.Stat(f.Path)
	if err != nil {
		return false
	}
	key := f.Path + "\x00" + st.ModTime().String()
	codexHelp.Lock()
	defer codexHelp.Unlock()
	if v, ok := codexHelp.seen[key]; ok {
		return v
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, f.Path, "--help").CombinedOutput()
	v := bytes.Contains(out, []byte("--no-daemon"))
	if codexHelp.seen == nil {
		codexHelp.seen = map[string]bool{}
	}
	codexHelp.seen[key] = v
	return v
}

var codexHelp struct {
	sync.Mutex
	seen map[string]bool
}
