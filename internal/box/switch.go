package box

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/groups"
)

// Switching a structured Claude session between its chat and Claude Code's
// own terminal, and back (POST /v1/sessions/{name}/switch, "driver.switch"
// capability). It is one conversation throughout, and one process at a
// time:
//
//   - To the terminal: the host stops Claude (it ends at its stdin's end),
//     and the pane runs `claude --resume <its session>` (--session-id
//     before its first prompt, when Claude has saved nothing yet): the
//     full TUI, for what only it does (/login, /resume, /memory, its own
//     screen).
//   - Back to the chat: the TUI is told /exit, what was said in it is copied
//     from Claude Code's transcript into berthd's log, and the host starts
//     again with --resume.
//
// The session keeps its log folder and socket throughout (@berth_conv,
// @berth_sock): a session in its terminal with a log is one that can go
// back (Session.Switch "chat").

// labelHandoff is where Claude Code's transcript stood when the session
// went to its terminal: its size, a space, then the file. What it says past
// that was said in the terminal. (Printable only: tmux on Linux shows a
// control character in an option escaped.)
const labelHandoff = "@berth_handoff"

// SwitchRequest moves a session to its terminal or back to its chat.
type SwitchRequest struct {
	To string `json:"to"`
}

func (b *Box) switchSession(w http.ResponseWriter, r *http.Request) error {
	var req SwitchRequest
	if err := decode(r, &req); err != nil {
		return err
	}
	name := r.PathValue("name")
	sess, err := b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	switch req.To {
	case "terminal", "chat":
	default:
		return badRequest("switch to terminal or chat")
	}
	// Claude Code's terminal may have been left (/exit, or "No, exit" at
	// its trust question): its chat still takes it back.
	if sess.Exited && !(req.To == "chat" && sess.Driver == "" && sess.conv != "") {
		return ErrSessionExited
	}
	if b.Turns != nil {
		if st, ok := b.Turns.State(name); ok && (st.State == "running" || st.State == "waiting") {
			return httpError{http.StatusConflict, "the agent is " + st.State + ": stop it or let it finish first"}
		}
	}
	if err := b.before(r, "session.switch", map[string]any{"name": name, "to": req.To}); err != nil {
		return err
	}
	switch {
	case req.To == "terminal" && sess.Driver == DriverClaude:
		err = b.toTerminal(r, sess)
	case req.To == "chat" && sess.Driver == "" && sess.conv != "":
		err = b.toChat(r, sess)
	case req.To == "terminal":
		return httpError{http.StatusConflict, name + " is already in its terminal"}
	default:
		return httpError{http.StatusConflict, name + " has no chat to go back to: only a structured session's terminal does"}
	}
	if err != nil {
		return err
	}
	b.publish(r, "session.switched", map[string]any{"name": name, "to": req.To})
	sess, err = b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	writeJSON(w, b.enrich(r.Context(), []Session{sess})[0])
	return nil
}

// claudePreset is the Claude Code preset a session's location runs.
func (b *Box) claudePreset(ctx context.Context, sess Session) AgentPreset {
	name, _, _ := strings.Cut(sess.Location, "/")
	if loc, err := b.Locations.Get(ctx, name); err == nil {
		if p, ok := presetFor(&loc, "claude"); ok {
			return p
		}
	}
	for _, p := range builtinAgents {
		if p.ID == "claude" {
			return p
		}
	}
	return AgentPreset{ID: "claude", Name: "Claude Code", Command: "claude"}
}

func (b *Box) toTerminal(r *http.Request, sess Session) error {
	ctx := r.Context()
	c, err := b.claude().conv(sess)
	if err != nil {
		return err
	}
	c.mu.Lock()
	sid, mode, bypass := c.sessionID, firstNonEmpty(c.mode, "default"), c.bypass
	c.mu.Unlock()
	if sid == "" {
		return httpError{http.StatusConflict, "Claude hasn't started its conversation yet: send it something first"}
	}
	// Where its transcript stands now: what the terminal adds is past it.
	// Claude Code names a conversation at its start (its SessionStart hooks
	// carry the ID) but saves it only at its first prompt: until then
	// --resume finds nothing and quits, so the terminal starts it under its
	// ID instead, and everything it writes there is the terminal's.
	handoff := ""
	if _, path, _ := b.transcriptFile(ctx, sess, nil); path != "" {
		if st, err := os.Stat(path); err == nil {
			handoff = strconv.FormatInt(st.Size(), 10) + " " + path
		}
	}
	resume := " --resume "
	if home := b.claudeHomeFor(ctx, sess); claudeFile(home, sess.Dir, sid) == "" {
		// Where it will write: the folder named by the real path.
		folders := claudeFolders(home, sess.Dir)
		resume, handoff = " --session-id ", "0 "+filepath.Join(folders[len(folders)-1], sid+".jsonl")
	}
	stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := agenthost.Stop(stopCtx, sess.sock); err != nil && !errors.Is(err, agenthost.ErrNoHost) {
		return err
	}
	b.claude().forget(sess.Name)
	command := b.claudePreset(ctx, sess).Command + resume + shellQuote(sid)
	if bypass && os.Getuid() != 0 {
		command += " --permission-mode bypassPermissions"
	} else if mode != "default" {
		command += " --permission-mode " + shellQuote(mode)
	}
	err = b.respawnAgent(ctx, sess, command, []string{"BERTH_DRIVER="}, map[string]string{labelDriver: "", labelHandoff: handoff})
	if err != nil {
		return err
	}
	// Claude Code's own screen may ask its startup questions.
	b.beginStartup(origin(r), Session{Name: sess.Name, Agent: "claude", Dir: sess.Dir})
	return nil
}

func (b *Box) toChat(r *http.Request, sess Session) error {
	ctx := r.Context()
	sid := ""
	if b.Turns != nil {
		if st, ok := b.Turns.State(sess.Name); ok {
			sid = st.AgentSessionID
		}
	}
	if sid == "" {
		sid = lastSessionID(filepath.Join(sess.conv, agenthost.LogName))
	}
	if sid == "" {
		return httpError{http.StatusConflict, "berthd doesn't know which Claude conversation this is"}
	}
	// Ask Claude Code to leave, as a person would, then make sure.
	b.Sessions.tmux(ctx, "send-keys", "-t", "="+sess.Name+":", "-l", "/exit")
	time.Sleep(150 * time.Millisecond)
	b.Sessions.tmux(ctx, "send-keys", "-t", "="+sess.Name+":", "Enter")
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if s, err := b.Sessions.Get(ctx, sess.Name); err != nil || s.Exited {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if err := b.importTerminalTurns(ctx, sess); err != nil {
		return err
	}
	return b.resumeInPlace(r, sess, sid)
}

// modeFor is the mode a structured session goes back to: bypass when
// berthd allowed its permissions before.
func modeFor(sess Session) string {
	if sess.bypass {
		return "bypassPermissions"
	}
	return ""
}

// importTerminalTurns copies what was said in Claude Code's terminal from
// its transcript into berthd's log, so the chat reads on from where the
// terminal left it.
func (b *Box) importTerminalTurns(ctx context.Context, sess Session) error {
	v, err := b.Sessions.tmux(ctx, "show-options", "-v", "-t", "="+sess.Name+":", labelHandoff)
	if err != nil {
		return nil
	}
	off, path, ok := strings.Cut(strings.TrimSpace(string(v)), " ")
	from, perr := strconv.ParseInt(off, 10, 64)
	if !ok || perr != nil || path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	if _, err := f.Seek(from, 0); err != nil {
		return nil
	}
	log, err := agenthost.OpenLog(sess.conv)
	if err != nil {
		return err
	}
	defer log.Close()
	rd := bufio.NewReaderSize(f, 256<<10)
	for {
		line, err := rd.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' && json.Valid(line) {
			log.Append(agenthost.Entry{Dir: "out", Event: "imported", Data: json.RawMessage(strings.TrimSpace(string(line)))})
		}
		if err != nil {
			return nil
		}
	}
}

// prompted says whether a conversation's log has had anything said in it:
// a prompt sent to Claude, or turns copied in from its terminal or a past
// conversation. Before that, Claude Code has saved nothing to resume.
func prompted(convDir string) bool {
	found := errors.New("found")
	err := agenthost.ReadLog(filepath.Join(convDir, agenthost.LogName), 0, func(e agenthost.Entry) error {
		var l struct {
			Type string `json:"type"`
		}
		if e.Event == "imported" || (e.Dir == "in" && json.Unmarshal(e.Data, &l) == nil && l.Type == "user") {
			return found
		}
		return nil
	})
	return errors.Is(err, found)
}

// lastSessionID is the Claude conversation a log last spoke in.
func lastSessionID(path string) string {
	sid := ""
	agenthost.ReadLog(path, 0, func(e agenthost.Entry) error {
		var l struct {
			SessionID string `json:"session_id"`
		}
		if e.Dir == "out" && json.Unmarshal(e.Data, &l) == nil && l.SessionID != "" {
			sid = l.SessionID
		}
		return nil
	})
	return sid
}

// respawnAgent runs command in the session's pane in place of what ran
// there, with env added to the session's own and labels set, as create
// starts one (sessions.go): with its agent's CLI on PATH, which a login
// shell may otherwise lose (Debian's resets it). The variables the session
// was started with of its own stay over its worktree's.
func (b *Box) respawnAgent(ctx context.Context, sess Session, command string, env []string, labels map[string]string) error {
	agent := firstNonEmpty(agentFor(sess), "claude")
	s := b.Sessions
	own := b.ownEnv(ctx, sess)
	extra, wrap := b.sessionEnv(ctx, sess.Dir, own)
	file, err := s.writeCommand(sess.Name, command)
	if err != nil {
		return err
	}
	shell := sessionShell()
	argv := []string{shell, "-lc", withPATH(shell, launchPATH(command, agent), sourceCommand(shell, file))}
	target := "=" + sess.Name + ":"
	args := []string{"respawn-pane", "-k", "-t", target, "-c", sess.Dir}
	// A default for one of the session's own would hide its value.
	for _, kv := range append(append(withoutVars(withAgentBrowserIdle(extra), own), "BERTH_SESSION="+sess.Name, "BERTH_AGENT="+agent), env...) {
		args = append(args, "-e", kv)
	}
	args = append(append(args, "--"), groups.Wrap(append(append([]string(nil), wrap...), argv...))...)
	set := func(k, v string) {
		args = append(args, ";", "set-option", "-t", target, k, v)
	}
	set("@berth_command", plainCommand(command))
	set("@berth_command_file", file)
	for _, k := range slices.Sorted(maps.Keys(labels)) {
		set(k, labels[k])
	}
	for i, a := range args {
		if a != ";" {
			args[i] = tmuxArg(a)
		}
	}
	if out, err := s.tmux(ctx, args...); err != nil {
		return tmuxError("respawn-pane", out, err)
	}
	return nil
}
