package runs

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeHost struct {
	mu      sync.Mutex
	calls   []string
	events  []string
	leaf    func(ctx context.Context, x *StepCtx) Result
	reenter func(ctx context.Context, x *StepCtx) (Result, bool)
}

func (h *fakeHost) Leaf(ctx context.Context, x *StepCtx) Result {
	h.mu.Lock()
	h.calls = append(h.calls, x.Step.Kind+":"+x.Path)
	h.mu.Unlock()
	if h.leaf != nil {
		return h.leaf(ctx, x)
	}
	return Result{Status: Succeeded}
}

func (h *fakeHost) Reenter(ctx context.Context, x *StepCtx) (Result, bool) {
	h.mu.Lock()
	h.calls = append(h.calls, "reenter:"+x.Step.Kind+":"+x.Path)
	h.mu.Unlock()
	if h.reenter != nil {
		return h.reenter(ctx, x)
	}
	return Result{}, false
}

func (h *fakeHost) Before(context.Context, string, string, map[string]any) error { return nil }
func (h *fakeHost) Publish(typ string, data map[string]any) {
	h.mu.Lock()
	h.events = append(h.events, typ)
	h.mu.Unlock()
}
func (h *fakeHost) Done(string) {}

func (h *fakeHost) count(prefix string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func newEngine(t *testing.T, dir string, h Host) (*Engine, context.CancelFunc) {
	t.Helper()
	e := &Engine{Dir: dir, Host: h}
	ctx, cancel := context.WithCancel(context.Background())
	e.Resume(ctx)
	return e, func() { cancel(); e.Wait() }
}

func waitStatus(t *testing.T, e *Engine, id string, want ...string) Run {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		r, err := e.Get(id)
		if err == nil {
			for _, w := range want {
				if r.Status == w {
					return r
				}
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	r, _ := e.Get(id)
	t.Fatalf("run %s is %s (%s), want %v", id, r.Status, r.Error, want)
	return r
}

// checkLeaf fails the check until it has run pass times.
func checkLeaf(pass int) func(ctx context.Context, x *StepCtx) Result {
	var mu sync.Mutex
	n := 0
	return func(ctx context.Context, x *StepCtx) Result {
		switch x.Step.Kind {
		case "check":
			mu.Lock()
			n++
			k := n
			mu.Unlock()
			if k >= pass {
				return Result{Status: Succeeded, Out: "ok"}
			}
			return Result{Status: Failed, Code: 1, Out: "FAIL x_test.go:3", Feedback: "FAIL x_test.go:3"}
		case "prompt":
			return Result{Status: Succeeded, Set: map[string]string{"turn.id": "s#1", "turn.session": "s"}}
		}
		return Result{Status: Succeeded}
	}
}

func TestLoopTemplate(t *testing.T) {
	h := &fakeHost{leaf: checkLeaf(3)}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, err := e.Start(Request{Template: "loop", Params: map[string]any{"session": "s", "check": "go test", "prompt": "make it pass"}})
	if err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, s.ID, Succeeded, Failed)
	if r.Status != Succeeded {
		t.Fatalf("status %s: %s", r.Status, r.Error)
	}
	// The first prompt, then feedback after each of two failed checks.
	if got := h.count("prompt"); got != 3 {
		t.Fatalf("%d prompts, want 3: %v", got, h.calls)
	}
	if got := h.count("check"); got != 3 {
		t.Fatalf("%d checks, want 3", got)
	}
}

func TestLoopGivesUpAfterMax(t *testing.T) {
	h := &fakeHost{leaf: checkLeaf(99)}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, err := e.Start(Request{Template: "loop", Params: map[string]any{"session": "s", "check": "false", "max": 2}})
	if err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, s.ID, Succeeded, Failed)
	if r.Status != Failed || !strings.Contains(r.Error, "2 rounds") {
		t.Fatalf("got %s %q", r.Status, r.Error)
	}
	// No prompt after the last round's check: it would never be checked.
	if got := h.count("prompt"); got != 1 {
		t.Fatalf("%d prompts, want 1 (between round 1 and 2)", got)
	}
}

// A loop survives berthd stopping mid-wait: the prompt is not sent again,
// the wait re-attaches to the same turn.
func TestResumeMidWaitNeverResendsPrompt(t *testing.T) {
	dir := t.TempDir()
	block := make(chan struct{})
	var turns []string
	var mu sync.Mutex
	h := &fakeHost{}
	h.leaf = func(ctx context.Context, x *StepCtx) Result {
		switch x.Step.Kind {
		case "prompt":
			return Result{Status: Succeeded, Set: map[string]string{"turn.id": "s#7", "turn.session": "s"}}
		case "wait":
			mu.Lock()
			turns = append(turns, x.Vars["turn.id"])
			mu.Unlock()
			select {
			case <-block:
				return Result{Status: Succeeded, Out: "finished"}
			case <-ctx.Done():
				return Result{Status: Failed, Err: "stopped"}
			}
		case "check":
			return Result{Status: Succeeded}
		}
		return Result{Status: Succeeded}
	}
	e, stop := newEngine(t, dir, h)
	s, _, err := e.Start(Request{Template: "loop", Params: map[string]any{"session": "s", "check": "true", "prompt": "go"}})
	if err != nil {
		t.Fatal(err)
	}
	for h.count("wait") == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	stop() // berthd stops mid-wait
	if st, _ := e.ix.get(s.ID); Terminal(st.Status) {
		t.Fatalf("a stop must not finish the run, got %s", st.Status)
	}
	close(block)
	e2, stop2 := newEngine(t, dir, h)
	defer stop2()
	r := waitStatus(t, e2, s.ID, Succeeded, Failed)
	if r.Status != Succeeded {
		t.Fatalf("status %s %s", r.Status, r.Error)
	}
	if got := h.count("prompt"); got != 1 {
		t.Fatalf("the prompt was sent %d times", got)
	}
	if h.count("reenter:wait") != 1 {
		t.Fatalf("the wait was not re-entered: %v", h.calls)
	}
	if len(turns) != 2 || turns[0] != "s#7" || turns[1] != "s#7" {
		t.Fatalf("waits were on %v, want the same turn twice", turns)
	}
}

// A prompt in flight when berthd stopped: adopted when its turn is found
// by idem key, else a person is asked.
func TestResumePromptAtMostOnce(t *testing.T) {
	for _, found := range []bool{true, false} {
		t.Run(fmt.Sprint("found=", found), func(t *testing.T) {
			dir := t.TempDir()
			typing := make(chan struct{})
			h := &fakeHost{}
			h.leaf = func(ctx context.Context, x *StepCtx) Result {
				if x.Step.Kind == "prompt" && x.Attempt == 1 {
					close(typing)
					<-ctx.Done() // berthd dies while typing
					return Result{Status: Failed}
				}
				if x.Step.Kind == "prompt" {
					return Result{Status: Succeeded, Set: map[string]string{"turn.id": "s#2", "turn.session": "s"}}
				}
				return Result{Status: Succeeded}
			}
			var keys []string
			h.reenter = func(ctx context.Context, x *StepCtx) (Result, bool) {
				keys = append(keys, x.IdemKey)
				if x.Step.Kind != "prompt" {
					return Result{}, false
				}
				if found {
					return Result{Status: Succeeded, Set: map[string]string{"turn.id": "s#1", "turn.session": "s"}}, true
				}
				return Result{Status: "unknown"}, true
			}
			e, stop := newEngine(t, dir, h)
			s, _, _ := e.Start(Request{Template: "loop", Params: map[string]any{"session": "s", "check": "true", "prompt": "go"}})
			<-typing
			stop()
			e2, stop2 := newEngine(t, dir, h)
			defer stop2()
			if !found {
				r := waitStatus(t, e2, s.ID, WaitingGate)
				if r.Gate == nil || !strings.HasSuffix(r.Gate.Path, ".arrived") {
					t.Fatalf("gate %+v", r.Gate)
				}
				// No, it did not arrive: send it again, as attempt 2.
				if err := e2.Decide(s.ID, "", Decision{Approve: false, By: "test"}); err != nil {
					t.Fatal(err)
				}
			}
			r := waitStatus(t, e2, s.ID, Succeeded, Failed)
			if r.Status != Succeeded {
				t.Fatalf("%s %s", r.Status, r.Error)
			}
			want := 1
			if !found {
				want = 2
			}
			if got := h.count("prompt"); got != want {
				t.Fatalf("prompt sent %d times, want %d", got, want)
			}
			if len(keys) == 0 || !strings.HasSuffix(keys[0], "/1") {
				t.Fatalf("re-entry idem keys %v", keys)
			}
		})
	}
}

func TestGateDurableAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	h := &fakeHost{}
	e, stop := newEngine(t, dir, h)
	s, _, err := e.Start(Request{Flow: []Step{
		{ID: "ok", Kind: "gate", Title: "Ship it?", Timeout: "1h"},
		{ID: "after", Kind: "notify", Title: "shipped"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, s.ID, WaitingGate)
	deadline := r.Gate.Deadline
	stop()
	e2, stop2 := newEngine(t, dir, h)
	defer stop2()
	r = waitStatus(t, e2, s.ID, WaitingGate)
	if !r.Gate.Deadline.Equal(deadline) {
		t.Fatalf("deadline moved: %v → %v", deadline, r.Gate.Deadline)
	}
	if err := e2.Decide(s.ID, "", Decision{Approve: true, By: "cli"}); err != nil {
		t.Fatal(err)
	}
	r = waitStatus(t, e2, s.ID, Succeeded)
	if h.count("notify") != 1 {
		t.Fatal("the step after the gate did not run once")
	}
	if err := e2.Decide(s.ID, "", Decision{Approve: true}); err != ErrNoGate {
		t.Fatalf("deciding a finished run: %v", err)
	}
}

func TestGateTimeout(t *testing.T) {
	h := &fakeHost{}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, _ := e.Start(Request{Flow: []Step{{Kind: "gate", Timeout: "50ms", OnTimeout: "approve"}, {Kind: "notify", Title: "x"}}})
	if r := waitStatus(t, e, s.ID, Succeeded, Failed); r.Status != Succeeded {
		t.Fatal(r.Status)
	}
	s, _, _ = e.Start(Request{Flow: []Step{{Kind: "gate", Timeout: "50ms", OnTimeout: "fail"}, {Kind: "notify", Title: "x", When: "always"}}})
	if r := waitStatus(t, e, s.ID, Succeeded, Failed); r.Status != Failed || !strings.Contains(r.Error, "timed out") {
		t.Fatalf("%s %s", r.Status, r.Error)
	}
}

func TestSleepDurable(t *testing.T) {
	dir := t.TempDir()
	h := &fakeHost{}
	e, stop := newEngine(t, dir, h)
	s, _, _ := e.Start(Request{Flow: []Step{{Kind: "sleep", Duration: "400ms"}, {Kind: "notify", Title: "woke"}}})
	time.Sleep(100 * time.Millisecond)
	stop()
	began := time.Now()
	e2, stop2 := newEngine(t, dir, h)
	defer stop2()
	waitStatus(t, e2, s.ID, Succeeded)
	if el := time.Since(began); el > 390*time.Millisecond {
		t.Fatalf("the sleep started over: %v", el)
	}
}

func TestAdmissionQueuesAndCoalesces(t *testing.T) {
	release := make(chan struct{})
	h := &fakeHost{leaf: func(ctx context.Context, x *StepCtx) Result {
		if x.Step.Kind == "run" {
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		return Result{Status: Succeeded, Out: x.Vars["event.items"]}
	}}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	e.Items = func(items []map[string]any) string {
		var b strings.Builder
		for _, it := range items {
			fmt.Fprintf(&b, "- %v\n", it["body"])
		}
		return b.String()
	}
	flow := []Step{{ID: "work", Kind: "run", Command: "x"}, {ID: "say", Kind: "notify", Title: "t"}}
	a, _, err := e.Start(Request{Flow: flow, Key: "f@wt", IdemKey: "github:f:1:c1", Item: map[string]any{"body": "one"}})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, a.ID, Running)
	// Arriving mid-run: queued, not skipped.
	b, _, err := e.Start(Request{Flow: flow, Key: "f@wt", IdemKey: "github:f:1:c2", Item: map[string]any{"body": "two"}, Coalesce: true})
	if err != nil || b.Status != Queued {
		t.Fatalf("second: %+v %v", b, err)
	}
	// A third merges into the queued one.
	c, _, err := e.Start(Request{Flow: flow, Key: "f@wt", IdemKey: "github:f:1:c3", Item: map[string]any{"body": "three"}, Coalesce: true})
	if err != nil || c.ID != b.ID {
		t.Fatalf("third should coalesce into %s, got %+v %v", b.ID, c, err)
	}
	// The same delivery again changes nothing.
	d, dup, _ := e.Start(Request{Flow: flow, Key: "f@wt", IdemKey: "github:f:1:c2"})
	if !dup || d.ID != b.ID {
		t.Fatalf("duplicate delivery: %+v dup=%v", d, dup)
	}
	close(release)
	waitStatus(t, e, a.ID, Succeeded)
	r := waitStatus(t, e, b.ID, Succeeded)
	if !strings.Contains(r.Steps[0].Output, "two") || !strings.Contains(r.Steps[0].Output, "three") {
		t.Fatalf("coalesced items missing: %q", r.Steps[0].Output)
	}
	// Bounded: without coalescing, past the limit is refused.
	block := make(chan struct{})
	h.leaf = func(ctx context.Context, x *StepCtx) Result {
		select {
		case <-block:
		case <-ctx.Done():
		}
		return Result{Status: Succeeded}
	}
	e.Start(Request{Flow: flow, Key: "k2"})
	for i := 0; i < 2; i++ {
		if _, _, err := e.Start(Request{Flow: flow, Key: "k2", QueueLimit: 2}); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := e.Start(Request{Flow: flow, Key: "k2", QueueLimit: 2}); err != ErrQueueFull {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
	close(block)
}

func TestMaxRunsQueues(t *testing.T) {
	block := make(chan struct{})
	h := &fakeHost{leaf: func(ctx context.Context, x *StepCtx) Result {
		select {
		case <-block:
		case <-ctx.Done():
		}
		return Result{Status: Succeeded}
	}}
	e := &Engine{Dir: t.TempDir(), Host: h, MaxRuns: 2}
	ctx, cancel := context.WithCancel(context.Background())
	e.Resume(ctx)
	defer func() { cancel(); e.Wait() }()
	var ids []string
	for i := 0; i < 4; i++ {
		s, _, err := e.Start(Request{Flow: []Step{{Kind: "run", Command: "x"}}})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, s.ID)
	}
	if e.Active() != 2 {
		t.Fatalf("%d active, want 2", e.Active())
	}
	if s, _ := e.ix.get(ids[3]); s.Status != Queued {
		t.Fatalf("4th is %s", s.Status)
	}
	close(block)
	for _, id := range ids {
		waitStatus(t, e, id, Succeeded)
	}
}

func TestBudgetPausesAtGate(t *testing.T) {
	h := &fakeHost{leaf: checkLeaf(99)}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, err := e.Start(Request{Template: "loop", Params: map[string]any{"session": "s", "check": "false", "max": 5}, Budget: &Budget{MaxRounds: 2}})
	if err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, s.ID, WaitingGate)
	if r.Gate.Title != "Over budget" {
		t.Fatalf("gate %+v", r.Gate)
	}
	e.Decide(s.ID, "", Decision{Approve: false})
	r = waitStatus(t, e, s.ID, Failed)
	if !strings.Contains(r.Error, "max_rounds") {
		t.Fatal(r.Error)
	}
}

func TestCancel(t *testing.T) {
	h := &fakeHost{leaf: func(ctx context.Context, x *StepCtx) Result {
		<-ctx.Done()
		return Result{Status: Failed}
	}}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, _ := e.Start(Request{Flow: []Step{{Kind: "run", Command: "sleep 100"}}})
	waitStatus(t, e, s.ID, Running)
	// Cancel once the step is under way, not merely the run: under load the
	// run can be running before its first step starts.
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		if r, err := e.Get(s.ID); err == nil && len(r.Steps) > 0 && r.Steps[0].Status == Running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the step never started")
		}
	}
	if err := e.Cancel(s.ID); err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, s.ID, Cancelled)
	if r.Steps[0].Status != Cancelled {
		t.Fatalf("step %+v", r.Steps[0])
	}
}

// attemptsHost plays three attempts: 0 fails its check, 1 and 2 pass.
func attemptsHost(judgeReply string) *fakeHost {
	h := &fakeHost{}
	h.leaf = func(ctx context.Context, x *StepCtx) Result {
		i := x.Vars["item.index"]
		switch x.Step.Kind {
		case "start_agent":
			wt := ExpandText(x.Step.Name, x.Vars)
			return Result{Status: Succeeded, Set: map[string]string{"session": "s-" + wt, "worktree.path": "/wt/" + wt, "worktree.name": wt, "worktree.branch": wt, "location": "shop", "turn.id": "s-" + wt + "#1", "turn.session": "s-" + wt}}
		case "check":
			if i == "0" {
				return Result{Status: Failed, Code: 1, Feedback: "FAIL"}
			}
			return Result{Status: Succeeded}
		case "collect":
			c := &Candidate{Agent: x.Vars["item.agent"], Path: x.Vars["worktree.path"], Branch: x.Vars["worktree.branch"], Worktree: x.Vars["worktree.name"]}
			fmt.Sscan(i, &c.Index)
			c.Verify.Passed = x.Vars["steps.check.exit_code"] == "0"
			c.Diff.Files, c.Diff.Added = 2, 10*(c.Index+1)
			return Result{Status: Succeeded, Candidate: c}
		case "headless":
			return Result{Status: Succeeded, Out: judgeReply, Usage: &Usage{Input: 1000, Output: 50, USD: 0.01}}
		case "prompt":
			return Result{Status: Succeeded, Set: map[string]string{"turn.id": x.Vars["session"] + "#2", "turn.session": x.Vars["session"]}}
		}
		return Result{Status: Succeeded}
	}
	return h
}

func TestAttemptsJudgeGatePick(t *testing.T) {
	h := attemptsHost("Here: {\"winner\": 3, \"ranking\": [3, 2, 1], \"reasons\": {\"3\": \"smallest correct\"}}")
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, err := e.Start(Request{Template: "attempts", Params: map[string]any{
		"location": "shop", "name": "refunds", "prompt": "Implement partial refunds",
		"attempts": []any{"claude", map[string]any{"agent": "codex"}, map[string]any{"agent": "claude", "prompt_suffix": "Prefer the smallest diff."}},
		"verify":   map[string]any{"check": "pnpm test", "max_rounds": 2},
		"then":     map[string]any{"pr": map[string]any{"draft": true}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, s.ID, WaitingGate)
	if !r.Gate.Pick || r.Gate.Default != 2 || len(r.Candidates) != 3 {
		t.Fatalf("gate %+v, %d candidates", r.Gate, len(r.Candidates))
	}
	if r.Candidates[2].Judge.Rank != 1 || r.Candidates[0].Verify.Passed {
		t.Fatalf("candidates %+v", r.Candidates)
	}
	// The person picks attempt 2 over the judge's 3.
	one := 1
	if err := e.Decide(s.ID, "", Decision{Approve: true, Pick: &one, By: "cli"}); err != nil {
		t.Fatal(err)
	}
	r = waitStatus(t, e, s.ID, Succeeded, Failed)
	if r.Status != Succeeded {
		t.Fatalf("%s: %s", r.Status, r.Error)
	}
	if !r.Candidates[1].Picked || r.Candidates[2].Picked {
		t.Fatalf("picked %+v", r.Candidates)
	}
	if h.count("pr:") != 1 || h.count("cleanup:") != 1 {
		t.Fatalf("pr/cleanup: %v", h.calls)
	}
	if r.Usage == nil || r.Usage.USD == 0 {
		t.Fatal("judge usage not counted")
	}
	// Attempt 1's failing check got one feedback prompt (max_rounds 2).
	if got := h.count("prompt:"); got != 1 {
		t.Fatalf("%d prompts", got)
	}
}

func TestJudgeRetriesOnceThenFallsBack(t *testing.T) {
	h := attemptsHost("I think the second one")
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, err := e.Start(Request{Template: "attempts", Params: map[string]any{
		"location": "shop", "name": "x", "prompt": "p", "attempts": []any{"claude", "codex"}, "pick": "auto",
	}})
	if err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, s.ID, Succeeded, Failed)
	if h.count("headless:") != 2 {
		t.Fatalf("judge asked %d times", h.count("headless:"))
	}
	if r.Status != Succeeded || !r.Candidates[1].Picked {
		t.Fatalf("%s %s %+v", r.Status, r.Error, r.Candidates)
	}
}

func TestParseVerdict(t *testing.T) {
	if _, err := ParseVerdict(`{"winner": 4}`, 3); err == nil {
		t.Fatal("out of range winner accepted")
	}
	if _, err := ParseVerdict(`{"winner": 1, "ranking": [1,1]}`, 3); err == nil {
		t.Fatal("repeated ranking accepted")
	}
	v, err := ParseVerdict("```json\n{\"winner\": \"2\", \"ranking\": [2,1], \"reasons\": {\"2\": \"ok\"}}\n```", 2)
	if err != nil || v.Winner != 2 {
		t.Fatal(v, err)
	}
	p := JudgePrompt(strings.Repeat("task ", 200), "small diff", []Candidate{{Index: 0, Agent: "claude", Path: "/w/a1", Summary: strings.Repeat("feat: x; ", 100)}, {Index: 1}, {Index: 2}})
	if len(p) > 2200 {
		t.Fatalf("judge prompt is %d bytes", len(p))
	}
}

func TestMapFirstSuccessCancelsOthers(t *testing.T) {
	// An item not yet started when one succeeds is never run (first_success),
	// and the map's goroutines start in any order: the fast item wins only
	// once the slow ones are running, so all three are there to see.
	var started atomic.Int32
	h := &fakeHost{leaf: func(ctx context.Context, x *StepCtx) Result {
		started.Add(1)
		if x.Vars["item"] == "fast" {
			for started.Load() < 3 {
				select {
				case <-ctx.Done():
					return Result{Status: Failed}
				case <-time.After(5 * time.Millisecond):
				}
			}
			return Result{Status: Succeeded}
		}
		<-ctx.Done()
		return Result{Status: Failed}
	}}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, _ := e.Start(Request{Flow: []Step{{Kind: "map", Items: []byte(`["slow","slow","fast"]`), Mode: "first_success", Steps: []Step{{Kind: "run", Command: "x"}}}}})
	r := waitStatus(t, e, s.ID, Succeeded, Failed)
	if r.Status != Succeeded {
		t.Fatal(r.Error)
	}
	if len(r.Steps[0].Children) != 3 {
		t.Fatalf("map children %+v", r.Steps[0].Children)
	}
}

func TestTemplatesExpand(t *testing.T) {
	params := map[string]map[string]any{
		"loop":           {"session": "s", "check": "go test ./..."},
		"review":         {"session": "s"},
		"handoff":        {"session": "s", "name": "next"},
		"broadcast":      {"sessions": []any{"a", "b"}, "text": "status?"},
		"fix-ci":         {"check_url": "https://github.com/o/r/actions/runs/1/job/2"},
		"address-review": {},
		"attempts":       {"location": "shop", "name": "n", "prompt": "p", "attempts": []any{"claude"}},
		"exec":           {"command": "make"},
		"stop":           {"sessions": []any{"a", map[string]any{"session": "b", "label": "shop / fix"}}},
	}
	for _, tpl := range Templates() {
		p, ok := params[tpl.Name]
		if !ok {
			t.Fatalf("no test params for template %s", tpl.Name)
		}
		ex, err := Expand(tpl.Name, p)
		if err != nil {
			t.Fatalf("%s: %v", tpl.Name, err)
		}
		if err := ValidateSteps(ex.Steps); err != nil {
			t.Fatalf("%s: %v", tpl.Name, err)
		}
		if tpl.Tokens == "" {
			t.Fatalf("%s says nothing of its token budget", tpl.Name)
		}
	}
	// stop: a name is short for {session}, and with no worktrees nothing
	// is archived.
	ex, err := Expand("stop", map[string]any{"sessions": []any{"a", map[string]any{"session": "b", "label": "shop / fix"}}})
	if err != nil || ex.Title != "Stop 2 agents" || ex.Steps[0].Steps[0].Kind != "stop_session" || string(ex.Steps[1].Items) != "[]" {
		t.Fatalf("stop expanded to %q %+v (%v)", ex.Title, ex.Steps, err)
	}
	if items, _ := Items(ex.Steps[0].Items, nil); len(items) != 2 || items[0]["item.session"] != "a" || items[1]["item.label"] != "shop / fix" {
		t.Fatalf("stop's items: %v", items)
	}
	if _, err := Expand("loop", map[string]any{"session": "s"}); err == nil {
		t.Fatal("missing check accepted")
	}
	if _, err := Expand("loop", map[string]any{"session": "s", "check": "x", "nope": 1}); err == nil {
		t.Fatal("unknown param accepted")
	}
	// A parameter can fill a value, never add a field.
	ex, err = Expand("loop", map[string]any{"session": `s", "kind": "run`, "check": "x"})
	if err != nil || ex.Steps[0].Steps[0].Session != `s", "kind": "run` || ex.Steps[0].Steps[0].Kind != "prompt" {
		t.Fatalf("injection: %+v %v", ex.Steps[0].Steps[0], err)
	}
}

func TestEval(t *testing.T) {
	vars := map[string]string{"a": "1", "b": "", "s": "hello world"}
	cases := map[string]bool{
		"a == 1": true, "a != 1": false, "b == ''": true, "b": false, "a": true, "s contains 'world'": true,
		"s matches '^h.*d$'": true, "a < 2 && s contains 'x'": false, "a < 2 || b": true, "missing == ''": true, "": true,
	}
	for c, want := range cases {
		got, err := Eval(c, vars)
		if err != nil || got != want {
			t.Errorf("%q = %v %v, want %v", c, got, err, want)
		}
	}
	if CheckCond("a ==") == nil || CheckCond("'open") == nil || CheckCond("a ; rm") == nil {
		t.Fatal("bad conditions accepted")
	}
}

func TestCompactBounds(t *testing.T) {
	dir := t.TempDir()
	h := &fakeHost{}
	e, stop := newEngine(t, dir, h)
	defer stop()
	old := time.Now().Add(-40 * 24 * time.Hour)
	var runs []Run
	for i := 0; i < 150; i++ {
		runs = append(runs, Run{ID: fmt.Sprintf("r_old%03d", i), Template: "flow", FlowID: "f", Status: Succeeded, Created: time.Now().Add(time.Duration(i) * time.Second), Finished: time.Now()})
	}
	runs[0].Finished, runs[0].Created = old, old
	if n, _ := e.Import(runs); n != 150 {
		t.Fatal(n)
	}
	e.compact()
	if got := len(e.List(Filter{Limit: 1000})); got != keepPerKind {
		t.Fatalf("%d kept, want %d", got, keepPerKind)
	}
	if _, err := os.Stat(filepath.Join(dir, "r_old000.jsonl")); !os.IsNotExist(err) {
		t.Fatal("a compacted run's journal was kept")
	}
}

// Goroutines end with their runs.
func TestNoGoroutineLeak(t *testing.T) {
	before := runtime.NumGoroutine()
	dir := t.TempDir()
	h := attemptsHost(`{"winner": 2, "ranking": [2,1]}`)
	e, stop := newEngine(t, dir, h)
	var ids []string
	for i := 0; i < 20; i++ {
		s, _, err := e.Start(Request{Template: "attempts", Params: map[string]any{"location": "shop", "name": fmt.Sprint("n", i), "prompt": "p", "attempts": []any{"claude", "codex"}, "pick": "auto"}})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, s.ID)
	}
	g, _, _ := e.Start(Request{Flow: []Step{{Kind: "gate"}}})
	for _, id := range ids {
		waitStatus(t, e, id, Succeeded, Failed)
	}
	waitStatus(t, e, g.ID, WaitingGate)
	stop()
	deadline := time.Now().Add(3 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		buf := make([]byte, 1<<16)
		n := runtime.Stack(buf, true)
		t.Fatalf("goroutines %d before, %d after:\n%s", before, after, buf[:n])
	}
}

func TestFollowStreamsUntilDone(t *testing.T) {
	h := &fakeHost{}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, _ := e.Start(Request{Flow: []Step{{Kind: "gate"}, {Kind: "notify", Title: "x"}}})
	waitStatus(t, e, s.ID, WaitingGate)
	got := make(chan []string)
	go func() {
		var types []string
		e.Follow(context.Background(), s.ID, 0, func(_ int, r Record) bool {
			types = append(types, r.T)
			return true
		})
		got <- types
	}()
	time.Sleep(20 * time.Millisecond)
	e.Decide(s.ID, "", Decision{Approve: true})
	types := <-got
	if types[0] != recCreated || types[len(types)-1] != recFinished {
		t.Fatalf("records %v", types)
	}
}

// Picking none (the winner is on another box) opens no PR and archives
// every attempt here.
func TestAttemptsPickNoneArchivesAll(t *testing.T) {
	h := attemptsHost(`{"winner": 1, "ranking": [1, 2]}`)
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	s, _, _ := e.Start(Request{Template: "attempts", Group: "g1", Params: map[string]any{"location": "shop", "name": "x", "prompt": "p", "attempts": []any{"claude", "codex"}, "then": map[string]any{"pr": map[string]any{"draft": true}}}})
	waitStatus(t, e, s.ID, WaitingGate)
	none := -1
	if err := e.Decide(s.ID, "", Decision{Approve: true, Pick: &none}); err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, s.ID, Succeeded, Failed)
	if r.Status != Succeeded || h.count("pr:") != 0 || h.count("cleanup:") != 1 {
		t.Fatalf("%s %v", r.Status, h.calls)
	}
	for _, c := range r.Candidates {
		if c.Picked {
			t.Fatal("a candidate was picked")
		}
	}
}

// stepAt is the step at path in a run's step tree.
func stepAt(steps []StepRun, path string) *StepRun {
	for i := range steps {
		if steps[i].Path == path {
			return &steps[i]
		}
		if s := stepAt(steps[i].Children, path); s != nil {
			return s
		}
	}
	return nil
}

// prAttempts starts an attempts run of two whose pr step does what pr
// says, and picks attempt 2 at its gate.
func prAttempts(t *testing.T, dir string, pr func(n int) Result) (*Engine, func(), *fakeHost, string) {
	t.Helper()
	h := attemptsHost(`{"winner": 2, "ranking": [2, 1]}`)
	inner := h.leaf
	var mu sync.Mutex
	n := 0
	h.leaf = func(ctx context.Context, x *StepCtx) Result {
		if x.Step.Kind == "pr" {
			mu.Lock()
			n++
			k := n
			mu.Unlock()
			return pr(k)
		}
		return inner(ctx, x)
	}
	e, stop := newEngine(t, dir, h)
	s, _, err := e.Start(Request{Template: "attempts", Params: map[string]any{"location": "shop", "name": "refunds", "prompt": "p",
		"attempts": []any{"claude", "codex"}, "then": map[string]any{"pr": map[string]any{"draft": true}}}})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, s.ID, WaitingGate)
	one := 1
	if err := e.Decide(s.ID, "", Decision{Approve: true, Pick: &one}); err != nil {
		t.Fatal(err)
	}
	return e, stop, h, s.ID
}

const prPath = "3.t.0" // the attempts template's pr → open

// waitGate waits for the run to wait at the gate at path.
func waitGate(t *testing.T, e *Engine, id, path string) Run {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var r Run
	for time.Now().Before(deadline) {
		r, _ = e.Get(id)
		if r.Status == WaitingGate && r.Gate != nil && r.Gate.Path == path {
			return r
		}
		if Terminal(r.Status) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("run %s is %s (%s), gate %+v; want the gate at %s", id, r.Status, r.Error, r.Gate, path)
	return r
}

// On a host gh can't open pull requests on (Gitea), the pr step is a skip
// with its reason: the run still archives the other attempts and succeeds,
// with the pick kept.
func TestAttemptsPRSkippedOnAnotherForgeStillCleansUp(t *testing.T) {
	why := "This repository is on gitea.acme.test, not GitHub, so Shipyard didn't open a pull request. The branch refunds-a2 is pushed to origin."
	e, stop, h, id := prAttempts(t, t.TempDir(), func(int) Result {
		return Result{Status: Skipped, Out: why, Set: map[string]string{"pr.skipped": "1"}}
	})
	defer stop()
	r := waitStatus(t, e, id, Succeeded, Failed)
	if r.Status != Succeeded || r.Error != "" {
		t.Fatalf("%s: %s", r.Status, r.Error)
	}
	if h.count("pr:") != 1 || h.count("cleanup:") != 1 {
		t.Fatalf("pr/cleanup: %v", h.calls)
	}
	if !r.Candidates[1].Picked || r.Candidates[0].Picked {
		t.Fatalf("picked %+v", r.Candidates)
	}
	st := stepAt(r.Steps, prPath)
	if st == nil || st.Status != Skipped || st.Output != why {
		t.Fatalf("pr step %+v", st)
	}
	t.Logf("pr step: %s: %s", st.Status, st.Output)
}

// A pull request that doesn't open on GitHub is a publishing failure, not
// the agents' work failing: the run waits with the pick kept and nothing
// archived, survives a restart without trying again by itself, and
// "Retry publishing" tries again and goes on.
func TestAttemptsPRFailureWaitsThenRetries(t *testing.T) {
	dir := t.TempDir()
	ghSays := "none of the git remotes configured for this repository point to a known GitHub host."
	pr := func(n int) Result {
		if n == 1 {
			return Result{Status: Failed, Code: 1, Out: ghSays, Err: "gh pr create failed"}
		}
		return Result{Status: Succeeded, Out: "https://github.com/acme/shop/pull/7", Set: map[string]string{"pr.url": "https://github.com/acme/shop/pull/7"}}
	}
	e, stop, h, id := prAttempts(t, dir, pr)
	r := waitGate(t, e, id, prPath+".publish1")
	if r.Status != WaitingGate || r.Gate.Path != prPath+".publish1" || r.Gate.ApproveLabel != "Retry publishing" || r.Gate.RejectLabel != "Finish without a pull request" {
		t.Fatalf("%s, gate %+v", r.Status, r.Gate)
	}
	if !strings.Contains(r.Gate.Text, "only publishing failed: gh pr create failed") || !strings.Contains(r.Gate.Text, ghSays) {
		t.Fatalf("gate text %q", r.Gate.Text)
	}
	if !r.Candidates[1].Picked || h.count("cleanup:") != 0 {
		t.Fatalf("pick lost or archived early: %+v %v", r.Candidates, h.calls)
	}
	if st := stepAt(r.Steps, prPath); st == nil || st.Status != Failed || st.Error != "gh pr create failed" {
		t.Fatalf("pr step %+v", st)
	}
	t.Logf("waiting at %q: %s / %s", r.Gate.Title, r.Gate.ApproveLabel, r.Gate.RejectLabel)

	// berthd restarts: the same question, and gh is not run again.
	stop()
	e, stop = newEngine(t, dir, h)
	defer stop()
	r = waitStatus(t, e, id, WaitingGate)
	if r.Gate.Path != prPath+".publish1" || h.count("pr:") != 1 {
		t.Fatalf("after a restart: gate %+v, calls %v", r.Gate, h.calls)
	}
	if err := e.Decide(id, "", Decision{Approve: true, By: "cli"}); err != nil {
		t.Fatal(err)
	}
	r = waitStatus(t, e, id, Succeeded, Failed)
	if r.Status != Succeeded || h.count("pr:") != 2 || h.count("cleanup:") != 1 {
		t.Fatalf("%s %s: %v", r.Status, r.Error, h.calls)
	}
	st := stepAt(r.Steps, prPath)
	if st == nil || st.Status != Succeeded || st.Attempt != 2 || st.Output != "https://github.com/acme/shop/pull/7" {
		t.Fatalf("pr step %+v", st)
	}
	t.Logf("retried: pr step %s (attempt %d): %s", st.Status, st.Attempt, st.Output)
}

// "Finish without a pull request" ends the run as a success: the pr step
// is a skip that says so, and the other attempts are archived.
func TestAttemptsPRFailureFinishesWithoutOne(t *testing.T) {
	e, stop, h, id := prAttempts(t, t.TempDir(), func(int) Result {
		return Result{Status: Failed, Code: 1, Out: "HTTP 401: Bad credentials", Err: "gh pr create failed"}
	})
	defer stop()
	waitGate(t, e, id, prPath+".publish1")
	if err := e.Decide(id, "", Decision{Approve: false, By: "app"}); err != nil {
		t.Fatal(err)
	}
	r := waitStatus(t, e, id, Succeeded, Failed)
	if r.Status != Succeeded || r.Error != "" {
		t.Fatalf("%s: %s", r.Status, r.Error)
	}
	if h.count("pr:") != 1 || h.count("cleanup:") != 1 || !r.Candidates[1].Picked {
		t.Fatalf("calls %v, candidates %+v", h.calls, r.Candidates)
	}
	st := stepAt(r.Steps, prPath)
	if st == nil || st.Status != Skipped || st.Output != "Finished without a pull request (gh pr create failed)." {
		t.Fatalf("pr step %+v", st)
	}
	t.Logf("finished: pr step %s: %s", st.Status, st.Output)
}
