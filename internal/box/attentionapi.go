package box

import (
	"context"
	"errors"
	"net/http"

	"github.com/cosscom/shipyard/internal/events"
)

// The attention API (attention.go):
//
//	GET   /v1/attention?session=S&open=1  the items, the most recently changed first
//	POST  /v1/attention                   post an ask, or replace the one at its key
//	GET   /v1/attention/{key}             one item
//	PATCH /v1/attention/{key}             answer, close, reopen or snooze one; a key
//	                                      with no item gets a mark
//
// A key is path-escaped (encodeURIComponent), so it may hold slashes.
// Events say what changed and never an item's words: attention.posted,
// attention.updated and attention.settled carry key, revision, kind,
// status, session and, when set, closed_reason and snoozed_until.

func (b *Box) mountAttention(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("GET /v1/attention", b.listAttention)
	route("POST /v1/attention", b.postAttention)
	route("GET /v1/attention/{key...}", b.getAttention)
	route("PATCH /v1/attention/{key...}", b.updateAttention)
}

var errNoAttention = httpError{http.StatusNotImplemented, "this box keeps no attention items"}

func (b *Box) listAttention(w http.ResponseWriter, r *http.Request) error {
	if b.Attention == nil {
		return errNoAttention
	}
	q := r.URL.Query()
	writeJSON(w, b.Attention.List(AttentionFilter{Session: q.Get("session"), Open: q.Get("open") == "1"}))
	return nil
}

func (b *Box) getAttention(w http.ResponseWriter, r *http.Request) error {
	if b.Attention == nil {
		return errNoAttention
	}
	it, ok := b.Attention.Get(r.PathValue("key"))
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
	// An ask about a session settles when it ends, so it must be one that
	// runs.
	if p.Session != "" && b.Sessions != nil {
		if _, err := b.Sessions.Get(r.Context(), p.Session); err != nil {
			if errors.Is(err, ErrUnknownSession) {
				return httpError{http.StatusNotFound, "no session named " + p.Session + " on this box"}
			}
			return err
		}
	}
	key := p.Key
	if key == "" && p.Session != "" {
		key = SessionKey(p.Session)
	}
	if err := b.before(r, "attention.post", map[string]any{"key": key, "kind": p.Kind, "session": p.Session}); err != nil {
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
	it, _, err := b.Attention.Update(key, u, origin(r))
	if err != nil {
		return err
	}
	b.publish(r, "attention.updated", attentionEventData(it))
	writeJSON(w, it)
	return nil
}

// sweepAttention settles the items of sessions that ended, given the
// sessions there are, and forgets items past their time.
func (b *Box) sweepAttention(all []Session) {
	if b.Attention == nil {
		return
	}
	live := make(map[string]bool, len(all))
	for _, s := range all {
		if !s.Exited {
			live[s.Name] = true
		}
	}
	for _, it := range b.Attention.Sweep(live) {
		b.Events.Publish(events.Event{Type: "attention.settled", Box: b.Name, Origin: "berth", Data: attentionEventData(it)})
	}
}

// attentionSessionsEnded sweeps at once after sessions were stopped, rather
// than at the next refresh.
func (b *Box) attentionSessionsEnded(ctx context.Context) {
	if b.Attention == nil || b.Sessions == nil {
		return
	}
	if all, err := b.Sessions.List(ctx); err == nil {
		b.sweepAttention(all)
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
