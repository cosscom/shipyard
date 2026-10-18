package box

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations"
)

// ledger is a turn ledger following a sequenced bus, with sessions tracked
// as berth would have started them.
func ledger(t *testing.T, sessions ...Session) (*Turns, *events.Bus) {
	t.Helper()
	tr := &Turns{}
	bus := &events.Bus{Sequence: true}
	tr.Attach(bus)
	for _, s := range sessions {
		bus.Publish(events.Event{Type: "session.started", Data: map[string]any{"name": s.Name, "path": s.Dir, "agent": s.Agent}})
	}
	return tr, bus
}

func hook(bus *events.Bus, typ, session, path, agent string, extra ...string) events.Event {
	d := map[string]any{"path": path, "agent": agent}
	if session != "" {
		d["session"] = session
	}
	for i := 0; i+1 < len(extra); i += 2 {
		d[extra[i]] = extra[i+1]
	}
	return bus.Publish(events.Event{Type: typ, Origin: agent, Data: d})
}

func turnState(t *testing.T, tr *Turns, id string) string {
	t.Helper()
	got, ok := tr.Get(id)
	if !ok {
		t.Fatalf("no turn %s", id)
	}
	return got.State
}

// E3: a prompt sent while the agent is mid-turn is queued by the agent.
// The current turn's Stop ends that turn, not the new one, which starts at
// the next UserPromptSubmit and ends at the Stop after it.
func TestASendDuringATurnWaitsForItsOwnTurn(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "shop-feat-a-claude", Dir: "/srv/shop/feat-a", Agent: "claude"})
	s := "shop-feat-a-claude"
	hook(bus, "agent.ready", s, "/srv/shop/feat-a", "claude")
	hook(bus, "agent.started", s, "/srv/shop/feat-a", "claude", "signal", "prompt") // typed by a person
	sent := bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": s, "from": "laptop:devl"}})
	mine, ok := tr.ForSent(s, sent.Seq)
	if !ok || mine.State != "pending" || mine.ID != s+"#2" || mine.Origin != "laptop:devl" {
		t.Fatalf("sent turn = %+v %v", mine, ok)
	}
	done := make(chan Turn, 1)
	go func() {
		got, _, _ := tr.WaitTurn(context.Background(), mine.ID, true)
		done <- got
	}()
	hook(bus, "agent.finished", s, "/srv/shop/feat-a", "claude") // the person's turn
	if st := turnState(t, tr, s+"#1"); st != "finished" {
		t.Fatalf("the running turn is %s", st)
	}
	select {
	case got := <-done:
		t.Fatalf("the previous turn's Stop ended the wait: %+v", got)
	case <-time.After(100 * time.Millisecond):
	}
	hook(bus, "agent.started", s, "/srv/shop/feat-a", "claude", "signal", "prompt") // ours, dequeued
	hook(bus, "agent.started", s, "/srv/shop/feat-a", "claude", "signal", "tool")
	if st := turnState(t, tr, mine.ID); st != "running" {
		t.Fatalf("our turn is %s after its prompt started", st)
	}
	hook(bus, "agent.finished", s, "/srv/shop/feat-a", "claude")
	select {
	case got := <-done:
		if got.ID != mine.ID || got.State != "finished" || got.Fidelity != "hooks" {
			t.Fatalf("wait = %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the wait never ended")
	}
}

// E4: an approval clears waiting when the tool it allowed runs.
func TestApprovalClosesTheWaitSpan(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "s", Dir: "/w", Agent: "claude"})
	hook(bus, "agent.ready", "s", "/w", "claude")
	hook(bus, "agent.started", "s", "/w", "claude", "signal", "prompt")
	hook(bus, "agent.waiting", "s", "/w", "claude", "reason", "permission")
	if st, _ := tr.State("s"); st.State != "waiting" {
		t.Fatalf("state = %+v", st)
	}
	hook(bus, "agent.started", "s", "/w", "claude", "signal", "tool")
	got, _ := tr.Get("s#1")
	if st, _ := tr.State("s"); st.State != "running" || got.State != "running" || len(got.Waits) != 1 || got.Waits[0].End.IsZero() || got.Waits[0].Reason != "permission" {
		t.Fatalf("after approval: %+v %+v", st, got)
	}
	// A tool use while working changes nothing, so the box does not
	// publish it.
	if !tr.Redundant("agent.started", map[string]any{"session": "s", "signal": "tool"}) {
		t.Fatal("a tool use while running was not redundant")
	}
}

// E6: two agents in one worktree. Each one's hooks name its session, and
// old hooks that only give a folder end no wait unless one agent fits.
func TestAgentsSharingAWorktreeKeepTheirOwnTurns(t *testing.T) {
	dir := "/srv/shop/feat-a"
	tr, bus := ledger(t,
		Session{Name: "claude-1", Dir: dir, Agent: "claude"},
		Session{Name: "codex-1", Dir: dir, Agent: "codex"},
		Session{Name: "claude-2", Dir: dir, Agent: "claude"})
	for _, s := range []string{"claude-1", "claude-2"} {
		hook(bus, "agent.ready", s, dir, "claude")
	}
	hook(bus, "agent.started", "claude-1", dir, "claude", "signal", "prompt")
	// A second agent starting does not make the first one idle.
	hook(bus, "agent.ready", "claude-2", dir, "claude")
	if st, _ := tr.State("claude-1"); st.State != "running" {
		t.Fatalf("claude-1 = %+v", st)
	}
	// The reviewer finishing ends its own turn, not Claude's.
	bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "codex-1"}})
	hook(bus, "agent.finished", "codex-1", dir, "codex")
	if st := turnState(t, tr, "claude-1#1"); st != "running" {
		t.Fatalf("claude-1's turn = %s after the reviewer finished", st)
	}
	if st := turnState(t, tr, "codex-1#1"); st != "finished" {
		t.Fatalf("codex-1's turn = %s", st)
	}
	// An old hook with only the folder: one codex there, so it is that one.
	bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "codex-1"}})
	hook(bus, "agent.finished", "", dir, "codex")
	if st := turnState(t, tr, "codex-1#2"); st != "finished" {
		t.Fatalf("a folder-only codex hook did not reach the one codex: %s", st)
	}
	// Two Claudes there: ambiguous, recorded, and no turn ends.
	hook(bus, "agent.finished", "", dir, "claude")
	if st := turnState(t, tr, "claude-1#1"); st != "running" {
		t.Fatalf("an ambiguous hook ended claude-1's turn: %s", st)
	}
	if tr.Ambiguous.Load() != 1 {
		t.Fatalf("ambiguous = %d", tr.Ambiguous.Load())
	}
	hook(bus, "agent.finished", "claude-1", dir, "claude")
	if st := turnState(t, tr, "claude-1#1"); st != "finished" {
		t.Fatalf("claude-1 = %s", st)
	}
}

// E8: agents that cannot say they started (Codex's notify, Cursor without
// its newer hooks) start their turn at the send, so they read as working
// and their next finished ends it.
func TestAFinishedOnlyAgentWorksFromTheSend(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "cx", Dir: "/w", Agent: "codex"})
	hook(bus, "agent.finished", "cx", "/w", "codex", "via", "notify") // an earlier turn
	sent := bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "cx"}})
	mine, _ := tr.ForSent("cx", sent.Seq)
	if st, _ := tr.State("cx"); mine.State != "running" || mine.Fidelity != "partial" || st.State != "running" {
		t.Fatalf("after send: turn %+v, session %+v", mine, st)
	}
	hook(bus, "agent.finished", "cx", "/w", "codex", "via", "notify")
	if st := turnState(t, tr, mine.ID); st != "finished" {
		t.Fatalf("turn = %s", st)
	}
	// Once its hooks say a prompt started, sends wait for that instead.
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "prompt")
	hook(bus, "agent.finished", "cx", "/w", "codex")
	sent = bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "cx"}})
	if next, _ := tr.ForSent("cx", sent.Seq); next.State != "pending" {
		t.Fatalf("with prompt hooks, a send is %s", next.State)
	}
}

// Codex's notify comes at the end of each of its messages, not only the
// turn's. Once its hooks said a prompt started, Stop alone ends the turn,
// and the notify is not published; a Codex without hooks still ends its
// turn with notify.
func TestCodexNotifyEndsATurnOnlyWithoutHooks(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "cx", Dir: "/w", Agent: "codex"}, Session{Name: "old", Dir: "/v", Agent: "codex"})
	hook(bus, "agent.ready", "cx", "/w", "codex")
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "prompt")
	if !tr.Redundant("agent.finished", map[string]any{"session": "cx", "via": "notify"}) {
		t.Fatal("a hooked Codex's notify would be published")
	}
	hook(bus, "agent.finished", "cx", "/w", "codex", "via", "notify") // its first message
	if st, _ := tr.State("cx"); st.State != "running" || turnState(t, tr, "cx#1") != "running" {
		t.Fatalf("after a notify mid-turn: session %+v, turn %s", st, turnState(t, tr, "cx#1"))
	}
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "tool")
	hook(bus, "agent.finished", "cx", "/w", "codex") // Stop
	if st, _ := tr.State("cx"); st.State != "finished" || turnState(t, tr, "cx#1") != "finished" {
		t.Fatalf("after Stop: session %+v, turn %s", st, turnState(t, tr, "cx#1"))
	}
	if tr.Redundant("agent.finished", map[string]any{"session": "cx"}) {
		t.Fatal("Stop would not be published")
	}

	sent := bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "old"}})
	mine, _ := tr.ForSent("old", sent.Seq)
	if tr.Redundant("agent.finished", map[string]any{"session": "old", "via": "notify"}) {
		t.Fatal("the notify of a Codex without hooks would not be published")
	}
	hook(bus, "agent.finished", "old", "/v", "codex", "via", "notify")
	if st := turnState(t, tr, mine.ID); st != "finished" {
		t.Fatalf("without hooks, notify left the turn %s", st)
	}
}

// Codex's question box is a tool: its PreToolUse makes the turn wait, and
// the PostToolUse once it is answered has it running again. Any other tool
// use after a turn ended (Codex carrying on by itself once a background
// command finishes) shows the agent working.
func TestACodexQuestionWaitsUntilItIsAnswered(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "cx", Dir: "/w", Agent: "codex"})
	hook(bus, "agent.ready", "cx", "/w", "codex")
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "prompt")
	hook(bus, "agent.waiting", "cx", "/w", "codex", "reason", "question") // PreToolUse request_user_input_async
	got, _ := tr.Get("cx#1")
	if st, _ := tr.State("cx"); st.State != "waiting" || got.State != "waiting" || len(got.Waits) != 1 || got.Waits[0].Reason != "question" {
		t.Fatalf("asking: session %+v, turn %+v", st, got)
	}
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "tool") // PostToolUse, answered
	got, _ = tr.Get("cx#1")
	if st, _ := tr.State("cx"); st.State != "running" || got.State != "running" || got.Waits[0].End.IsZero() {
		t.Fatalf("answered: session %+v, turn %+v", st, got)
	}
	hook(bus, "agent.finished", "cx", "/w", "codex")
	if tr.Redundant("agent.started", map[string]any{"session": "cx", "signal": "tool"}) {
		t.Fatal("a tool use after the turn ended would not be published")
	}
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "tool") // PreToolUse Bash
	if st, _ := tr.State("cx"); st.State != "running" {
		t.Fatalf("a tool use after the turn ended left the session %+v", st)
	}
	if all := tr.List("cx", 10); len(all) != 1 || all[0].State != "finished" {
		t.Fatalf("a tool use made or reopened a turn: %+v", all)
	}
}

// Codex asks with its async question box and ends its turn: the turn is
// over, but the session still waits for the answer, until you prompt again.
func TestATurnThatEndsOnItsQuestionStillWaits(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "cx", Dir: "/w", Agent: "codex"})
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "prompt")
	hook(bus, "agent.waiting", "cx", "/w", "codex", "reason", "question", "question_box", "async")
	// The question box redraws the screen; that is not an answer.
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "tool", "source", "screen")
	hook(bus, "agent.finished", "cx", "/w", "codex")
	got, _ := tr.Get("cx#1")
	if st, _ := tr.State("cx"); st.State != "waiting" || got.State != "finished" {
		t.Fatalf("ended on its question: session %+v, turn %+v", st, got)
	}
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "prompt")
	if st, _ := tr.State("cx"); st.State != "running" {
		t.Fatalf("answered: session %+v", st)
	}
	// Work after the question means it may have been answered: the end is an end.
	hook(bus, "agent.waiting", "cx", "/w", "codex", "reason", "question", "question_box", "async")
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "tool")
	hook(bus, "agent.finished", "cx", "/w", "codex")
	if st, _ := tr.State("cx"); st.State != "finished" {
		t.Fatalf("worked on after asking: session %+v", st)
	}
	// A question that blocks the turn (Plan mode's, or a structured
	// driver's) is answered within it, so its turn's end is an end.
	hook(bus, "agent.started", "cx", "/w", "codex", "signal", "prompt")
	hook(bus, "agent.waiting", "cx", "/w", "codex", "reason", "question")
	hook(bus, "agent.finished", "cx", "/w", "codex")
	if st, _ := tr.State("cx"); st.State != "finished" {
		t.Fatalf("ended after a blocking question: session %+v", st)
	}
}

// E13: an agent finishes while berthd is down. Its hook is spooled, and
// published when berthd is back, so the turn ends; with no spooled hook,
// the open turn is left for the screen to settle.
func TestATurnThatEndedWhileBerthdWasDownIsSettled(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "turns.json")
	spool := filepath.Join(dir, "spool")
	first := &Turns{Path: path}
	bus := &events.Bus{Sequence: true}
	first.Attach(bus)
	bus.Publish(events.Event{Type: "session.started", Data: map[string]any{"name": "a", "path": "/w/a", "agent": "claude"}})
	bus.Publish(events.Event{Type: "session.started", Data: map[string]any{"name": "b", "path": "/w/b", "agent": "claude"}})
	for _, s := range []string{"a", "b"} {
		hook(bus, "agent.ready", s, "/w/"+s, "claude")
		hook(bus, "agent.started", s, "/w/"+s, "claude", "signal", "prompt")
	}
	first.save()

	// berthd is down: a's Stop goes to the spool.
	integrations.Spool(spool, events.Event{Type: "agent.finished", Origin: "claude", Data: map[string]any{"session": "a", "path": "/w/a", "agent": "claude"}})

	second := &Turns{Path: path}
	bus2 := &events.Bus{Sequence: true}
	second.Attach(bus2)
	if open := second.openForScreen(); len(open) != 2 {
		t.Fatalf("open after restart = %v", open)
	}
	integrations.DrainSpool(spool, func(e events.Event) { bus2.Publish(e) })
	if st := turnState(t, second, "a#1"); st != "finished" {
		t.Fatalf("a#1 = %s after the spool drained", st)
	}
	if open := second.openForScreen(); len(open) != 1 || open[0] != "b" {
		t.Fatalf("left for the screen: %v", open)
	}
}

// Memory stays bounded: turns per session, the inbox, and sessions that
// ended are dropped.
func TestTheLedgerStaysBounded(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "s", Dir: "/w", Agent: "codex"})
	tr.ArchivePath = filepath.Join(t.TempDir(), "archive.jsonl")
	for range 120 {
		bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "s"}})
		hook(bus, "agent.finished", "s", "/w", "codex")
	}
	tr.mu.Lock()
	kept := len(tr.sess["s"].Turns)
	tr.mu.Unlock()
	if kept != maxTurnsKept {
		t.Fatalf("kept %d turns in memory", kept)
	}
	tr.save()
	if all := tr.List("s", 200); len(all) != 120 || all[0].ID != "s#1" || all[119].ID != "s#120" {
		t.Fatalf("listed %d turns from memory and the archive", len(all))
	}
	for i := range maxInbox + 1 {
		bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "s"}}) // busy
		_, err := tr.Queue("s", fmt.Sprint("prompt ", i), true, "laptop:devl", "")
		if i == maxInbox && err != ErrInboxFull {
			t.Fatalf("queued past the cap: %v", err)
		}
	}
	tr.mu.Lock()
	last := fmt.Sprintf("s#%d", tr.sess["s"].N)
	tr.mu.Unlock()
	tr.Prune(nil)
	if _, ok := tr.State("s"); ok {
		t.Fatal("an ended session was kept")
	}
	// Its last turn stays for a waiter, ended with the session.
	if got, ok := tr.Get(last); !ok || got.State != "exited" {
		t.Fatalf("the last turn of an ended session = %+v", got)
	}
}

// The API: send returns its turn and the box's time, refuses to type into
// an agent that waits for someone unless forced, holds when:"idle" prompts
// until the agent is idle, and turn waits need no clock.
func TestSendTurnsInboxAndTurnWaitsOverTheAPI(t *testing.T) {
	turns := &Turns{}
	var bx *Box
	c, bus := servedBox(t, func(b *Box) { b.Turns = turns; bx = b })
	turns.Attach(bus)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go turns.Run(ctx, bx)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "shop", "path": repo}, nil)
	bin := t.TempDir()
	fake := filepath.Join(bin, "claude")
	os.WriteFile(fake, []byte("#!/bin/sh\nexec cat\n"), 0o755)
	var sess Session
	call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "shop", "name": "agent", "command": fake}, &sess)
	if sess.Agent != "claude" {
		t.Fatalf("session = %+v", sess)
	}
	hook(bus, "agent.ready", "agent", sess.Dir, "claude")

	var res SendResult
	if st := call(t, c, "POST", "/v1/sessions/agent/send", "", SendRequest{Text: "fix the build", When: "now", IdemKey: "run-1/round-1"}, &res); st != 200 || res.Turn != "agent#1" || res.Seq == 0 || res.At.IsZero() {
		t.Fatalf("send: %d %+v", st, res)
	}
	// A retry with the same key does not type it again.
	var again SendResult
	call(t, c, "POST", "/v1/sessions/agent/send", "", SendRequest{Text: "fix the build", When: "now", IdemKey: "run-1/round-1"}, &again)
	if !again.Duplicate || again.Turn != "agent#1" {
		t.Fatalf("retry = %+v", again)
	}
	var w TurnWait
	call(t, c, "GET", "/v1/turns/agent%231/wait?timeout=1s", "", nil, &w)
	if !w.TimedOut || w.State != "pending" {
		t.Fatalf("wait on a pending turn = %+v", w)
	}

	hook(bus, "agent.started", "agent", sess.Dir, "claude", "signal", "prompt")
	hook(bus, "agent.waiting", "agent", sess.Dir, "claude", "reason", "permission")
	var refused map[string]string
	if st := call(t, c, "POST", "/v1/sessions/agent/send", "", SendRequest{Text: "y", When: "now"}, &refused); st != 409 || !strings.Contains(refused["error"], "waiting") {
		t.Fatalf("send to a waiting agent: %d %v", st, refused)
	}
	// when:"idle" holds it, even while the agent waits.
	var held SendResult
	call(t, c, "POST", "/v1/sessions/agent/send", "", SendRequest{Text: "then write the docs", When: "idle"}, &held)
	if !held.Queued || held.Turn != "agent#2" {
		t.Fatalf("idle send = %+v", held)
	}
	call(t, c, "GET", "/v1/turns/agent%231/wait?until=waiting&timeout=5s", "", nil, &w)
	if w.TimedOut || w.State != "waiting" {
		t.Fatalf("until=waiting = %+v", w)
	}
	hook(bus, "agent.started", "agent", sess.Dir, "claude", "signal", "tool")
	hook(bus, "agent.finished", "agent", sess.Dir, "claude")
	call(t, c, "GET", "/v1/turns/agent%231/wait?timeout=5s", "", nil, &w)
	if w.TimedOut || w.State != "finished" || w.Turn.ID != "agent#1" {
		t.Fatalf("wait = %+v", w)
	}
	// Now idle: the held prompt is typed, and its turn is pending.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if got, _ := turns.Get("agent#2"); got.State == "pending" && got.SentSeq > 0 {
			break
		}
		if time.Now().After(deadline) {
			got, _ := turns.Get("agent#2")
			t.Fatalf("the held prompt was not delivered: %+v", got)
		}
		time.Sleep(50 * time.Millisecond)
	}
	var list []Turn
	call(t, c, "GET", "/v1/sessions/agent/turns?limit=10", "", nil, &list)
	if len(list) != 2 || list[0].IdemKey != "run-1/round-1" {
		t.Fatalf("turns = %+v", list)
	}
	// An old client's wait, with a time ahead of the box's clock (E10):
	// placed in the journal's order, it still sees the turn end.
	hook(bus, "agent.started", "agent", sess.Dir, "claude", "signal", "prompt")
	go func() {
		time.Sleep(300 * time.Millisecond)
		hook(bus, "agent.finished", "agent", sess.Dir, "claude")
	}()
	var old WaitResult
	call(t, c, "GET", "/v1/sessions/agent/wait?for=finished&timeout=5s&after="+time.Now().Add(10*time.Second).UTC().Format(time.RFC3339Nano), "", nil, &old)
	if old.TimedOut || old.State != "finished" {
		t.Fatalf("a wait from a fast clock = %+v", old)
	}
}

// A person answering a question (forced, or from the phone) does not start
// a turn: the turn that asked goes on.
func TestAnAnswerIsPartOfTheTurnThatAsked(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "s", Dir: "/w", Agent: "claude"})
	hook(bus, "agent.ready", "s", "/w", "claude")
	hook(bus, "agent.started", "s", "/w", "claude", "signal", "prompt")
	hook(bus, "agent.waiting", "s", "/w", "claude")
	bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "s", "answer": true, "turn": "s#1"}})
	if all := tr.List("s", 10); len(all) != 1 {
		t.Fatalf("an answer made a turn: %+v", all)
	}
}

// A prompt the agent never started (two pastes read as one) ends "lost"
// after a while, so waits return and the inbox moves on.
func TestPendingTurnsThatNeverStartExpire(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "agent", Dir: "/w", Agent: "claude"})
	hook(bus, "agent.ready", "agent", "/w", "claude")
	sent := func() events.Event {
		return bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "agent"}})
	}
	sent()
	sent()
	hook(bus, "agent.started", "agent", "/w", "claude", "signal", "prompt")
	hook(bus, "agent.finished", "agent", "/w", "claude")
	if got := turnState(t, tr, "agent#2"); got != "pending" {
		t.Fatalf("second turn %s", got)
	}
	if n := tr.Expire(time.Now()); n != 0 {
		t.Fatal("expired too soon")
	}
	if n := tr.Expire(time.Now().Add(PendingExpiry + time.Second)); n != 1 || turnState(t, tr, "agent#2") != "lost" {
		t.Fatalf("expired %d, state %s", n, turnState(t, tr, "agent#2"))
	}
	if !tr.Ready("agent") {
		t.Fatal("the agent is still not ready for a prompt")
	}
}

// A new agent in a folder where another agent last waited starts without
// that state: the folder's "waiting" from before it began is not its own.
func TestANewSessionDoesNotInheritAnOlderFolderState(t *testing.T) {
	turns := &Turns{}
	bus := &events.Bus{Sequence: true}
	turns.Attach(bus)
	old := time.Now().Add(-time.Hour)
	// An agent berth didn't start reported from /w an hour ago.
	bus.Publish(events.Event{Type: "agent.waiting", Time: old, Data: map[string]any{"path": "/w", "agent": "claude"}})
	bus.Publish(events.Event{Type: "session.started", Time: time.Now(), Data: map[string]any{"name": "fresh", "path": "/w", "agent": "claude"}})
	if st, _ := turns.State("fresh"); st.State != "" {
		t.Fatalf("a new session took the folder's old state: %+v", st)
	}
}

// screenPoll is one poll of the screen adapter over a session showing
// screen: it publishes what the screen reports, as pollScreens does.
func screenPoll(tr *Turns, bus *events.Bus, name, screen string) {
	if typ, data := tr.screenEvent(name, screen); typ != "" {
		bus.Publish(events.Event{Type: typ, Origin: "screen", Data: data})
	}
}

// Claude Code's question form (AskUserQuestion) at the bottom of its pane.
var claudeQuestion = strings.Join([]string{
	"⏺ Before I start, one question about the rollout.",
	"",
	" ☐ Rollout",
	"",
	"Ship it behind a flag?",
	"",
	"❯ 1. Yes",
	"     Behind a flag",
	"  2. No",
	"     For everyone at once",
	"  3. Type something.",
	"  4. Chat about this",
	"",
	"Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
}, "\n")

// A worker started with its first prompt: the prompt is sent before its
// hooks have said anything, so its turn starts as one the screen ends. Then
// its hooks report a question. The screen used to read no question there,
// end the wait as if answered and, once quiet, the turn: the card read
// Done while the agent asked. Whatever the screen shows, a wait the hooks
// reported is theirs to end, and so is the turn.
func TestAWaitTheHooksReportedIsNotEndedByTheScreen(t *testing.T) {
	for _, shown := range []struct{ name, screen string }{
		{"its question", claudeQuestion},
		{"a question the screen cannot read", "⏺ Which region should the job run in?\n\n  waiting…"},
	} {
		t.Run(shown.name, func(t *testing.T) {
			s := "acme-feat-claude"
			tr, bus := ledger(t, Session{Name: s, Dir: "/w/feat", Agent: "claude"})
			sent := bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": s, "from": "berth"}})
			mine, _ := tr.ForSent(s, sent.Seq)
			if mine.State != "running" || mine.Fidelity != "screen" {
				t.Fatalf("first prompt: %+v", mine)
			}
			hook(bus, "agent.waiting", s, "/w/feat", "claude", "reason", "permission")
			screenPoll(tr, bus, s, "⏺ Reading the issue…")
			for range screenQuiet + 2 {
				screenPoll(tr, bus, s, shown.screen)
			}
			got, _ := tr.Get(mine.ID)
			if st, _ := tr.State(s); st.State != "waiting" || got.State != "waiting" || len(got.Waits) != 1 || !got.Waits[0].End.IsZero() {
				t.Fatalf("the screen settled the hooks' wait: session %+v, turn %+v", st, got)
			}
			// Its hooks speak for it now: the screen no longer has to.
			if open := tr.openForScreen(); len(open) != 0 {
				t.Fatalf("still left for the screen: %v", open)
			}
			hook(bus, "agent.started", s, "/w/feat", "claude", "signal", "tool") // answered
			for range screenQuiet + 2 {
				screenPoll(tr, bus, s, "⏺ Adding the flag…")
			}
			if st := turnState(t, tr, mine.ID); st != "running" {
				t.Fatalf("after the answer, a quiet screen left the turn %s", st)
			}
			hook(bus, "agent.finished", s, "/w/feat", "claude")
			if got, _ := tr.Get(mine.ID); got.State != "finished" || got.Fidelity != "partial" || got.Waits[0].End.IsZero() {
				t.Fatalf("after its Stop: %+v", got)
			}
		})
	}
}

// A wait the hooks reported before berthd restarted is still theirs: the
// screen, settling the turns left open, does not call it finished.
func TestAWaitOpenAcrossARestartIsNotFinishedByTheScreen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "turns.json")
	first := &Turns{Path: path}
	bus := &events.Bus{Sequence: true}
	first.Attach(bus)
	bus.Publish(events.Event{Type: "session.started", Data: map[string]any{"name": "a", "path": "/w/a", "agent": "claude"}})
	hook(bus, "agent.ready", "a", "/w/a", "claude")
	hook(bus, "agent.started", "a", "/w/a", "claude", "signal", "prompt")
	hook(bus, "agent.waiting", "a", "/w/a", "claude", "reason", "question")
	first.save()

	second := &Turns{Path: path}
	bus2 := &events.Bus{Sequence: true}
	second.Attach(bus2)
	for range screenQuiet + 2 {
		screenPoll(second, bus2, "a", "⏺ Which region should the job run in?")
	}
	if st := turnState(t, second, "a#1"); st != "waiting" {
		t.Fatalf("a#1 = %s", st)
	}
	hook(bus2, "agent.finished", "a", "/w/a", "claude")
	if st := turnState(t, second, "a#1"); st != "finished" {
		t.Fatalf("a#1 = %s after its Stop", st)
	}
}

// An agent without hooks: the screen reports its question, ends the wait
// when the question goes, and ends the turn when the screen is quiet.
func TestTheScreenEndsTheWaitsItReported(t *testing.T) {
	tr, bus := ledger(t, Session{Name: "x", Dir: "/w/x", Agent: "aider"})
	sent := bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "x"}})
	mine, _ := tr.ForSent("x", sent.Seq)
	screenPoll(tr, bus, "x", claudeQuestion)
	if got, _ := tr.Get(mine.ID); got.State != "waiting" || len(got.Waits) != 1 || got.Waits[0].Reason != "screen" {
		t.Fatalf("the question: %+v", got)
	}
	screenPoll(tr, bus, "x", "Adding the flag…")
	if got, _ := tr.Get(mine.ID); got.State != "running" || got.Waits[0].End.IsZero() {
		t.Fatalf("answered: %+v", got)
	}
	for range screenQuiet + 1 { // the first sees it anew
		screenPoll(tr, bus, "x", "Adding the flag…")
	}
	if got, _ := tr.Get(mine.ID); got.State != "finished" || got.Fidelity != "screen" {
		t.Fatalf("quiet: %+v", got)
	}
}

// The screen can see a question before the hook for it arrives: the wait
// is then the hooks' as well, and the screen leaves it to them.
func TestAWaitTheScreenSawFirstIsTheHooksOnceTheyReportIt(t *testing.T) {
	s := "acme-feat-claude"
	tr, bus := ledger(t, Session{Name: s, Dir: "/w/feat", Agent: "claude"})
	sent := bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": s, "from": "berth"}})
	mine, _ := tr.ForSent(s, sent.Seq)
	screenPoll(tr, bus, s, claudeQuestion)
	hook(bus, "agent.waiting", s, "/w/feat", "claude", "reason", "permission")
	for range screenQuiet + 2 {
		screenPoll(tr, bus, s, "⏺ Which region should the job run in?")
	}
	if got, _ := tr.Get(mine.ID); got.State != "waiting" || len(got.Waits) != 1 || !got.Waits[0].Hooked || !got.Waits[0].End.IsZero() {
		t.Fatalf("the screen settled a wait the hooks reported: %+v", got)
	}
}

// Codex's shared daemon runs every session's hooks with the BERTH_SESSION
// of the session that started it (cosscom/shipyard#8): here cx1's. An event
// from another session's directory goes by its directory, and a
// conversation a session holds is that session's whatever name its events
// carry. Claude's hooks are taken by name as before.
func TestACodexDaemonsHooksReachTheirOwnSession(t *testing.T) {
	tr, bus := ledger(t,
		Session{Name: "cx1", Dir: "/w/one", Agent: "codex"},
		Session{Name: "cx2", Dir: "/w/two", Agent: "codex"},
		Session{Name: "cx3", Dir: "/w/one", Agent: "codex"},
		Session{Name: "cl", Dir: "/w/cl", Agent: "claude"})
	state := func(name string) SessionState { st, _ := tr.State(name); return st }
	hook(bus, "agent.started", "cx1", "/w/one", "codex", "signal", "prompt", "agent_session_id", "t1")
	// cx2's turn, named cx1 by the daemon, from cx2's directory.
	hook(bus, "agent.started", "cx1", "/w/two", "codex", "signal", "prompt", "agent_session_id", "t2")
	if st := state("cx2"); st.State != "running" || st.AgentSessionID != "t2" {
		t.Fatalf("cx2 = %+v", st)
	}
	hook(bus, "agent.finished", "cx1", "/w/two", "codex", "agent_session_id", "t2")
	if cx1, cx2 := state("cx1"), state("cx2"); cx1.State != "running" || cx1.AgentSessionID != "t1" || cx2.State != "finished" {
		t.Fatalf("cx1 = %+v, cx2 = %+v", cx1, cx2)
	}
	// cx3 shares cx1's directory: once its own hooks named its conversation,
	// the daemon's events for it are its own.
	hook(bus, "agent.started", "cx3", "/w/one", "codex", "signal", "prompt", "agent_session_id", "t3")
	hook(bus, "agent.finished", "cx1", "/w/one", "codex", "agent_session_id", "t3")
	if cx1, cx3 := state("cx1"), state("cx3"); cx1.State != "running" || cx3.State != "finished" {
		t.Fatalf("cx1 = %+v, cx3 = %+v", cx1, cx3)
	}
	if got := tr.SessionOf(map[string]any{"session": "cx1", "agent": "codex", "path": "/w/two"}); got != "cx2" {
		t.Fatalf("SessionOf = %q", got)
	}
	hook(bus, "agent.started", "cl", "/w/elsewhere", "claude", "signal", "prompt")
	if st := state("cl"); st.State != "running" {
		t.Fatalf("claude by name: %+v", st)
	}
}
