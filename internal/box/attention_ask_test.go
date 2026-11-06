package box

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// An agent's ask goes to its session's key, so a second replaces the first;
// the box refuses a kind it doesn't know and any field it doesn't name, and
// a person's answer comes back to the agent as a prompt, held until it is
// idle, once.
func TestAnAgentsAskReplacesItsLastAndItsAnswerComesBackAsAPrompt(t *testing.T) {
	turns := &Turns{InboxPath: filepath.Join(t.TempDir(), "inbox.json")}
	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		b.Turns = turns
		b.Attention = &AttentionStore{Path: filepath.Join(t.TempDir(), "attention.json")}
		bx = b
	})
	turns.Attach(bus)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go turns.Run(ctx, bx)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "shop", "path": repo}, nil)
	fake := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(fake, []byte("#!/bin/sh\nexec cat\n"), 0o755)
	var sess Session
	call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "shop", "name": "agent", "command": fake}, &sess)
	hook(bus, "agent.ready", "agent", sess.Dir, "claude")
	hook(bus, "agent.started", "agent", sess.Dir, "claude", "signal", "prompt") // busy

	var first, second AttentionItem
	if st := call(t, c, "POST", "/v1/sessions/agent/attention", "mcp", map[string]any{
		"kind": "decision", "title": "Ship acme on Friday?", "details": "The freeze starts Monday.",
		"options": []map[string]string{{"label": "Friday"}, {"label": "Monday", "description": "after the freeze"}}, "recommended": "Friday",
	}, &first); st != 200 || first.Key != "session:agent" || first.Revision != 1 || first.Session != "agent" || first.By != "mcp" || len(first.Options) != 2 {
		t.Fatalf("first ask = %d %+v", st, first)
	}
	if st := call(t, c, "POST", "/v1/sessions/agent/attention", "mcp", map[string]any{"kind": "ready", "title": "PR #12 is ready to merge"}, &second); st != 200 || second.Key != first.Key || second.Revision != 2 || second.Kind != "ready" || len(second.Options) != 0 || second.Details != "" {
		t.Fatalf("second ask = %d %+v", st, second)
	}
	if all := listOf(t, bx.Attention, AttentionFilter{}); len(all) != 1 {
		t.Fatalf("a repeated ask added an item: %+v", all)
	}

	// Refused, and nothing changes.
	for name, body := range map[string]any{
		"a kind it doesn't know":  map[string]any{"kind": "review", "title": "t"},
		"the box's own kind":      map[string]any{"kind": "mark", "title": "t"},
		"a field it doesn't name": map[string]any{"kind": "ready", "title": "t", "url": "https://acme.test/merge"},
		"a key of its own":        map[string]any{"kind": "ready", "title": "t", "key": "someone-else"},
		"an option's extra field": map[string]any{"kind": "decision", "title": "t", "options": []map[string]string{{"label": "Merge", "command": "gh pr merge 12"}}},
		"options on a ready":      map[string]any{"kind": "ready", "title": "t", "options": []map[string]string{{"label": "Merge"}}},
		"a recommendation alone":  map[string]any{"kind": "decision", "title": "t", "recommended": "Merge"},
		"no title":                map[string]any{"kind": "blocked"},
		"another session's":       nil,
	} {
		path := "/v1/sessions/agent/attention"
		if body == nil {
			path, body = "/v1/sessions/nobody/attention", map[string]any{"kind": "blocked", "title": "t"}
		}
		if st := call(t, c, "POST", path, "mcp", body, nil); st < 400 || st >= 500 {
			t.Errorf("%s: %d", name, st)
		}
	}
	var refused map[string]string
	if st := call(t, c, "POST", "/v1/sessions/agent/attention", "mcp", map[string]any{"kind": "ready", "title": "t", "url": "https://acme.test"}, &refused); st != 400 || refused["error"] != "url isn't something this takes" {
		t.Fatalf("an unknown field: %d %v", st, refused)
	}
	if it, _ := getOf(t, bx.Attention, "session:agent"); it.Revision != 2 {
		t.Fatalf("a refused ask changed the item: %+v", it)
	}

	queued := func() []QueuedPrompt {
		t.Helper()
		var q []QueuedPrompt
		call(t, c, "GET", "/v1/sessions/agent/queue", "", nil, &q)
		return q
	}
	// The agent is told in the background, after the PATCH answers.
	queuedN := func(n int) []QueuedPrompt {
		t.Helper()
		var q []QueuedPrompt
		for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
			if q = queued(); len(q) >= n {
				break
			}
		}
		return q
	}
	keyPath := "/v1/attention/" + url.PathEscape("session:agent")

	// A snooze is no answer: the agent hears nothing.
	call(t, c, "PATCH", keyPath, "app", map[string]any{"snoozed_until": "2026-11-07T09:00:00Z"}, nil)
	if q := queuedN(1); len(q) != 0 {
		t.Fatalf("a snooze told the agent: %+v", q)
	}
	// The answer is held for the busy agent, with the ask it answers.
	var answered AttentionItem
	call(t, c, "PATCH", keyPath, "app", map[string]any{"answer": "Merge it after the demo"}, &answered)
	q := queuedN(1)
	if len(q) != 1 || !strings.Contains(q[0].Preview, "answered your ask") || !strings.Contains(q[0].Preview, `"PR #12 is ready to merge"`) || !strings.Contains(q[0].Preview, "Merge it after the demo") {
		t.Fatalf("queue after the answer = %+v", q)
	}
	// A change to a settled ask tells it nothing more.
	call(t, c, "PATCH", keyPath, "app", map[string]any{"answer": "Merge it now"}, nil)
	if q := queuedN(2); len(q) != 1 {
		t.Fatalf("a second answer told it again: %+v", q)
	}
	// Reopened and closed without an answer: it hears that too.
	call(t, c, "PATCH", keyPath, "app", map[string]any{"status": "open"}, nil)
	call(t, c, "PATCH", keyPath, "phone", map[string]any{"status": "closed"}, nil)
	q = queuedN(2)
	if len(q) != 2 || !strings.Contains(q[1].Preview, "closed your ask") || !strings.Contains(q[1].Preview, "(resolved)") {
		t.Fatalf("queue after the close = %+v", q)
	}
	// A mark about the session is the person's own note: nothing to tell.
	call(t, c, "PATCH", "/v1/attention/"+url.PathEscape("devbox/agent#1"), "app", map[string]any{"session": "agent", "status": "closed"}, nil)
	if q := queuedN(3); len(q) != 2 {
		t.Fatalf("a mark told the agent: %+v", q)
	}
}

func TestAnswerTextNamesTheAsk(t *testing.T) {
	it := AttentionItem{Kind: "decision", Title: "Ship\nacme?", Status: AttentionAnswered, Answer: "Friday"}
	if got := AnswerText(it); got != `The user answered your ask in Shipyard (decision: "Ship acme?"): Friday` {
		t.Fatal(got)
	}
	it.Answer = ""
	if got := AnswerText(it); !strings.Contains(got, "as answered") {
		t.Fatal(got)
	}
	it.Status, it.ClosedReason = AttentionClosed, "resolved"
	if got := AnswerText(it); !strings.Contains(got, "without answering it (resolved)") {
		t.Fatal(got)
	}
}
