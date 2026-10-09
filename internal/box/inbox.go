package box

import (
	"net/http"
	"time"

	"github.com/cosscom/shipyard/internal/events"
)

// The inbox's API: what a session holds until its agent is idle (sends
// with when "idle"), and the two things a person can do about one held
// prompt: send it now, or cancel it. Prompts are read from the inbox's
// private file, never from events.

func (b *Box) listQueue(w http.ResponseWriter, r *http.Request) error {
	if b.Turns == nil {
		return httpError{http.StatusNotImplemented, "this box keeps no turns"}
	}
	writeJSON(w, b.Turns.Queued(r.PathValue("name")))
	return nil
}

// cancelQueued drops a held prompt before it is typed.
func (b *Box) cancelQueued(w http.ResponseWriter, r *http.Request) error {
	if b.Turns == nil {
		return httpError{http.StatusNotImplemented, "this box keeps no turns"}
	}
	name, turn := r.PathValue("name"), r.PathValue("turn")
	unlock := b.lockSend(name)
	err := b.Turns.Cancel(name, turn)
	unlock()
	if err != nil {
		return err
	}
	b.publish(r, "session.unqueued", map[string]any{"name": name, "turn": turn})
	writeJSON(w, map[string]any{"cancelled": turn})
	return nil
}

// sendQueued types a held prompt now, ahead of the agent finishing. Like
// any send, it refuses an agent that waits for someone unless force: the
// text would be typed into its question.
func (b *Box) sendQueued(w http.ResponseWriter, r *http.Request) error {
	if b.Turns == nil {
		return httpError{http.StatusNotImplemented, "this box keeps no turns"}
	}
	var req struct {
		Force bool `json:"force"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &req); err != nil {
			return err
		}
	}
	name, turn := r.PathValue("name"), r.PathValue("turn")
	if err := b.before(r, "session.send", map[string]any{"name": name}); err != nil {
		return err
	}
	ctx := r.Context()
	defer b.lockSend(name)()
	sess, err := b.Sessions.Get(ctx, name)
	if err != nil {
		return err
	}
	if agent := agentFor(sess); b.atStartupQuestion(ctx, Session{Name: name, Agent: agent}) {
		// Even forced: the question would drop the text and take its Enter.
		return startupText(agent)
	}
	waiting := ""
	if st := b.enrich(ctx, []Session{sess})[0]; st.AgentState == "waiting" && !b.Turns.SoftWait(name) {
		waiting = st.Turn
	}
	if waiting != "" && !req.Force {
		return httpError{http.StatusConflict, ErrAgentWaiting{name}.Error()}
	}
	it, err := b.Turns.takeQueued(name, turn)
	if err != nil {
		return err
	}
	if err := b.Sessions.Send(ctx, name, it.Text, it.Enter); err != nil {
		b.Turns.putBack(it)
		return err
	}
	data := map[string]any{"name": name, "from": it.Origin, "when": "now"}
	if waiting != "" {
		// Typed at a question, it is an answer there, not a turn of its own.
		data["answer"], data["turn"] = true, waiting
		b.Turns.endQueued(name, turn, "sent as an answer")
	} else {
		data["turn"] = turn
	}
	e := b.publish(r, "session.sent", data)
	res := SendResult{Sent: true, Turn: turn, Seq: e.Seq, At: e.Time.UTC()}
	if waiting != "" {
		res.Turn = waiting
	} else if tr, ok := b.Turns.Get(turn); ok && tr.State == "running" && tr.Fidelity != "hooks" {
		// The agent cannot say it started: the send says so.
		b.Events.Publish(events.Event{Type: "agent.started", Box: b.Name, Origin: origin(r), Data: map[string]any{
			"session": name, "path": sess.Dir, "agent": tr.Agent, "source": "send", "turn": tr.ID,
		}})
	}
	writeJSON(w, res)
	return nil
}

// endQueued ends a held turn taken from the inbox that will not start.
func (t *Turns) endQueued(name, turn, status string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if s := t.sess[name]; s != nil {
		if tr := s.find(turn); tr != nil && tr.State == "queued" {
			tr.State, tr.Ended, tr.Status = "lost", time.Now().UTC(), status
			t.bump()
		}
	}
}
