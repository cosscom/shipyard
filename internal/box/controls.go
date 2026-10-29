package box

import (
	"context"
	"net/http"
	"regexp"
	"strings"

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

// interruptSession answers POST /v1/sessions/{name}/interrupt: its driver
// stops the agent (Esc, in a terminal), and the turn ends in the ledger.
// Claude Code's hooks say nothing when a turn is interrupted, so without
// this the session would read as working until its next prompt.
func (b *Box) interruptSession(w http.ResponseWriter, r *http.Request) error {
	stopped, err := b.interrupt(r, r.PathValue("name"), "")
	if err != nil {
		return err
	}
	writeJSON(w, map[string]bool{"sent": true, "stopped": stopped})
	return nil
}

// interrupt stops a session's agent the way its driver can (Esc, or its
// own interrupt for one without a terminal), through the send gate as a
// key would. from names a caller the gate can't tell by its origin: the
// phone.
func (b *Box) interrupt(r *http.Request, name, from string) (bool, error) {
	sess, err := b.Sessions.Get(r.Context(), name)
	if err != nil {
		return false, err
	}
	if sess.Exited {
		return false, ErrSessionExited
	}
	gate := map[string]any{"name": name, "key": "escape"}
	who := origin(r)
	if from != "" {
		gate["from"], who = from, from
	}
	if err := b.before(r, "session.send", gate); err != nil {
		return false, err
	}
	var st SessionState
	if b.Turns != nil {
		st, _ = b.Turns.State(name)
	}
	stopped, err := b.driverFor(sess).Interrupt(r.Context(), sess)
	if err != nil {
		return false, err
	}
	if stopped && b.Turns != nil && (st.State == "running" || st.State == "waiting") {
		b.Events.Publish(events.Event{Type: adapters.Finished, Box: b.Name, Origin: who, Data: map[string]any{
			"session": name, "path": sess.Dir, "agent": controlAgent(sess), "source": "interrupt", "status": "interrupted",
		}})
	}
	return stopped, nil
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
	out, err := b.driverFor(sess).Controls(r.Context(), sess)
	if err != nil {
		return err
	}
	writeJSON(w, out)
	return nil
}

// setMode answers POST /v1/sessions/{name}/mode {"mode":"plan"}: the
// session's driver switches the mode (Shift+Tab in a terminal), and it says
// where it ended up. A mode the session can't reach is a 409.
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
	if b.Turns != nil {
		// A mode change at a permission prompt can pick an option there.
		// Turn check's wait has none: the agent sits at its prompt.
		if st, ok := b.Turns.State(name); ok && st.State == "waiting" && !st.SoftWait {
			return httpError{http.StatusConflict, "the agent is waiting for an answer; answer it first"}
		}
	}
	if err := b.before(r, "session.send", map[string]any{"name": name, "key": "btab", "mode": req.Mode}); err != nil {
		return err
	}
	mode, err := b.driverFor(sess).SetMode(r.Context(), sess, req.Mode)
	if err != nil {
		return err
	}
	b.publish(r, "session.mode", map[string]any{"name": name, "mode": mode})
	writeJSON(w, map[string]any{"mode": mode})
	return nil
}
