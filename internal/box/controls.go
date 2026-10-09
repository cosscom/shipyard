package box

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
)

// The chat's controls: keys pressed into an agent's terminal (Esc to stop
// it, Shift+Tab to change its permission mode), and what its screen says
// about its mode. A key reaches the agent as surely as typed text, so the
// same gate as a send decides.

// controlKeys are the keys the app may press, by name, as tmux names them.
var controlKeys = map[string]string{
	"escape": "Escape", "enter": "Enter", "tab": "Tab", "btab": "BTab", "shift+tab": "BTab",
	"up": "Up", "down": "Down", "left": "Left", "right": "Right", "interrupt": "C-c",
	"1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
	"y": "y", "n": "n",
}

func controlAgent(sess Session) string {
	if sess.Service != "" {
		return ""
	}
	return firstNonEmpty(sess.Preset, firstNonEmpty(sess.Agent, agentOf(sess.Command)))
}

// pressKeys presses each key in turn into a live session.
func (b *Box) pressKeys(ctx context.Context, name string, keys ...string) error {
	for _, k := range keys {
		if out, err := b.Sessions.tmux(ctx, "send-keys", "-t", "="+name+":", k); err != nil {
			return tmuxSendError("send-keys", out, err)
		}
	}
	return nil
}

// sessionKeys answers POST /v1/sessions/{name}/keys {"keys":["escape"]}.
func (b *Box) sessionKeys(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Keys []string `json:"keys"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	if len(req.Keys) == 0 || len(req.Keys) > 12 {
		return badRequest("keys must name 1 to 12 keys")
	}
	var keys []string
	for _, k := range req.Keys {
		key, ok := controlKeys[strings.ToLower(k)]
		if !ok {
			return badRequest("unknown key %q", k)
		}
		keys = append(keys, key)
	}
	name := r.PathValue("name")
	sess, err := b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	if sess.Exited {
		return ErrSessionExited
	}
	if err := b.before(r, "session.send", map[string]any{"name": name, "key": strings.Join(req.Keys, " ")}); err != nil {
		return err
	}
	if err := b.pressKeys(r.Context(), name, keys...); err != nil {
		return err
	}
	writeJSON(w, map[string]bool{"sent": true})
	return nil
}

var (
	// "✻ Brewing… (12s · esc to interrupt)": an agent at work.
	working     = regexp.MustCompile(`(?i)esc to interrupt|esc to cancel`)
	interrupted = regexp.MustCompile(`(?i)\binterrupted\b`)
)

// interruptSession answers POST /v1/sessions/{name}/interrupt: it presses
// Esc, as stopping an agent at its terminal does, waits for the agent to
// stop, and ends its turn in the ledger. Claude Code's hooks say nothing
// when a turn is interrupted, so without this the session would read as
// working until its next prompt.
func (b *Box) interruptSession(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	sess, err := b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	if sess.Exited {
		return ErrSessionExited
	}
	if err := b.before(r, "session.send", map[string]any{"name": name, "key": "escape"}); err != nil {
		return err
	}
	var st SessionState
	if b.Turns != nil {
		st, _ = b.Turns.State(name)
	}
	if err := b.pressKeys(r.Context(), name, "Escape"); err != nil {
		return err
	}
	// The agent stops within a moment: its "esc to interrupt" goes, and
	// Claude Code says "Interrupted".
	stopped := false
	deadline := time.Now().Add(4 * time.Second)
	for !stopped && time.Now().Before(deadline) {
		time.Sleep(150 * time.Millisecond)
		screen, err := b.Sessions.Screen(r.Context(), name, 0)
		if err != nil {
			break
		}
		tail := lastLines(screen, 14)
		stopped = !working.MatchString(tail) && adapters.ScreenState(screen) != "waiting"
	}
	if stopped && b.Turns != nil && (st.State == "running" || st.State == "waiting") {
		b.Events.Publish(events.Event{Type: adapters.Finished, Box: b.Name, Origin: origin(r), Data: map[string]any{
			"session": name, "path": sess.Dir, "agent": controlAgent(sess), "source": "interrupt", "status": "interrupted",
		}})
	}
	writeJSON(w, map[string]bool{"sent": true, "stopped": stopped})
	return nil
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n "), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// Controls is what an agent's screen says about it: its permission mode
// and effort (Claude Code draws both under its input), and the background
// work it says is still running.
type Controls struct {
	Agent  string `json:"agent"`
	Mode   string `json:"mode,omitempty"`
	Effort string `json:"effort,omitempty"`
	// Modes are the modes it can be switched to here, in its order.
	Modes []string `json:"modes,omitempty"`
	// Limit is a usage limit the screen shows ("You've hit your limit ·
	// resets 3pm"), when the transcript has no word of it.
	Limit string `json:"limit,omitempty"`
}

var (
	claudeModeLine = regexp.MustCompile(`(?i)(bypass permissions|accept edits|plan mode|auto mode|manual mode|default mode) on\b`)
	claudeEffort   = regexp.MustCompile(`(?i)[●○◐◑]\s*(low|medium|high|xhigh|max)\s*·\s*/effort`)
	screenLimit    = regexp.MustCompile(`(?i)[^\n]*(usage limit|hit your limit|limit reached|out of extra usage)[^\n]*`)
	claudeModes    = map[string]string{"bypass permissions": "bypassPermissions", "accept edits": "acceptEdits", "plan mode": "plan", "auto mode": "auto", "manual mode": "default", "default mode": "default"}
)

// claudeControls reads Claude Code's footer: "⏵⏵ accept edits on (shift+
// tab to cycle)", "⏸ plan mode on"; none at all is its default mode.
func claudeControls(screen string) Controls {
	c := Controls{Agent: "claude", Mode: "default"}
	tail := lastLines(screen, 8)
	if m := claudeModeLine.FindAllStringSubmatch(tail, -1); m != nil {
		c.Mode = claudeModes[strings.ToLower(m[len(m)-1][1])]
	}
	if m := claudeEffort.FindStringSubmatch(lastLines(screen, 12)); m != nil {
		c.Effort = strings.ToLower(m[1])
	}
	if m := screenLimit.FindAllString(lastLines(screen, 20), -1); m != nil {
		c.Limit = strings.Trim(strings.TrimSpace(m[len(m)-1]), "│|╭╰─⎿ ")
	}
	return c
}

// sessionControls answers GET /v1/sessions/{name}/controls.
func (b *Box) sessionControls(w http.ResponseWriter, r *http.Request) error {
	sess, err := b.Sessions.Get(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	agent := controlAgent(sess)
	out := Controls{Agent: agent}
	if !sess.Exited {
		screen, err := b.Sessions.capture(r.Context(), sess.Name, 0)
		if err != nil {
			return err
		}
		if agent == "claude" {
			out = claudeControls(screen)
			out.Modes = []string{"default", "acceptEdits", "plan", "auto", "bypassPermissions"}
		} else if m := screenLimit.FindAllString(lastLines(screen, 20), -1); m != nil {
			out.Limit = strings.TrimSpace(m[len(m)-1])
		}
	}
	writeJSON(w, out)
	return nil
}

// setMode answers POST /v1/sessions/{name}/mode {"mode":"plan"}: it presses
// Shift+Tab, as a person cycling Claude Code's modes does, until its screen
// shows that mode, and says where it ended up. A mode the session can't
// reach (bypass, unless it was started allowing it) is a 409.
func (b *Box) setMode(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mode string `json:"mode"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	name := r.PathValue("name")
	sess, err := b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	if sess.Exited {
		return ErrSessionExited
	}
	if controlAgent(sess) != "claude" {
		return badRequest("only Claude Code's mode can be switched from here; use its terminal")
	}
	if b.Turns != nil {
		// Shift+Tab at a permission prompt picks an option: never there.
		if st, ok := b.Turns.State(name); ok && st.State == "waiting" {
			return httpError{http.StatusConflict, "the agent is waiting for an answer; answer it first"}
		}
	}
	if err := b.before(r, "session.send", map[string]any{"name": name, "key": "btab", "mode": req.Mode}); err != nil {
		return err
	}
	read := func() (string, error) {
		screen, err := b.Sessions.Screen(r.Context(), name, 0)
		if err != nil {
			return "", err
		}
		if adapters.ScreenState(screen) == "waiting" {
			return "", httpError{http.StatusConflict, "the agent is showing a question; answer it first"}
		}
		return claudeControls(screen).Mode, nil
	}
	mode, err := read()
	if err != nil {
		return err
	}
	seen := map[string]bool{mode: true}
	for presses := 0; mode != req.Mode && presses < 7; presses++ {
		if err := b.pressKeys(r.Context(), name, "BTab"); err != nil {
			return err
		}
		// The footer redraws within a moment.
		next := mode
		for wait := 0; wait < 10 && next == mode; wait++ {
			time.Sleep(100 * time.Millisecond)
			if next, err = read(); err != nil {
				return err
			}
		}
		mode = next
		if mode != req.Mode && seen[mode] && presses > 0 {
			break // round the whole cycle: not one this session has
		}
		seen[mode] = true
	}
	if mode != req.Mode {
		msg := "this session doesn't offer that mode; it is in " + mode + " mode"
		if req.Mode == "bypassPermissions" {
			msg = "bypass needs Claude Code started with --dangerously-skip-permissions; this session is in " + mode + " mode"
		}
		return httpError{http.StatusConflict, msg}
	}
	b.publish(r, "session.mode", map[string]any{"name": name, "mode": mode})
	writeJSON(w, map[string]any{"mode": mode})
	return nil
}
