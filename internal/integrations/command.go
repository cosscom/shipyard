package integrations

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/events"
)

const Usage = `Integrations
  %[1]s integrations [status]
                         Where Shipyard's hooks and skills are, per agent
                         and per Claude Code or Codex account
  %[1]s integrations install claude|cursor|codex|gemini|opencode|grok|all|present
                         Install Shipyard's skills and agent hooks for a
                         tool, in every account folder it has
  %[1]s hook TOOL EVENT [PAYLOAD]
                         What those hooks run: turns a tool's hook into a
                         berth event (agent.finished, agent.waiting)
`

// Emit publishes an event on this machine's berth: the laptop agent or the
// box daemon, whichever the running binary talks to.
type Emit func(events.Event) error

// Hook handles `hook TOOL EVENT [PAYLOAD]`. It never fails the calling tool:
// problems are reported on stderr and the tool's expected reply is printed.
func Hook(args []string, stdin *os.File, stdout, stderr io.Writer, emit Emit) {
	if len(args) < 2 {
		fmt.Fprintln(stderr, "usage: hook TOOL EVENT [PAYLOAD]")
		return
	}
	tool, event := args[0], args[1]
	defer fmt.Fprint(stdout, Reply(tool))
	var payload []byte
	if len(args) >= 3 {
		payload = []byte(args[2])
	} else if info, err := stdin.Stat(); err == nil && info.Mode()&os.ModeCharDevice == 0 {
		// Read stdin only when something is piped in: a terminal would block.
		payload, _ = io.ReadAll(io.LimitReader(stdin, 1<<20))
	}
	e, ok := Translate(tool, event, payload)
	if !ok {
		return
	}
	// The berth session the agent runs in, so the box knows which of the
	// agents in a worktree this is.
	if name := berthSession(); name != "" {
		e.Data["session"] = name
	}
	// Stamped now: a hook spooled while berthd is down keeps its time.
	e.Time = time.Now().UTC()
	if err := emit(e); err != nil {
		fmt.Fprintf(stderr, "berth hook: %v\n", err)
	}
}

// Install handles `integrations install TOOL...` for the binary at bin.
func Install(args []string, bin string, out io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if len(args) == 0 || (len(args) == 1 && args[0] == "status") {
		Status(home, filepath.Base(bin), out)
		return nil
	}
	if len(args) < 2 || args[0] != "install" {
		return errors.New("usage: integrations [status] | integrations install claude|cursor|codex|gemini|opencode|grok|all|present")
	}
	tools := args[1:]
	if len(tools) == 1 && tools[0] == "all" {
		tools = AllTools
	}
	// present: every agent CLI on this machine, saying nothing of the
	// others (the guided install runs this after installing the agents
	// the person chose).
	if len(tools) == 1 && tools[0] == "present" {
		return InstallPresent(home, bin, out)
	}
	for _, tool := range tools {
		if err := InstallTool(home, tool, bin, out); err != nil {
			return err
		}
	}
	return nil
}

// InstallTool installs Shipyard's skills and hooks for one tool in home, for
// the binary at bin, and says what it did on out: for Claude Code and Codex,
// in every account folder (accounts.go). Running it again changes nothing
// that is already in place.
func InstallTool(home, tool, bin string, out io.Writer) error {
	switch tool {
	case "claude", "codex":
		// Every account folder: the default and each other login (accounts.go).
		return installAccounts(home, tool, bin, out)
	case "cursor":
		hooks := filepath.Join(home, ".cursor", "hooks.json")
		changed, err := InstallCursorHooks(hooks, bin)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Cursor: hooks %s in %s (existing hooks kept)\n", verb(changed), hooks)
	case "gemini":
		settings := filepath.Join(home, ".gemini", "settings.json")
		changed, err := InstallGeminiHooks(settings, bin)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Gemini CLI: hooks %s in %s\n", verb(changed), settings)
		if mcpBin(bin) {
			changed, err := InstallMCP(settings, bin, false)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "Gemini CLI: MCP server %s in %s\n", verb(changed), settings)
		}
	case "opencode":
		plugin := filepath.Join(home, ".config", "opencode", "plugin", "berth.js")
		changed, err := InstallOpenCodePlugin(plugin, bin)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "OpenCode: plugin %s at %s\n", verb(changed), plugin)
	case "grok":
		hooks := filepath.Join(home, ".grok", "hooks", "berth.json")
		changed, err := InstallGrokHooks(hooks, bin)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Grok CLI: hooks %s in %s\n", verb(changed), hooks)
	default:
		return fmt.Errorf("unknown tool %q; use claude, cursor, codex, gemini, opencode, grok, all, or present", tool)
	}
	return nil
}

// Status says, for each agent CLI on this machine, where Shipyard's hooks
// and skills are: for Claude Code and Codex, per account folder. command
// is how to run this binary, for the fix.
func Status(home, command string, out io.Writer) {
	for _, t := range Tools {
		if !t.Present(home) {
			fmt.Fprintf(out, "%s: not found\n", t.Name)
			continue
		}
		if _, ok := AccountVars[t.ID]; ok {
			summary, missing, outdated := AccountSummary(home, t.ID)
			fmt.Fprintf(out, "%s: %s\n", t.Name, summary)
			if len(outdated) > 0 {
				fmt.Fprintf(out, "  from an older berth in %s\n", strings.Join(outdated, ", "))
			}
			if len(missing) > 0 || len(outdated) > 0 {
				fmt.Fprintf(out, "  To fix: %s integrations install %s\n", command, t.ID)
			}
			continue
		}
		switch {
		case !t.Hooked(home):
			fmt.Fprintf(out, "%s: no hooks. To fix: %s integrations install %s\n", t.Name, command, t.ID)
		case !t.Current(home):
			fmt.Fprintf(out, "%s: hooks from an older berth in ~/%s. To fix: %s integrations install %s\n", t.Name, filepath.ToSlash(t.hookFile), command, t.ID)
		default:
			fmt.Fprintf(out, "%s: hooks in ~/%s\n", t.Name, filepath.ToSlash(t.hookFile))
		}
	}
}

// installAllSkills installs every skill berth ships for agent in home and
// returns the folder they went to.
func installAllSkills(home, agent string) (string, error) {
	names, _ := SkillNames(nil)
	if _, err := InstallSkills(home, agent, names); err != nil {
		return "", err
	}
	return SkillDir(home, agent)
}

func verb(changed bool) string {
	if changed {
		return "added"
	}
	return "already present"
}

// AllTools are the agents `integrations install all` covers.
var AllTools = []string{"claude", "cursor", "codex", "gemini", "opencode", "grok"}

var validSession = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)

// berthSession is the berth session this hook runs in: $BERTH_SESSION,
// which berth sets in every session it starts, or, for sessions started
// before it did, the tmux session when the pane is on berth's own server.
func berthSession() string {
	if s := os.Getenv("BERTH_SESSION"); validSession.MatchString(s) {
		return s
	}
	tmux, pane := os.Getenv("TMUX"), os.Getenv("TMUX_PANE")
	sock, _, _ := strings.Cut(tmux, ",")
	if sock == "" || pane == "" || filepath.Base(sock) != "berth" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-S", sock, "display-message", "-p", "-t", pane, "#S").Output()
	if s := strings.TrimSpace(string(out)); err == nil && validSession.MatchString(s) {
		return s
	}
	return ""
}
