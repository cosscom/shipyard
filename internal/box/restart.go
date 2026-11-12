package box

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
)

// Restarting a structured Claude session (POST /v1/sessions/{name}/restart,
// "sessions.restart" capability): at the end of its turn, its agent is
// stopped and started again in its own pane with --resume, the same model,
// effort and permission mode, on the same log and socket. It is for what
// only a new process picks up: a newer Claude Code, a changed MCP config, a
// new login. A client following the log by seq reads the host's "exited", a
// "restart" entry with the reason, then "started", and carries on; what is
// sent meanwhile waits for it.

// RestartRequest is what POST /v1/sessions/{name}/restart takes.
type RestartRequest struct {
	Reason string `json:"reason,omitempty"`
}

// RestartResult is what a restart answers: the conversation carried on,
// and how long it waited for the agent's turn to end.
type RestartResult struct {
	Name           string `json:"name"`
	AgentSessionID string `json:"agent_session_id,omitempty"`
	WaitedMS       int64  `json:"waited_ms"`
	Reason         string `json:"reason,omitempty"`
}

// restarts are the sessions restarting (startKey): what their inbox holds
// waits until they are back, rather than starting a turn that the restart
// would then wait for.
var restarts sync.Map

// restarting says whether a session is restarting.
func (b *Box) restarting(name string) bool {
	_, ok := restarts.Load(startKey{b, name})
	return ok
}

const (
	// restartWait is how long a restart waits for the turn to end, unless
	// asked otherwise (?timeout=), up to maxRestartWait.
	restartWait    = 10 * time.Minute
	maxRestartWait = time.Hour
	maxReason      = 200
)

func (b *Box) restartSession(w http.ResponseWriter, r *http.Request) error {
	var req RestartRequest
	if r.ContentLength > 0 {
		if err := decode(r, &req); err != nil {
			return err
		}
	}
	reason := adapters.Clip(req.Reason, maxReason)
	wait := restartWait
	if v := r.URL.Query().Get("timeout"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 || d > maxRestartWait {
			return badRequest("timeout is how long to wait for the turn to end, up to 1h (like 10m)")
		}
		wait = d
	}
	ctx := r.Context()
	name := r.PathValue("name")
	sess, err := b.Sessions.Get(ctx, name)
	if err != nil {
		return err
	}
	if sess.Driver != DriverClaude || sess.conv == "" || sess.sock == "" {
		return httpError{http.StatusConflict, name + " isn't a structured Claude session: only those restart in place"}
	}
	if !conversationRunning(sess) {
		return httpError{http.StatusConflict, name + "'s agent has ended: resume it instead"}
	}
	if err := b.before(r, "session.start", map[string]any{"name": name, "location": sess.Location, "path": sess.Dir, "resume": true, "restart": true}); err != nil {
		return err
	}
	c, err := b.claude().conv(sess)
	if err != nil {
		return err
	}
	key := startKey{b, name}
	if _, already := restarts.LoadOrStore(key, struct{}{}); already {
		return httpError{http.StatusConflict, name + " is already restarting"}
	}
	defer func() {
		// Held prompts go once it is back (deliverInbox).
		restarts.Delete(key)
		if b.Turns != nil {
			b.Turns.kickInbox()
		}
	}()
	began := time.Now()
	unlock, err := b.awaitTurnEnd(ctx, c, began.Add(wait))
	if err != nil {
		return err
	}
	defer unlock()
	waited := time.Since(began)

	c.mu.Lock()
	sid, mode := c.sessionID, c.mode
	if c.bypass {
		mode = "bypassPermissions"
	}
	c.mu.Unlock()
	if sid == "" {
		sid = conversationSession(sess.conv)
	}
	if sid == "" && prompted(sess.conv) {
		return httpError{http.StatusConflict, "berthd doesn't know which Claude conversation this is"}
	}

	// Let go of it first: its agent ending here is a restart, not the
	// session's end, and isn't said as one.
	b.forgetConversation(name)
	stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	err = agenthost.Stop(stopCtx, sess.sock)
	cancel()
	if err != nil && !errors.Is(err, agenthost.ErrNoHost) {
		return err
	}
	// Stop returns once the agent is gone; the host then logs its exit and
	// ends, and the pane shows it has: the log is nobody's until the next.
	if b.awaitPaneExit(ctx, name, 15*time.Second) {
		noteRestart(sess.conv, reason)
	}
	if err := b.startInPlace(r, sess, sid, mode); err != nil {
		return err
	}
	if live, err := b.Sessions.Get(ctx, name); err == nil {
		if c, err := b.claude().conv(live); err == nil {
			// Something that read the old agent's end as it happened (a list
			// asking what the session does, mid-restart) said it exited: it
			// is ready again, so the inbox goes on.
			c.later(func() {
				if b.Turns == nil {
					return
				}
				if st, ok := b.Turns.State(name); ok && st.State == "exited" {
					c.event(adapters.Ready, nil, nil)
				}
			})
		}
	}
	res := RestartResult{Name: name, AgentSessionID: sid, WaitedMS: waited.Milliseconds(), Reason: reason}
	b.publish(r, "session.restarted", map[string]any{"name": name, "agent_session_id": sid, "waited_ms": res.WaitedMS, "reason": reason})
	writeJSON(w, res)
	return nil
}

// awaitTurnEnd waits until the conversation is between turns (its log read
// back, no turn sent, running or waiting, nothing asked of anyone) and
// returns holding the session's send lock, so nothing is typed into it
// until unlock. A turn that hasn't ended by deadline is 504, with nothing
// held.
func (b *Box) awaitTurnEnd(ctx context.Context, c *claudeConv, deadline time.Time) (unlock func(), err error) {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	late := httpError{http.StatusGatewayTimeout, c.name + "'s turn didn't end in time: it was left running"}
	select {
	case <-c.caught:
	case <-timer.C:
		return nil, late
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	between := func() (bool, <-chan struct{}, <-chan struct{}) {
		var turns <-chan struct{}
		if b.Turns != nil {
			turns = b.Turns.Changed()
		}
		c.mu.Lock()
		ok, changed := !c.busy && len(c.pending) == 0, c.changed
		c.mu.Unlock()
		return ok && (b.Turns == nil || !b.Turns.turnOpen(c.name)), changed, turns
	}
	for {
		ok, changed, turns := between()
		if ok {
			unlock := b.lockSend(c.name)
			// A send that took the lock first has opened its turn by now.
			if again, _, _ := between(); again {
				return unlock, nil
			}
			unlock()
			continue
		}
		select {
		case <-changed:
		case <-turns:
		case <-timer.C:
			return nil, late
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// awaitPaneExit waits up to d for a session's pane to show its program
// ended, and says whether it did.
func (b *Box) awaitPaneExit(ctx context.Context, name string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		if s, err := b.Sessions.Get(ctx, name); err != nil || s.Exited {
			return err == nil
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// noteRestart keeps a restart, and why, in a conversation's log, between
// the host that ended and the one that starts.
func noteRestart(dir, reason string) {
	log, err := agenthost.OpenLog(dir)
	if err != nil {
		return
	}
	defer log.Close()
	log.Append(agenthost.Entry{Dir: "host", Event: "restart", Text: reason})
}
