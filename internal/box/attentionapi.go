package box

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/events"
)

// The attention API (attention.go):
//
//	GET   /v1/attention?session=S&open=1  the items, the most recently changed first
//	POST  /v1/attention                   post an ask, or replace the one at its key
//	GET   /v1/attention/{key}             one item
//	PATCH /v1/attention/{key}             answer, close, reopen or snooze one; a key
//	                                      with no item gets a mark
//	POST  /v1/sessions/{name}/attention   an agent's own ask (AgentAsk), at its
//	                                      session's key
//
// A key is path-escaped (encodeURIComponent), so it may hold slashes.
//
// When a person settles an agent's ask (answers it or closes it), the box
// tells the agent with a prompt, held until it is idle: the agent posts and
// carries on, and hears back when there is something to hear.
// Events say what changed and never an item's words: attention.posted,
// attention.updated and attention.settled carry key, revision, kind,
// status, session and, when set, closed_reason and snoozed_until.

func (b *Box) mountAttention(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("GET /v1/attention", b.listAttention)
	route("POST /v1/attention", b.postAttention)
	route("GET /v1/attention/{key...}", b.getAttention)
	route("PATCH /v1/attention/{key...}", b.updateAttention)
	route("POST /v1/sessions/{name}/attention", b.postAgentAsk)
}

// AgentAsk is what an agent posts about its own work, without stopping it:
// a decision it needs, an action only the person can take, work ready for
// them, or that it is blocked. It goes to the session's key, so a new ask
// replaces the agent's last one.
//
// It is stricter than a plugin's post: one of AgentAskKinds, no field it
// doesn't name, and options only on a decision. An agent's words are only
// words, drawn as text: an ask carries no link or command for a button to
// follow, and every kind but decision gets the app's own buttons.
type AgentAsk struct {
	Kind        string            `json:"kind"`
	Title       string            `json:"title"`
	Details     string            `json:"details,omitempty"`
	Options     []AttentionOption `json:"options,omitempty"`
	Recommended string            `json:"recommended,omitempty"`
}

// AgentAskKinds are the kinds an agent posts.
var AgentAskKinds = []string{"decision", "action", "ready", "blocked"}

func (a AgentAsk) check() error {
	if !slices.Contains(AgentAskKinds, a.Kind) {
		return badRequest("kind is one of %s", strings.Join(AgentAskKinds, ", "))
	}
	if a.Kind != "decision" && (len(a.Options) > 0 || a.Recommended != "") {
		return badRequest("only a decision offers options; the app gives a %s its own buttons", a.Kind)
	}
	return nil
}

func (b *Box) postAgentAsk(w http.ResponseWriter, r *http.Request) error {
	if b.Attention == nil {
		return errNoAttention
	}
	var a AgentAsk
	if err := decodeStrict(r, &a, 4*maxAttentionText); err != nil {
		return err
	}
	if err := a.check(); err != nil {
		return err
	}
	return b.post(w, r, AttentionPost{Kind: a.Kind, Title: a.Title, Details: a.Details, Options: a.Options, Recommended: a.Recommended, Session: r.PathValue("name")})
}

var errNoAttention = httpError{http.StatusNotImplemented, "this box keeps no attention items"}

func (b *Box) listAttention(w http.ResponseWriter, r *http.Request) error {
	if b.Attention == nil {
		return errNoAttention
	}
	q := r.URL.Query()
	items, err := b.Attention.List(AttentionFilter{Session: q.Get("session"), Open: q.Get("open") == "1"})
	if err != nil {
		return err
	}
	writeJSON(w, items)
	return nil
}

func (b *Box) getAttention(w http.ResponseWriter, r *http.Request) error {
	if b.Attention == nil {
		return errNoAttention
	}
	it, ok, err := b.Attention.Get(r.PathValue("key"))
	if err != nil {
		return err
	}
	if !ok {
		return httpError{http.StatusNotFound, "no attention item with that key"}
	}
	writeJSON(w, it)
	return nil
}

func (b *Box) postAttention(w http.ResponseWriter, r *http.Request) error {
	if b.Attention == nil {
		return errNoAttention
	}
	var p AttentionPost
	if err := decodeLimit(r, &p, 4*maxAttentionText); err != nil {
		return err
	}
	return b.post(w, r, p)
}

func (b *Box) post(w http.ResponseWriter, r *http.Request, p AttentionPost) error {
	// An ask about a session settles when it ends, so it must be one that
	// runs.
	if p.Session != "" && b.Sessions != nil {
		sess, err := b.Sessions.Get(r.Context(), p.Session)
		if err != nil {
			return err
		}
		if sess.Exited {
			return ErrSessionExited
		}
	}
	p.Key = p.KeyOrSession()
	if err := b.before(r, "attention.post", map[string]any{"key": p.Key, "kind": p.Kind, "session": p.Session}); err != nil {
		return err
	}
	it, err := b.Attention.Post(p, origin(r))
	if err != nil {
		return err
	}
	b.publish(r, "attention.posted", attentionEventData(it))
	writeJSON(w, it)
	return nil
}

func (b *Box) updateAttention(w http.ResponseWriter, r *http.Request) error {
	if b.Attention == nil {
		return errNoAttention
	}
	key := r.PathValue("key")
	var u AttentionUpdate
	if err := decodeLimit(r, &u, 2*maxAttentionText); err != nil {
		return err
	}
	gate := map[string]any{"key": key}
	if u.Status != nil {
		gate["status"] = *u.Status
	}
	if u.SnoozedUntil != nil {
		gate["snoozed_until"] = *u.SnoozedUntil
	}
	if err := b.before(r, "attention.update", gate); err != nil {
		return err
	}
	it, settled, err := b.Attention.update(key, u, origin(r))
	if err != nil {
		return err
	}
	b.publish(r, "attention.updated", attentionEventData(it))
	if settled && it.isSessionAsk() {
		// In the background: the change is saved and announced, and the
		// person needn't wait on the agent's terminal.
		go b.tellAsker(it, origin(r), gateOrigin(r))
	}
	writeJSON(w, it)
	return nil
}

// isSessionAsk says it is a session's own ask (an agent's), not a mark.
func (it AttentionItem) isSessionAsk() bool {
	return it.Kind != attentionMark && it.Session != "" && it.Key == SessionKey(it.Session)
}

// tellAsker types the person's answer to an ask into the session that
// posted it, held until the agent is idle (a held prompt survives a
// restart). Its idempotency key is the item's revision, so a retry never
// tells it twice. A session that has gone has no one to tell; the item
// says what happened either way.
func (b *Box) tellAsker(it AttentionItem, origin, from string) {
	if b.Sessions == nil || b.Turns == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req := SendRequest{Text: AnswerText(it), When: "idle", IdemKey: fmt.Sprintf("attention:%s:%d", it.Key, it.Revision)}
	if _, err := b.sendPrompt(ctx, it.Session, req, origin, from); err != nil {
		log.Printf("attention %s: telling %s: %v", it.Key, it.Session, err)
	}
}

// AnswerText is what an agent reads when a person settles its ask.
func AnswerText(it AttentionItem) string {
	title := flatText(it.Title)
	switch {
	case it.Status == AttentionAnswered && it.Answer == "":
		return fmt.Sprintf("The user marked your ask in Shipyard (%s: %q) as answered, with no words.", it.Kind, title)
	case it.Status == AttentionAnswered:
		return fmt.Sprintf("The user answered your ask in Shipyard (%s: %q): %s", it.Kind, title, it.Answer)
	}
	return fmt.Sprintf("The user closed your ask in Shipyard (%s: %q) without answering it (%s). Carry on, or post again if you still need them.", it.Kind, title, it.ClosedReason)
}

// sweepAttention settles the items of sessions that ended, given the
// sessions a listing taken at the time at found, and forgets items past
// their time. refreshTurns runs it as the backstop for a session whose
// program ended by itself.
func (b *Box) sweepAttention(all []Session, at time.Time) {
	if b.Attention == nil {
		return
	}
	live := make(map[string]bool, len(all))
	for _, s := range all {
		if !s.Exited {
			live[s.Name] = true
		}
	}
	b.publishSettled(b.Attention.Sweep(live, at))
}

// WatchAttention settles a session's items as soon as it is stopped,
// however it was: every stop ends in a session.stopped event, which is what
// this listens for. The returned func stops it.
func (b *Box) WatchAttention() (stop func()) {
	if b.Attention == nil || b.Events == nil {
		return func() {}
	}
	return b.Events.Observe(func(e events.Event) {
		if e.Type != "session.stopped" {
			return
		}
		if name, _ := e.Data["name"].(string); name != "" {
			// Not here: an observer must be quick and must not publish.
			go b.publishSettled(b.Attention.SettleSession(name))
		}
	})
}

func (b *Box) publishSettled(settled []AttentionItem) {
	for _, it := range settled {
		b.Events.Publish(events.Event{Type: "attention.settled", Box: b.Name, Origin: "berth", Data: attentionEventData(it)})
	}
}

func attentionEventData(it AttentionItem) map[string]any {
	d := map[string]any{"key": it.Key, "revision": it.Revision, "kind": it.Kind, "status": it.Status}
	if it.Session != "" {
		d["session"] = it.Session
	}
	if it.ClosedReason != "" {
		d["closed_reason"] = it.ClosedReason
	}
	if !it.SnoozedUntil.IsZero() {
		d["snoozed_until"] = it.SnoozedUntil
	}
	return d
}
