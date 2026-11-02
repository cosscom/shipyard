package box

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/transcript"
)

type jevCall struct {
	path, auth string
	body       map[string]any
}

// checkedBox is a box with turn check on (or off) and a Claude Code session
// whose transcript holds prompt and reply. Its Jev is answer, on loopback.
func checkedBox(t *testing.T, enabled bool, prompt, reply string, answer http.HandlerFunc) (*Box, *events.Bus, Session, chan jevCall) {
	t.Helper()
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nexec sleep 600\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	t.Setenv("BERTH_TEST_JEV_KEY", "jev-test-key")
	calls := make(chan jevCall, 10)
	jev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &body)
		calls <- jevCall{path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body}
		answer(w, r)
	}))
	t.Cleanup(jev.Close)
	oldJev, oldDecisions := jevURL, decisionsURL
	jevURL, decisionsURL = jev.URL+"/v1/evaluate", jev.URL+"/v1/decisions"
	t.Cleanup(func() { jevURL, decisionsURL = oldJev, oldDecisions })

	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		b.Turns = &Turns{}
		b.Turns.Attach(b.Events)
		// The test's Jev is on loopback, which the box's owner must allow.
		b.Flows = &Flows{AllowOutbound: []string{"127.0.0.1"}}
		b.TurnCheck = &TurnCheck{Path: filepath.Join(t.TempDir(), "turncheck.json"), settle: 10 * time.Millisecond, timeout: 300 * time.Millisecond}
		bx = b
	})
	bx.TurnCheck.save(TurnCheckConfig{Enabled: enabled, Provider: ProviderGateway, Key: "env://BERTH_TEST_JEV_KEY", Model: "typesafe-ai/jev"})
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "shop", "path": gitRepo(t)}, nil)
	call(t, c, "POST", "/v1/locations/shop/worktrees", "", WorktreeRequest{Name: "fix"}, nil)
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", SessionRequest{Location: "shop/fix", Command: "claude"}, &sess); status != 200 {
		t.Fatalf("session: %d", status)
	}
	line := func(v map[string]any) string { b, _ := json.Marshal(v); return string(b) + "\n" }
	at := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	proj := transcript.ClaudeDir(sess.Dir)
	os.MkdirAll(proj, 0o755)
	rec := filepath.Join(proj, "conv.jsonl")
	appendTo(t, rec, line(map[string]any{"type": "user", "timestamp": at, "message": map[string]any{"role": "user", "content": prompt}}))
	appendTo(t, rec, line(map[string]any{"type": "assistant", "timestamp": at, "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": reply}}}}))

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go bx.TurnCheck.Run(ctx, bx)
	time.Sleep(50 * time.Millisecond)
	return bx, bus, sess, calls
}

// endTurn is a prompt typed at the terminal and its turn's end.
func endTurn(bus *events.Bus, s Session) {
	hook(bus, adapters.Started, s.Name, s.Dir, "claude", "signal", "prompt")
	hook(bus, adapters.Finished, s.Name, s.Dir, "claude")
}

func jevSays(choice string, p float64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"answers": map[string]any{"status": map[string]any{"choice": choice, "probabilities": map[string]float64{choice: p}}}})
	}
}

func waitCall(t *testing.T, calls chan jevCall) jevCall {
	t.Helper()
	select {
	case c := <-calls:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("Jev was never asked")
	}
	return jevCall{}
}

func stateNow(t *testing.T, b *Box, name string) string {
	t.Helper()
	st, _ := b.Turns.State(name)
	return st.State
}

// A turn that ends on a question shows as waiting, yet still takes prompts.
func TestTurnCheckMakesATurnThatAsksWait(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Both operators are in place. Should the filter default to AND or OR?", jevSays("needs_input", 0.92))
	ch, stop := bus.Subscribe()
	defer stop()
	endTurn(bus, sess)
	waitCall(t, calls)
	deadline := time.After(5 * time.Second)
	for e := (events.Event{}); e.Type != adapters.Waiting; {
		select {
		case e = <-ch:
		case <-deadline:
			t.Fatal("no agent.waiting")
		}
		if e.Type == adapters.Waiting && (e.Data["session"] != sess.Name || e.Data["source"] != "turncheck" || e.Data["choice"] != "needs_input") {
			t.Fatalf("agent.waiting %v", e.Data)
		}
	}
	if got := stateNow(t, b, sess.Name); got != "waiting" {
		t.Fatalf("state %s", got)
	}
	// Not a question: a prompt held for idle goes, and one sent now is
	// typed as a new turn rather than refused.
	ctx := context.Background()
	if res, err := b.sendPrompt(ctx, sess.Name, SendRequest{Text: "Go on", When: "idle"}, "test", "test"); err != nil || !res.Sent {
		t.Fatalf("when idle: %+v %v", res, err)
	}
	end := hook(bus, adapters.Finished, sess.Name, sess.Dir, "claude")
	// The ledger takes a verdict only on the turn end it was about.
	verdict := func(seq int64) {
		bus.Publish(events.Event{Type: adapters.Waiting, Data: map[string]any{"session": sess.Name, "path": sess.Dir, "source": "turncheck", "seq": seq}})
	}
	if verdict(end.Seq - 1); stateNow(t, b, sess.Name) != "finished" {
		t.Fatal("a verdict on an older turn was taken")
	}
	if verdict(end.Seq); stateNow(t, b, sess.Name) != "waiting" {
		t.Fatal("the verdict was not taken")
	}
	if res, err := b.sendPrompt(ctx, sess.Name, SendRequest{Text: "And then", When: "now"}, "test", "test"); err != nil || !res.Sent {
		t.Fatalf("when now: %+v %v", res, err)
	}
}

// A turn that asks in its last message waits with nothing on its screen to
// answer: Claude Code sits at its prompt. The session says the wait is turn
// check's, with no ask (the app then draws no question card from a screen
// guess), /rc leaves it as it is, and the mode menu switches its mode. A
// wait its hooks reported still keeps both from typing at the question.
func TestTurnChecksWaitIsSaidAndTakesAModeChange(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Which flaky tests should move?", "Which ones do you want moved? I'd say 1 and 3.", jevSays("needs_input", 0.92))
	ctx := context.Background()
	endTurn(bus, sess)
	waitCall(t, calls)
	deadline := time.Now().Add(5 * time.Second)
	for stateNow(t, b, sess.Name) != "waiting" {
		if time.Now().After(deadline) {
			t.Fatal("the verdict was not taken")
		}
		time.Sleep(20 * time.Millisecond)
	}
	setMode := func() error {
		r := httptest.NewRequest("POST", "/v1/sessions/"+sess.Name+"/mode", strings.NewReader(`{"mode":"default"}`))
		r.SetPathValue("name", sess.Name)
		return b.setMode(httptest.NewRecorder(), r)
	}
	soft := func() {
		t.Helper()
		if got := b.enrich(ctx, []Session{sess})[0]; got.AgentState != "waiting" || !got.SoftWait || got.Ask != nil {
			t.Fatalf("the session reads %s, soft wait %v, ask %+v", got.AgentState, got.SoftWait, got.Ask)
		}
	}
	soft()
	if res, err := b.sendPrompt(ctx, sess.Name, SendRequest{Text: "/rc", When: "idle"}, "test", "test"); err != nil || !res.Sent || res.Turn != "" {
		t.Fatalf("/rc: %+v %v", res, err)
	}
	soft()
	if err := setMode(); err != nil {
		t.Fatalf("a mode change at turn check's wait: %v", err)
	}

	hook(bus, adapters.Started, sess.Name, sess.Dir, "claude", "signal", "prompt")
	hook(bus, adapters.Waiting, sess.Name, sess.Dir, "claude", "reason", "permission")
	if got := b.enrich(ctx, []Session{sess})[0]; got.AgentState != "waiting" || got.SoftWait {
		t.Fatalf("a hooked wait reads %s, soft wait %v", got.AgentState, got.SoftWait)
	}
	var he httpError
	if err := setMode(); !errors.As(err, &he) || he.status != http.StatusConflict {
		t.Fatalf("a mode change at a permission prompt: %v", err)
	}
}

// The agent stopped while its work goes on ("the build is still compiling,
// I'll come back"): not done, not a question. The turn stays finished, so it
// takes prompts and ends waits as done, but is marked unfinished, so it shows
// as working rather than done; only on the turn end it was about.
func TestTurnCheckMarksWorkStillGoingOnUnfinished(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Run the suite", "Backend operators are in place. Checking how enumOptions is used elsewhere…", jevSays("working", 0.92))
	endTurn(bus, sess)
	waitCall(t, calls)
	unfinished := func() bool { st, _ := b.Turns.State(sess.Name); return st.Unfinished }
	deadline := time.Now().Add(5 * time.Second)
	for !unfinished() {
		if time.Now().After(deadline) {
			t.Fatal("the verdict was not taken")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := stateNow(t, b, sess.Name); got != "finished" || !b.Turns.Ready(sess.Name) {
		t.Fatalf("state %s, ready %v: want finished and ready for a prompt", got, b.Turns.Ready(sess.Name))
	}
	if got := b.enrich(context.Background(), []Session{sess})[0]; got.AgentState != "finished" || !got.Unfinished || got.Parked {
		t.Fatalf("the session reads %s, unfinished %v, parked %v", got.AgentState, got.Unfinished, got.Parked)
	}
	// Its next turn starts afresh: no longer unfinished.
	hook(bus, adapters.Started, sess.Name, sess.Dir, "claude", "signal", "prompt")
	if unfinished() {
		t.Fatal("still unfinished once a new turn started")
	}
	end := hook(bus, adapters.Finished, sess.Name, sess.Dir, "claude")
	bus.Publish(events.Event{Type: adapters.Ready, Data: map[string]any{"session": sess.Name, "path": sess.Dir, "source": "turncheck", "seq": end.Seq - 1}})
	if got := stateNow(t, b, sess.Name); got != "finished" || unfinished() {
		t.Fatalf("a verdict on an older turn was taken: %s, unfinished %v", got, unfinished())
	}
}

// turnFixture is a finished turn as turn check reads it: the session's
// title, the turn's last prompt and its reply.
type turnFixture struct{ title, prompt, reply string }

// Real turns from a box, as turn check read them, with names changed.
var (
	// Waits on someone else's reply and checks again in 24 hours: nothing
	// runs and nothing is asked of you, so it is parked.
	parkedTurn = turnFixture{
		title:  "👀 KEEP OPEN ACME-1898 — Dana watch + 24h check",
		prompt: "This session should be kept up because it's still running and checking for what Dana might reply. Should we then rename the session to something more appropriate so that I don't close it accidentally?",
		reply:  `Dana hasn't replied on "Bonus field in Shopify" yet. Her only new mail is on a different thread ("User invites", saying everyone has been invited).`,
	}
	// A deploy it started is still running (its shell, on the screen), and
	// it acts when it ends: working. Its prompt was further back than turn
	// check looks, so none is sent.
	runningTurn = turnFixture{
		title: "🚀 ACME-1903 deploying",
		reply: "`./deploy.sh` is running for merge 956e39c. When it finishes I'll check that the new revision has 100% of traffic and run the prod verification.",
	}
	// A check-in it scheduled for itself tomorrow, with the box kept awake
	// for it and a production job running on meanwhile: nothing runs for
	// the agent now, so it is parked, not working.
	scheduledTurn = turnFixture{
		title:  "🚀 ACME-1921 night 1 clean, waiting night 2",
		prompt: "everything done or are we waiting for something or something needs to be checked before done status?",
		reply:  "**Still waiting:** I've paused the tag-sync job's scheduler, so tonight the new rule is the only thing setting the tag. Tomorrow at about 07:20 I'll check that the count held. If it did, I'll retire that job the same way and set ACME-1921 to Done. The box stays awake until 06:20 UTC to cover that check.",
	}
	// A re-check it started runs in the background now and reports back:
	// working.
	backgroundTurn = turnFixture{
		title: "🚀 ACME-2002 watch window",
		reply: "The 15-minute re-check is still running in the background. I'll finish when it reports back.",
	}
	// It started a worker for the fix and handed it over: the user closes
	// this session, and the worker's news no longer comes here. The worker
	// runs on, but this agent won't follow it, so it is done.
	handoffTurn = turnFixture{
		title:  "Bot replacement: vendor picks, control chat",
		prompt: "Just start a worker to fix it and i will close this session",
		reply: "I've started a worker to fix it, so you can close this session.\n\n" +
			"- **Issue:** ACME-2262, \"Intake: an issue id in a title the card titler wrote shouldn't count as a live session\" (repo:acme-skills, Bug, unassigned). It's what I described: skip ids that appear only in a title the titler wrote, keep the current behaviour when there's no summary file, plus unit tests and a check on the box with throwaway sessions.\n" +
			"- **Worker:** `acme-skills-acme-2262-intake-titler-ids-c-1af9`, running `/ship ACME-2262`. I turned off its notifications to this session since you're closing it. Follow it in Shipyard.\n\n" +
			"The task file is updated with where things stand. Three things are still open there:\n" +
			"- **ACME-2253 intake:** clicking **Start intake** should work now.\n" +
			"- **The earlier ACME-2253 attempt:** its uncommitted code is still in `acme-skills-acme-2253-control-chat`. Keep it for intake or throw it away.\n" +
			"- **Product decisions:** which box hosts it, and which mail and notes servers it uses.",
	}
	// It started a build and waits on it to act on the result: working.
	delegatedTurn = turnFixture{
		title:  "ACME-2270 release build",
		prompt: "Build the release and tell me if it's green",
		reply:  "I've started the release build in a worker (`acme-release-build-7c1d`). I'll check the result when it reports back and tell you whether it's green.",
	}
)

// Every provider is asked with parked beside working, each with its own
// definition, and gets the turn as it is.
func TestTurnCheckAsksWhetherWorkIsParked(t *testing.T) {
	for name, turn := range map[string]turnFixture{"parked": parkedTurn, "running": runningTurn, "scheduled": scheduledTurn, "background": backgroundTurn, "handoff": handoffTurn, "delegated": delegatedTurn} {
		t.Run(name, func(t *testing.T) {
			b, bus, sess, calls := checkedBox(t, true, turn.prompt, turn.reply, jevSays("done", 0.9))
			if err := b.Sessions.SetTitle(context.Background(), sess.Name, turn.title); err != nil {
				t.Fatal(err)
			}
			endTurn(bus, sess)
			c := waitCall(t, calls)
			state, _ := c.body["state"].(map[string]any)
			if state["session_objective"] != turn.title || state["user_request"] != turn.prompt || state["agent_response"] != turn.reply {
				t.Fatalf("state %v", state)
			}
			status, _ := c.body["questions"].(map[string]any)["status"].(map[string]any)
			criteria, _ := status["criteria"].(map[string]any)
			instructions, _ := status["instructions"].(string)
			if criteria["parked"] != jevCriteria["parked"] || criteria["working"] != jevCriteria["working"] || instructions != jevInstructions {
				t.Fatalf("asked %v", status)
			}

			ask := decisionsRequest("gpt-6-luna", turn.title, turn.prompt, turn.reply)
			q := ask["questions"].([]map[string]any)[0]
			got := map[string]string{}
			for _, ch := range q["choices"].([]map[string]string) {
				got[ch["value"]] = ch["description"]
			}
			if got["parked"] != jevCriteria["parked"] || got["working"] != jevCriteria["working"] || len(got) != len(jevCriteria) || q["instructions"] != strings.Replace(jevInstructions, "Treat the state as", "Treat the input as", 1) {
				t.Fatalf("decisions choices %v", got)
			}
			if input := ask["input"].(string); input != "Session objective: "+turn.title+"\n\nUser request: "+turn.prompt+"\n\nAgent response: "+turn.reply {
				t.Fatalf("decisions input %q", input)
			}
		})
	}
	// The two never overlap: what runs now is working, what waits on a
	// reply or a later time is parked.
	if !strings.Contains(jevCriteria["working"], "running right now") || !strings.Contains(jevCriteria["parked"], "nothing is running") || !strings.Contains(jevCriteria["parked"], "nothing is needed from the user") {
		t.Fatalf("criteria %v", jevCriteria)
	}
	// A check-in the agent scheduled for itself is parked, even with the
	// machine kept awake for it; working is what runs now, a background
	// task included, and never a check scheduled for later.
	for _, want := range []string{"check-in the agent scheduled for itself", "timer or cron", "kept awake for it"} {
		if !strings.Contains(jevCriteria["parked"], want) {
			t.Fatalf("parked %q lacks %q", jevCriteria["parked"], want)
		}
	}
	for _, want := range []string{"background task it started that is still running", "A check it scheduled for a later time is not running now."} {
		if !strings.Contains(jevCriteria["working"], want) {
			t.Fatalf("working %q lacks %q", jevCriteria["working"], want)
		}
	}
	for _, want := range []string{"check-in the agent scheduled for itself at a set time with a timer, cron or loop", "A check scheduled for later is not running now: with nothing else running it is parked, not working, even if the machine is kept awake for it", "background task it started that is still running"} {
		if !strings.Contains(jevInstructions, want) {
			t.Fatalf("instructions lack %q", want)
		}
	}
	// A delegated task is working only while this agent waits on it; one
	// handed to a worker or session it won't follow is done, even as the
	// worker runs on.
	for _, want := range []string{"a delegated task it waits on or will act on when it reports back", "handed to a separate worker or session that this agent won't follow is not work in progress"} {
		if !strings.Contains(jevCriteria["working"], want) {
			t.Fatalf("working %q lacks %q", jevCriteria["working"], want)
		}
	}
	for _, want := range []string{"handed to a separate worker or session that this agent won't follow", "tells the user they can close this session", "followed elsewhere", "turned off that worker's notifications to this session", "even while the worker still runs"} {
		if !strings.Contains(jevInstructions, want) {
			t.Fatalf("instructions lack %q", want)
		}
	}
	if !strings.Contains(jevCriteria["done"], "handed off (for example to a separate worker or session it won't follow") {
		t.Fatalf("done %q", jevCriteria["done"])
	}
}

// A turn that handed its work to a worker it won't follow, read as done,
// stays plainly finished: neither unfinished nor parked.
func TestTurnCheckLeavesAHandoffDone(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, handoffTurn.prompt, handoffTurn.reply, jevSays("done", 0.93))
	b.Sessions.SetTitle(context.Background(), sess.Name, handoffTurn.title)
	endTurn(bus, sess)
	waitCall(t, calls)
	time.Sleep(300 * time.Millisecond)
	if got := b.enrich(context.Background(), []Session{sess})[0]; got.AgentState != "finished" || got.Unfinished || got.Parked {
		t.Fatalf("the session reads %s, unfinished %v, parked %v", got.AgentState, got.Unfinished, got.Parked)
	}
}

// TestTurnCheckLive asks the real provider about the fixtures, with the
// prompt as it is now: a replay of real turns, never run in CI. Point
// BERTH_TURNCHECK_LIVE_KEY_FILE at a gateway key (a box keeps its own in
// turncheck.key) and set BERTH_TURNCHECK_LIVE_MODEL to the model to ask.
func TestTurnCheckLive(t *testing.T) {
	keyFile, model := os.Getenv("BERTH_TURNCHECK_LIVE_KEY_FILE"), os.Getenv("BERTH_TURNCHECK_LIVE_MODEL")
	if keyFile == "" || model == "" {
		t.Skip("set BERTH_TURNCHECK_LIVE_KEY_FILE and BERTH_TURNCHECK_LIVE_MODEL to ask the real provider")
	}
	raw, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	key := strings.TrimSpace(string(raw))
	cfg := TurnCheckConfig{Enabled: true, Provider: ProviderGateway, Model: model}
	c := &TurnCheck{timeout: 60 * time.Second}
	for name, want := range map[string]struct {
		turn   turnFixture
		choice string
	}{
		"handoff":    {handoffTurn, "done"},
		"delegated":  {delegatedTurn, "working"},
		"deploy":     {runningTurn, "working"},
		"background": {backgroundTurn, "working"},
		"scheduled":  {scheduledTurn, "parked"},
	} {
		t.Run(name, func(t *testing.T) {
			choice, p, err := c.ask(context.Background(), &Box{}, cfg, key, want.turn.title, want.turn.prompt, want.turn.reply)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("%s: %s at %.2f", name, choice, p)
			if choice != want.choice {
				t.Errorf("%s: want %s, got %s at %.2f", name, want.choice, choice, p)
			}
		})
	}
}

// Work that waits on someone else's reply or a later time, with nothing
// running: the turn stays finished, takes prompts, and is marked parked,
// not unfinished, so it shows as idle; only on the turn end it was about,
// and never as a wait.
func TestTurnCheckMarksWorkWaitingOnAReplyParked(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, parkedTurn.prompt, parkedTurn.reply, jevSays("parked", 0.86))
	b.Sessions.SetTitle(context.Background(), sess.Name, parkedTurn.title)
	ch, stop := bus.Subscribe()
	defer stop()
	endTurn(bus, sess)
	waitCall(t, calls)
	marks := func() (bool, bool) { st, _ := b.Turns.State(sess.Name); return st.Parked, st.Unfinished }
	deadline := time.Now().Add(5 * time.Second)
	for parked, _ := marks(); !parked; parked, _ = marks() {
		if time.Now().After(deadline) {
			t.Fatal("the verdict was not taken")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, unfinished := marks(); unfinished {
		t.Fatal("parked work is marked unfinished too")
	}
	if got := stateNow(t, b, sess.Name); got != "finished" || !b.Turns.Ready(sess.Name) || b.Turns.SoftWait(sess.Name) {
		t.Fatalf("state %s, ready %v: want finished and ready for a prompt", got, b.Turns.Ready(sess.Name))
	}
	if got := b.enrich(context.Background(), []Session{sess})[0]; got.AgentState != "finished" || !got.Parked || got.Unfinished {
		t.Fatalf("the session reads %s, parked %v, unfinished %v", got.AgentState, got.Parked, got.Unfinished)
	}
	for len(ch) > 0 {
		if e := <-ch; e.Type == adapters.Waiting || (e.Type == adapters.Ready && e.Data["choice"] != "parked") {
			t.Fatalf("published %s %v", e.Type, e.Data)
		}
	}
	// Its next turn starts afresh.
	hook(bus, adapters.Started, sess.Name, sess.Dir, "claude", "signal", "prompt")
	if parked, _ := marks(); parked {
		t.Fatal("still parked once a new turn started")
	}
	end := hook(bus, adapters.Finished, sess.Name, sess.Dir, "claude")
	verdict := func(choice string, seq int64) {
		bus.Publish(events.Event{Type: adapters.Ready, Data: map[string]any{"session": sess.Name, "path": sess.Dir, "source": "turncheck", "choice": choice, "seq": seq}})
	}
	if verdict("parked", end.Seq-1); stateNow(t, b, sess.Name) != "finished" {
		t.Fatal("not finished")
	}
	if parked, _ := marks(); parked {
		t.Fatal("a verdict on an older turn was taken")
	}
	// On the same turn end, the last verdict wins: parked, then working.
	if verdict("parked", end.Seq); !b.Turns.Ready(sess.Name) {
		t.Fatal("parked work takes no prompt")
	}
	if parked, unfinished := marks(); !parked || unfinished {
		t.Fatalf("parked %v, unfinished %v", parked, unfinished)
	}
	verdict("working", end.Seq)
	if parked, unfinished := marks(); parked || !unfinished {
		t.Fatalf("working read as parked %v, unfinished %v", parked, unfinished)
	}
}

// A deploy or a re-check still running is working, not parked.
func TestTurnCheckMarksARunningDeployUnfinished(t *testing.T) {
	for name, turn := range map[string]turnFixture{"deploy": runningTurn, "background": backgroundTurn, "delegated": delegatedTurn} {
		t.Run(name, func(t *testing.T) {
			b, bus, sess, calls := checkedBox(t, true, turn.prompt, turn.reply, jevSays("working", 0.9))
			b.Sessions.SetTitle(context.Background(), sess.Name, turn.title)
			endTurn(bus, sess)
			waitCall(t, calls)
			deadline := time.Now().Add(5 * time.Second)
			for st, _ := b.Turns.State(sess.Name); !st.Unfinished; st, _ = b.Turns.State(sess.Name) {
				if time.Now().After(deadline) {
					t.Fatal("the verdict was not taken")
				}
				time.Sleep(20 * time.Millisecond)
			}
			if got := b.enrich(context.Background(), []Session{sess})[0]; got.AgentState != "finished" || !got.Unfinished || got.Parked {
				t.Fatalf("the session reads %s, unfinished %v, parked %v", got.AgentState, got.Unfinished, got.Parked)
			}
		})
	}
}

// A check-in the agent scheduled for itself, with nothing running now, is
// parked: idle, not working.
func TestTurnCheckMarksAScheduledCheckInParked(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, scheduledTurn.prompt, scheduledTurn.reply, jevSays("parked", 0.96))
	b.Sessions.SetTitle(context.Background(), sess.Name, scheduledTurn.title)
	endTurn(bus, sess)
	waitCall(t, calls)
	deadline := time.Now().Add(5 * time.Second)
	for st, _ := b.Turns.State(sess.Name); !st.Parked; st, _ = b.Turns.State(sess.Name) {
		if time.Now().After(deadline) {
			t.Fatal("the verdict was not taken")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := b.enrich(context.Background(), []Session{sess})[0]; got.AgentState != "finished" || !got.Parked || got.Unfinished {
		t.Fatalf("the session reads %s, parked %v, unfinished %v", got.AgentState, got.Parked, got.Unfinished)
	}
}

func TestTurnCheckLeavesOtherTurnsFinished(t *testing.T) {
	for name, answer := range map[string]http.HandlerFunc{
		"done":   jevSays("done", 0.99),
		"unsure": jevSays("needs_input", 0.5),
		"error":  func(w http.ResponseWriter, r *http.Request) { http.Error(w, "down", 500) },
	} {
		t.Run(name, func(t *testing.T) {
			b, bus, sess, calls := checkedBox(t, true, "Ship it", "Pushed and deployed.", answer)
			endTurn(bus, sess)
			waitCall(t, calls)
			time.Sleep(300 * time.Millisecond)
			if got := stateNow(t, b, sess.Name); got != "finished" || len(calls) != 0 {
				t.Fatalf("state %s, asked %d more times", got, len(calls))
			}
		})
	}
}

func TestTurnCheckOffAsksNothing(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, false, "Add the operators", "Go ahead?", jevSays("needs_input", 0.9))
	endTurn(bus, sess)
	time.Sleep(300 * time.Millisecond)
	if len(calls) != 0 || stateNow(t, b, sess.Name) != "finished" {
		t.Fatalf("asked %d times, state %s", len(calls), stateNow(t, b, sess.Name))
	}
}

// You typed again before Jev answered: its answer is about a turn that is
// no longer the last, and is dropped.
func TestTurnCheckDropsALateAnswer(t *testing.T) {
	release := make(chan struct{})
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", func(w http.ResponseWriter, r *http.Request) {
		<-release
		jevSays("needs_input", 0.9)(w, r)
	})
	ch, stop := bus.Subscribe()
	defer stop()
	endTurn(bus, sess)
	waitCall(t, calls)
	hook(bus, adapters.Started, sess.Name, sess.Dir, "claude", "signal", "prompt")
	close(release)
	time.Sleep(300 * time.Millisecond)
	if got := stateNow(t, b, sess.Name); got != "running" {
		t.Fatalf("state %s, want running", got)
	}
	for len(ch) > 0 {
		if e := <-ch; e.Type == adapters.Waiting {
			t.Fatalf("published %v", e.Data)
		}
	}
}

var (
	// Says how another session is getting on and offers to follow it up:
	// that work is the other session's, so the turn is done.
	otherSessionTurn = turnFixture{
		title:  "Which session is fixing the archive tray?",
		prompt: "I started a session to fix it. When we archive worktrees and bulk close sessions here, it should go into the background and show up in the tray. Can you find me which session that is, or if it has shipped, or whatever is going on? Right now, I can't see that it is working, even though I'm on the latest update.",
		reply: "It hasn't shipped. The fix is still being built, so what you see in the screenshot is the old behaviour where the dialog stays open while it works.\n\n" +
			"**The session:** `shop-acme-2279-background-jobs-tray`, worktree `~/work/shop-acme-2279-background-jobs-tray`. It's still running.\n\n" +
			"**Where it's at:**\n- The feature is committed in that worktree at 10:47 today (`d44d2ff2`, \"feat(app): bulk Stop and Archive carry on in a background-jobs tray\"). It does what you asked for:\n" +
			"  - Confirming \"Stop N agents?\" closes the dialog straight away.\n  - The stopping and archiving carry on in a tray at the bottom right, with a progress count (\"Stopping 17 agents · 9/17\") and one row per agent, grouped by box.\n" +
			"  - A clean run shows a summary and fades. Anything that was kept or failed stays in the tray until you dismiss it.\n  - The sidebar's single Archive… goes through the tray too.\n" +
			"- It isn't pushed and there's no PR yet. One verify-skill scenario file (`dashboard-stop-archive.mjs`) has uncommitted changes, so it looks like it's in the verify step now.\n\n" +
			"**Why the update didn't help:**\n- The newest release is **v0.3.30** (21 Oct, 12:49). The bulk Stop + Archive dialog in your screenshot came later, in PR #179, merged today at 08:29. The tray is built on top of that.\n" +
			"- The earlier single-worktree fix, **ACME-2199** (PR #175, \"archiving a worktree no longer holds its dialog open\"), has been open since yesterday and isn't merged. The 2279 branch includes a rebased copy of that commit, so its PR will probably bring 2199 along.\n\n" +
			"So for you to see it, the 2279 session has to finish verifying and open its PR. Then it needs merging upstream and a release after v0.3.30. I didn't interrupt the session. I can nudge it to push and open the PR once verification passes, or tell you when its turn ends.",
	}
	// Waits on another session and says it acts when that one reports back:
	// working.
	waitsOnSessionTurn = turnFixture{
		title:  "🚀 ACME-2279 merge and release",
		prompt: "Get the tray fix merged and released once its session has opened the PR.",
		reply:  "The ACME-2279 session is still verifying, so there's no PR yet. I'm watching its turn: as soon as it opens the PR I'll review it, merge it once CI is green and cut the release.",
	}
)

// recordedTurnCheck is an answer AI Gateway's Jev gave to one request, and
// that request's sha256: a test serves it only to the same request, so
// changing the prompt asks for a new recording.
type recordedTurnCheck struct {
	Request string          `json:"request_sha256"`
	Answer  json.RawMessage `json:"answer"`
}

// replayTurnCheck is Jev's recorded answer to the request a box makes for
// turn, from testdata/turncheck/name.json. With
// BERTH_TURNCHECK_RECORD_KEY_FILE set to an AI Gateway key's file, it asks
// the gateway instead and records the answer; tests never do otherwise.
func replayTurnCheck(t *testing.T, name string, turn turnFixture) (request []byte, answer http.HandlerFunc) {
	t.Helper()
	return replayRequest(t, name, jevRequest(TurnCheckConfig{Provider: ProviderGateway, Model: "typesafe-ai/jev"}, turn.title, turn.prompt, turn.reply))
}

// replayRequest is a recorded answer to this exact request.
func replayRequest(t *testing.T, name string, ask map[string]any) (request []byte, answer http.HandlerFunc) {
	t.Helper()
	request, err := json.Marshal(ask)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(request)
	file := filepath.Join("testdata", "turncheck", name+".json")
	if keyFile := os.Getenv("BERTH_TURNCHECK_RECORD_KEY_FILE"); keyFile != "" {
		key, err := os.ReadFile(keyFile)
		if err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequest(http.MethodPost, jevGateway, bytes.NewReader(request))
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(key)))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("AI Gateway answered %s", resp.Status)
		}
		rec, _ := json.MarshalIndent(recordedTurnCheck{Request: hex.EncodeToString(sum[:]), Answer: got}, "", "  ")
		os.MkdirAll(filepath.Dir(file), 0o755)
		if err := os.WriteFile(file, append(rec, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("no recording: %v", err)
	}
	var rec recordedTurnCheck
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Request != hex.EncodeToString(sum[:]) {
		t.Fatalf("%s was recorded for another request (the prompt changed?): record it again with BERTH_TURNCHECK_RECORD_KEY_FILE=<AI Gateway key file> go test ./internal/box -run TestTurnCheckReplays", file)
	}
	return request, func(w http.ResponseWriter, r *http.Request) { w.Write(rec.Answer) }
}

// Real turns replayed through Jev's recorded answers, end to end: a status
// report on another session with an offer stays done, waiting on another
// session to act when it reports back is working, and the turns above read
// as they did before.
func TestTurnCheckReplays(t *testing.T) {
	for name, tc := range map[string]struct {
		turn             turnFixture
		unfinished, park bool
	}{
		"other-session-offer":  {turn: otherSessionTurn},
		"waits-on-session-act": {turn: waitsOnSessionTurn, unfinished: true},
		"running-deploy":       {turn: runningTurn, unfinished: true},
		"background-recheck":   {turn: backgroundTurn, unfinished: true},
		"parked-reply":         {turn: parkedTurn, park: true},
		"scheduled-check-in":   {turn: scheduledTurn, park: true},
	} {
		t.Run(name, func(t *testing.T) {
			request, answer := replayTurnCheck(t, name, tc.turn)
			b, bus, sess, calls := checkedBox(t, true, tc.turn.prompt, tc.turn.reply, answer)
			b.Sessions.SetTitle(context.Background(), sess.Name, tc.turn.title)
			endTurn(bus, sess)
			c := waitCall(t, calls)
			if sent, _ := json.Marshal(c.body); !bytes.Equal(sent, request) {
				t.Fatalf("the box asked\n%s\nnot the recorded request\n%s", sent, request)
			}
			// A verdict that marks nothing has nothing to wait for.
			deadline := time.Now().Add(300 * time.Millisecond)
			for st, _ := b.Turns.State(sess.Name); !st.Unfinished && !st.Parked && time.Now().Before(deadline); st, _ = b.Turns.State(sess.Name) {
				time.Sleep(20 * time.Millisecond)
			}
			if got := b.enrich(context.Background(), []Session{sess})[0]; got.AgentState != "finished" || got.Unfinished != tc.unfinished || got.Parked != tc.park {
				t.Fatalf("the session reads %s, unfinished %v, parked %v", got.AgentState, got.Unfinished, got.Parked)
			}
		})
	}
	for _, want := range []string{"offers to follow it up", "an offer is not a promise", "working only when the agent says it will act when that session reports back"} {
		if !strings.Contains(jevInstructions, want) {
			t.Fatalf("instructions lack %q", want)
		}
	}
}

func TestTurnCheckSendsTheTurnsEndsToJev(t *testing.T) {
	reply := strings.Repeat("r", 13000) + "REPLY-END"
	_, bus, sess, calls := checkedBox(t, true, "Ship it", reply, jevSays("done", 0.9))
	endTurn(bus, sess)
	c := waitCall(t, calls)
	state, _ := c.body["state"].(map[string]any)
	resp, _ := state["agent_response"].(string)
	gateway, _ := c.body["providerOptions"].(map[string]any)["gateway"].(map[string]any)
	if c.auth != "Bearer jev-test-key" || state["user_request"] != "Ship it" || len(resp) > turnCheckReplyLimit+len("…") || !strings.HasSuffix(resp, "REPLY-END") {
		t.Fatalf("asked with %q: %d %v", c.auth, len(resp), state["user_request"])
	}
	if c.body["model"] != "typesafe-ai/jev" || gateway["disallowPromptTraining"] != true {
		t.Fatalf("body %v", c.body)
	}
}

// Laya's laya-serve (or another server that speaks Jev's shape): its own
// URL and model, no AI Gateway options, and not the key pasted for AI
// Gateway.
func TestTurnCheckAsksTheServerItIsGiven(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", jevSays("needs_input", 0.9))
	own := strings.TrimSuffix(jevURL, "/v1/evaluate") + "/v1/systemone"
	b.TurnCheck.KeyPath = filepath.Join(t.TempDir(), "turncheck.key")
	os.WriteFile(b.TurnCheck.KeyPath, []byte("vck_pasted_value\n"), 0o600)
	b.TurnCheck.save(TurnCheckConfig{Enabled: true, Provider: ProviderLaya, URL: own, Model: "multilingual"})
	endTurn(bus, sess)
	c := waitCall(t, calls)
	if _, has := c.body["providerOptions"]; has || c.path != "/v1/systemone" || c.body["model"] != "multilingual" || c.auth != "" {
		t.Fatalf("asked %s with %q: %v", c.path, c.auth, c.body)
	}
}

func TestJevVerdictReadsOnlyJevsAnswer(t *testing.T) {
	for in, want := range map[string]string{
		`{"answers":{"status":{"choice":"blocked","probabilities":{"blocked":0.7,"done":0.3}}}}`: "blocked 0.70",
		`{"answers":{"status":{"choice":"maybe","probabilities":{"maybe":0.9}}}}`:                "unusable",
		`{"answers":{"status":{"choice":"done","probabilities":{"working":0.9}}}}`:               "unusable",
		`{"answers":{"status":{"choice":"done","probabilities":{"done":1.5}}}}`:                  "unusable",
		`{"answers":{"status":{"value":"done","probability":0.8}}}`:                              "unusable",
		`<html>not json`: "unusable",
	} {
		choice, p, err := jevVerdict([]byte(in))
		got := "unusable"
		if err == nil {
			got = fmt.Sprintf("%s %.2f", choice, p)
		}
		if got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}

func TestTurnCheckSettingsHoldOnlyAReference(t *testing.T) {
	t.Setenv("BERTH_TEST_JEV_KEY", "the-real-key-value")
	var tc *TurnCheck
	c, bus := servedBox(t, func(b *Box) {
		tc = &TurnCheck{Path: filepath.Join(t.TempDir(), "turncheck.json")}
		b.TurnCheck = tc
	})
	var bad map[string]string
	// No provider is picked for you, and AI Gateway needs a key.
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Model: "typesafe-ai/jev", Key: "env://BERTH_TEST_JEV_KEY"}, &bad); status != 400 || !strings.Contains(bad["error"], "who checks") {
		t.Fatalf("on without a provider: %d %v", status, bad)
	}
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Provider: ProviderGateway, Model: "typesafe-ai/jev"}, &bad); status != 400 {
		t.Fatalf("on without a key: %d", status)
	}
	// No model is picked for you.
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Provider: ProviderGateway, Key: "env://BERTH_TEST_JEV_KEY"}, &bad); status != 400 || !strings.Contains(bad["error"], "model") {
		t.Fatalf("on without a model: %d %v", status, bad)
	}
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Provider: ProviderGateway, Key: "vck_live_secret", Model: "typesafe-ai/jev"}, &bad); status != 400 || strings.Contains(bad["error"], "vck_live_secret") {
		t.Fatalf("a key that is not a reference: %d %v", status, bad)
	}
	ch, stop := bus.Subscribe()
	defer stop()
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Provider: ProviderGateway, Key: "env://BERTH_TEST_JEV_KEY", Model: "typesafe-ai/jev"}, nil); status != 200 {
		t.Fatalf("put: %d", status)
	}
	if e := <-ch; e.Type != "turncheck.changed" || e.Data["enabled"] != true {
		t.Fatalf("event %v", e)
	}
	resp, err := c.Do(context.Background(), "GET", "/v1/turncheck", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var got TurnCheckConfig
	json.Unmarshal(raw, &got)
	if !got.Enabled || got.Key != "env://BERTH_TEST_JEV_KEY" || got.Model != "typesafe-ai/jev" || strings.Contains(string(raw), "the-real-key-value") {
		t.Fatalf("get: %s", raw)
	}
	if file, _ := os.ReadFile(tc.Path); strings.Contains(string(file), "the-real-key-value") {
		t.Fatal("the value is on disk")
	}
	// Laya needs no key and no model; its URL must be http(s).
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Enabled: true, Provider: ProviderLaya, URL: "http://127.0.0.1:8000/v1/systemone"}, nil); status != 200 {
		t.Fatalf("Laya without a key: %d", status)
	}
	for _, bad := range []TurnCheckConfig{
		{Enabled: true, Provider: ProviderLaya},
		{Enabled: true, Provider: ProviderLaya, URL: "file:///etc/passwd"},
		{Enabled: true, Provider: "anthropic", Model: "m"},
		// A key goes only to AI Gateway or OpenAI, at their own URL.
		{Enabled: true, Provider: ProviderLaya, Key: "env://BERTH_TEST_JEV_KEY", URL: "https://example.com/v1/systemone"},
		{Enabled: true, Provider: ProviderGateway, Key: "env://BERTH_TEST_JEV_KEY", URL: "https://example.com/v1/evaluate", Model: "typesafe-ai/jev"},
		{Enabled: true, Provider: ProviderOpenAI, Key: "env://BERTH_TEST_JEV_KEY", URL: "https://api.openai.com.example.com/v1/decisions", Model: "gpt-6-luna"},
	} {
		if status := call(t, c, "PUT", "/v1/turncheck", "", bad, nil); status != 400 {
			t.Fatalf("%+v: %d", bad, status)
		}
	}
	// A reference set for one provider isn't kept for another.
	var st TurnCheckStatus
	call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Provider: ProviderGateway, Key: "env://BERTH_TEST_JEV_KEY", Model: "typesafe-ai/jev"}, nil)
	if status := call(t, c, "PUT", "/v1/turncheck", "", TurnCheckConfig{Provider: ProviderOpenAI, Key: "env://BERTH_TEST_JEV_KEY", Model: "gpt-6-luna"}, &st); status != 200 || st.Key != "" {
		t.Fatalf("switching provider: %d %+v", status, st)
	}
}

// The simple way: a key pasted in Settings, kept on the box (0600) and
// never answered.
// A key goes only to its provider's own URL. turncheck.json is a file on
// the box, so an agent could name its own server there with a reference to
// a secret: as a Laya server it is never asked, and a hosted provider
// ignores a URL and asks its own.
func TestTurnCheckSendsAKeyOnlyToItsProvider(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", jevSays("needs_input", 0.9))
	own := strings.TrimSuffix(jevURL, "/v1/evaluate") + "/collect"
	for _, u := range []string{own, strings.Replace(own, "http:", "https:", 1)} {
		b.TurnCheck.save(TurnCheckConfig{Enabled: true, Provider: ProviderLaya, Key: "env://BERTH_TEST_JEV_KEY", URL: u})
		endTurn(bus, sess)
		time.Sleep(300 * time.Millisecond)
		if len(calls) != 0 {
			t.Fatalf("%s was asked: %+v", u, <-calls)
		}
	}
	b.TurnCheck.save(TurnCheckConfig{Enabled: true, Provider: ProviderGateway, Key: "env://BERTH_TEST_JEV_KEY", URL: own, Model: "typesafe-ai/jev"})
	endTurn(bus, sess)
	if c := waitCall(t, calls); c.path != "/v1/evaluate" {
		t.Fatalf("asked %s", c.path)
	}
}

// OpenAI's Decisions API: one choice question over the turn as one text,
// with OpenAI's key, and its answer read for the probability of its choice.
func TestTurnCheckAsksOpenAIDecisions(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Both are in. Should the filter default to AND or OR?", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"answers":[{"type":"choice","name":"status","choice":"needs_input","probabilities":[{"value":"needs_input","probability":0.88},{"value":"done","probability":0.12}],"confidence":0.8}]}`)
	})
	t.Setenv("BERTH_TEST_OPENAI_KEY", "sk-openai-test")
	b.TurnCheck.save(TurnCheckConfig{Enabled: true, Provider: ProviderOpenAI, Key: "env://BERTH_TEST_OPENAI_KEY", Model: "gpt-6-luna"})
	ch, stop := bus.Subscribe()
	defer stop()
	endTurn(bus, sess)
	c := waitCall(t, calls)
	qs, _ := c.body["questions"].([]any)
	q, _ := qs[0].(map[string]any)
	choices, _ := q["choices"].([]any)
	input, _ := c.body["input"].(string)
	if c.path != "/v1/decisions" || c.auth != "Bearer sk-openai-test" || c.body["model"] != "gpt-6-luna" || q["type"] != "choice" || q["name"] != "status" || len(choices) != len(jevCriteria) {
		t.Fatalf("asked %s with %q: %v", c.path, c.auth, c.body)
	}
	if !strings.Contains(input, "User request: Add the operators") || !strings.Contains(input, "Agent response: Both are in.") {
		t.Fatalf("input %q", input)
	}
	if _, has := c.body["providerOptions"]; has {
		t.Fatal("AI Gateway's options sent to OpenAI")
	}
	deadline := time.After(5 * time.Second)
	for e := (events.Event{}); e.Type != adapters.Waiting; {
		select {
		case e = <-ch:
		case <-deadline:
			t.Fatal("no agent.waiting")
		}
	}
}

func TestDecisionsVerdictReadsOnlyItsAnswer(t *testing.T) {
	for in, want := range map[string]string{
		`{"answers":[{"type":"choice","name":"status","choice":"blocked","probabilities":[{"value":"blocked","probability":0.7}]}]}`: "blocked 0.70",
		`{"answers":[{"type":"refusal","name":"status"}]}`:                                                                           "unusable",
		`{"answers":[{"type":"choice","name":"status","choice":"maybe","probabilities":[{"value":"maybe","probability":0.9}]}]}`:     "unusable",
		`{"answers":[{"type":"choice","name":"status","choice":"done","probabilities":[{"value":"working","probability":0.9}]}]}`:    "unusable",
		`{"answers":[{"type":"choice","name":"other","choice":"done","probabilities":[{"value":"done","probability":0.9}]}]}`:        "unusable",
		`{"answers":{"status":{"choice":"done"}}}`:                                                                                   "unusable",
	} {
		choice, p, err := decisionsVerdict([]byte(in))
		got := "unusable"
		if err == nil {
			got = fmt.Sprintf("%s %.2f", choice, p)
		}
		if got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}

// Each provider keeps its own key: one pasted for AI Gateway is never sent
// to OpenAI.
func TestTurnCheckKeepsAKeyPerProvider(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", jevSays("needs_input", 0.9))
	b.TurnCheck.KeyPath = filepath.Join(t.TempDir(), "turncheck.key")
	os.WriteFile(b.TurnCheck.KeyPath, []byte("vck_gateway_key\n"), 0o600)
	b.TurnCheck.save(TurnCheckConfig{Enabled: true, Provider: ProviderOpenAI, Model: "gpt-6-luna"})
	endTurn(bus, sess)
	time.Sleep(300 * time.Millisecond)
	if len(calls) != 0 {
		t.Fatalf("OpenAI was asked with %q", (<-calls).auth)
	}
	os.WriteFile(filepath.Join(filepath.Dir(b.TurnCheck.KeyPath), "turncheck-openai.key"), []byte("sk-openai-pasted\n"), 0o600)
	endTurn(bus, sess)
	if c := waitCall(t, calls); c.path != "/v1/decisions" || c.auth != "Bearer sk-openai-pasted" {
		t.Fatalf("asked %s with %q", c.path, c.auth)
	}
}

// What leaves the box is capped, and what looks like a secret is taken out
// of the title, the prompt and the reply, with the patterns artifacts are
// refused by.
func TestTurnCheckSendsNoSecretAndAShortPrompt(t *testing.T) {
	const (
		aws = "AKIAIOSFODNN7EXAMPLE"
		gh  = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789AB"
		pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7bq\n-----END RSA PRIVATE KEY-----"
	)
	prompt := "Deploy with " + aws + " " + strings.Repeat("p", 5000)
	reply := "Used " + gh + " and\nDB_PASSWORD=hunter2hunter2hunter2\n" + pem + "\nShould I push?"
	b, bus, sess, calls := checkedBox(t, true, prompt, reply, jevSays("needs_input", 0.9))
	if err := b.Sessions.SetTitle(context.Background(), sess.Name, "Rotate sk-ant-abcdefghijklmnopqrstuvwxyz0123456789"); err != nil {
		t.Fatal(err)
	}
	endTurn(bus, sess)
	state, _ := waitCall(t, calls).body["state"].(map[string]any)
	sent := fmt.Sprint(state)
	for _, secret := range []string{aws, gh, "MIIEpAIBAAKCAQEA7bq", "hunter2", "sk-ant-"} {
		if strings.Contains(sent, secret) {
			t.Errorf("sent %q", secret)
		}
	}
	req, _ := state["user_request"].(string)
	if !strings.HasPrefix(req, "Deploy with [redacted: an AWS access key] ppp") || len([]rune(req)) > turnCheckPromptLimit {
		t.Errorf("user_request %d: %.60q", len([]rune(req)), req)
	}
	if resp, _ := state["agent_response"].(string); !strings.Contains(resp, "[redacted: a GitHub token]") || !strings.Contains(resp, "[redacted: a private key]\nShould I push?") {
		t.Errorf("agent_response %q", resp)
	}
}

// Turn check is set from a paired laptop: an agent on the box reaches its
// socket, and could otherwise send turns, or a key, wherever it liked.
func TestTurnCheckIsSetFromALaptopOnly(t *testing.T) {
	bx := &Box{Name: "devbox", Events: &events.Bus{Sequence: true}, TurnCheck: &TurnCheck{Path: filepath.Join(t.TempDir(), "turncheck.json")}}
	c := localBox(t, bx)
	ctx := context.Background()
	if err := c.Call(ctx, "GET", "/v1/turncheck", nil, nil); err == nil || !strings.Contains(err.Error(), "paired laptop") {
		t.Fatalf("get: %v", err)
	}
	err := c.Call(ctx, "PUT", "/v1/turncheck", TurnCheckConfig{Enabled: true, Provider: ProviderLaya, URL: "https://collect.example/v1/systemone"}, nil)
	if err == nil || !strings.Contains(err.Error(), "paired laptop") {
		t.Fatalf("put: %v", err)
	}
	if _, err := os.Stat(bx.TurnCheck.Path); !os.IsNotExist(err) {
		t.Fatal("turncheck.json was written")
	}
}

func TestTurnCheckKeepsAPastedKeyOnTheBox(t *testing.T) {
	var tc *TurnCheck
	c, _ := servedBox(t, func(b *Box) {
		tc = &TurnCheck{Path: filepath.Join(t.TempDir(), "turncheck.json"), KeyPath: filepath.Join(t.TempDir(), "turncheck.key")}
		b.TurnCheck = tc
	})
	for _, bad := range []string{"env://X", "vck_\u200bpasted"} {
		if status := call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": true, "key_value": bad}, nil); status != 400 {
			t.Fatalf("%q pasted as the key: %d", bad, status)
		}
	}
	var st TurnCheckStatus
	if status := call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": true, "provider": "gateway", "model": "typesafe-ai/jev", "key_value": "vck_pasted_value"}, &st); status != 200 || !st.KeySet || !st.Enabled {
		t.Fatalf("pasting a key: %d %+v", status, st)
	}
	if fi, err := os.Stat(tc.KeyPath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", fi, err)
	}
	resp, _ := c.Do(context.Background(), "GET", "/v1/turncheck", nil)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if strings.Contains(string(raw), "vck_pasted_value") || !strings.Contains(string(raw), `"key_set":true`) {
		t.Fatalf("get: %s", raw)
	}
	// The last one set wins: a reference removes the pasted key.
	if status := call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": true, "provider": "gateway", "model": "typesafe-ai/jev", "key": "env://BERTH_TEST_JEV_KEY"}, &st); status != 200 || st.KeySet {
		t.Fatalf("a reference: %d %+v", status, st)
	}
	call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": true, "provider": "gateway", "model": "typesafe-ai/jev", "key_value": "vck_pasted_value"}, nil)
	if status := call(t, c, "PUT", "/v1/turncheck", "", map[string]any{"enabled": false, "provider": "gateway", "remove_key": true}, &st); status != 200 || st.KeySet {
		t.Fatalf("remove: %d %+v", status, st)
	}
	if _, err := os.Stat(tc.KeyPath); !os.IsNotExist(err) {
		t.Fatal("the key file is still there")
	}
}

func TestTurnCheckSendsThePastedKey(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Add the operators", "Go ahead?", jevSays("done", 0.9))
	b.TurnCheck.KeyPath = filepath.Join(t.TempDir(), "turncheck.key")
	os.WriteFile(b.TurnCheck.KeyPath, []byte("vck_pasted_value\n"), 0o600)
	b.TurnCheck.save(TurnCheckConfig{Enabled: true, Provider: ProviderGateway, Model: "typesafe-ai/jev"})
	endTurn(bus, sess)
	if c := waitCall(t, calls); c.auth != "Bearer vck_pasted_value" {
		t.Fatalf("authorization %q", c.auth)
	}
}

// A turn longer than a page of the transcript (here hundreds of tool calls)
// still sends Jev its prompt, from further back, and the session's title as
// the objective, so Jev never judges a reply on its own.
func TestTurnCheckSendsTheLongTurnsPromptAndTheObjective(t *testing.T) {
	b, bus, sess, calls := checkedBox(t, true, "Migrate the gateway", "Started", jevSays("done", 0.9))
	if err := b.Sessions.SetTitle(context.Background(), sess.Name, "Migrate the MCP gateway"); err != nil {
		t.Fatal(err)
	}
	rec := filepath.Join(transcript.ClaudeDir(sess.Dir), "conv.jsonl")
	at := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	line := func(v map[string]any) string { b, _ := json.Marshal(v); return string(b) + "\n" }
	var lines strings.Builder
	for i := range 200 {
		id := fmt.Sprintf("t%d", i)
		lines.WriteString(line(map[string]any{"type": "assistant", "timestamp": at, "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": fmt.Sprintf("Step %d", i)}, {"type": "tool_use", "id": id, "name": "Bash", "input": map[string]any{"command": "true"}}}}}))
		lines.WriteString(line(map[string]any{"type": "user", "timestamp": at, "message": map[string]any{"role": "user", "content": []map[string]any{{"type": "tool_result", "tool_use_id": id, "content": "ok"}}}}))
	}
	lines.WriteString(line(map[string]any{"type": "assistant", "timestamp": at, "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "Migrated, and the old services are gone."}}}}))
	appendTo(t, rec, lines.String())
	endTurn(bus, sess)
	state, _ := waitCall(t, calls).body["state"].(map[string]any)
	if state["user_request"] != "Migrate the gateway" || state["session_objective"] != "Migrate the MCP gateway" || state["agent_response"] != "Migrated, and the old services are gone." {
		t.Fatalf("state %v", state)
	}
}
