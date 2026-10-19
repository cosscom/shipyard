package runs

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// rejudgeHost is attemptsHost whose judge answers reruns with rerun, and
// which reads the worktrees again for a rerun (a Refresher): attempt 2
// grew since the run collected it.
type rejudgeHost struct {
	*fakeHost
	mu        sync.Mutex
	refreshed int
}

func (h *rejudgeHost) Refresh(ctx context.Context, run Summary, vars map[string]string, cands []Candidate) []Candidate {
	h.mu.Lock()
	h.refreshed++
	h.mu.Unlock()
	out := append([]Candidate(nil), cands...)
	for i := range out {
		out[i].Head = "c0ffee" + string(rune('1'+out[i].Index))
		out[i].Dirty = out[i].Index == 1
		if out[i].Index == 1 {
			out[i].Diff.Files, out[i].Diff.Commits = 5, 2
		}
	}
	return out
}

func newRejudgeHost(first string, rerun func(ctx context.Context, x *StepCtx) Result) *rejudgeHost {
	h := attemptsHost(first)
	leaf := h.leaf
	h.leaf = func(ctx context.Context, x *StepCtx) Result {
		if x.Step.Kind == "headless" && strings.Contains(x.Path, ".v") {
			return rerun(ctx, x)
		}
		return leaf(ctx, x)
	}
	return &rejudgeHost{fakeHost: h}
}

func reply(s string) func(context.Context, *StepCtx) Result {
	return func(context.Context, *StepCtx) Result {
		return Result{Status: Succeeded, Out: s, Usage: &Usage{Input: 900, Output: 40}}
	}
}

func startAttempts(t *testing.T, e *Engine) string {
	t.Helper()
	s, _, err := e.Start(Request{Template: "attempts", Params: map[string]any{
		"location": "shop", "name": "refunds", "prompt": "Implement partial refunds",
		"attempts": []any{"claude", "codex", "claude"},
		"verify":   map[string]any{"check": "pnpm test", "max_rounds": 1},
		"then":     map[string]any{"pr": map[string]any{"draft": true}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, s.ID, WaitingGate)
	return s.ID
}

// waitEval waits for evaluation n to end.
func waitEval(t *testing.T, e *Engine, id string, n int) (Run, Evaluation) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		r, err := e.Get(id)
		if err == nil && len(r.Evaluations) >= n && r.Evaluations[n-1].Status != Running {
			return r, r.Evaluations[n-1]
		}
		time.Sleep(5 * time.Millisecond)
	}
	r, _ := e.Get(id)
	t.Fatalf("evaluation %d never ended: %+v", n, r.Evaluations)
	return Run{}, Evaluation{}
}

func TestRejudgeUpdatesTheVerdictAndStaysAtTheGate(t *testing.T) {
	h := newRejudgeHost(`{"winner": 3, "ranking": [3, 2, 1], "reasons": {"3": "smallest"}}`,
		reply(`{"winner": 2, "ranking": [2, 3, 1], "reasons": {"2": "now has the test", "3": "no test"}}`))
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	id := startAttempts(t, e)
	r, _ := e.Get(id)
	if len(r.Evaluations) != 1 || r.Evaluations[0].Source != "judge" || *r.Evaluations[0].Winner != 2 || r.Evaluations[0].Rerun {
		t.Fatalf("the judge step's evaluation: %+v", r.Evaluations)
	}

	ev, err := e.Rejudge(id)
	if err != nil {
		t.Fatal(err)
	}
	if ev.N != 2 || ev.Status != Running || !ev.Rerun || ev.By != "agent" || ev.Agent != "claude" {
		t.Fatalf("started %+v", ev)
	}
	r, ev = waitEval(t, e, id, 2)
	if ev.Status != Succeeded || ev.Source != "judge" || ev.Fallback() || *ev.Winner != 1 || ev.Ranking[0] != 1 || ev.Reasons[1] != "now has the test" {
		t.Fatalf("rerun %+v", ev)
	}
	if ev.Started.IsZero() || ev.Ended.Before(ev.Started) || ev.Usage == nil || ev.Usage.Input != 900 {
		t.Fatalf("times and usage %+v", ev)
	}
	// It judged the worktrees as they are now, and says which versions.
	if len(ev.Versions) != 3 || ev.Versions[1].Head != "c0ffee2" || !ev.Versions[1].Dirty || ev.Versions[1].Files != 5 || ev.Versions[1].Commits != 2 {
		t.Fatalf("versions %+v", ev.Versions)
	}
	if r.Candidates[1].Diff.Files != 5 || r.Candidates[1].Head != "c0ffee2" {
		t.Fatalf("candidates not refreshed: %+v", r.Candidates[1])
	}
	// Review shows the new ranking; the first evaluation is kept.
	if r.Candidates[1].Judge.Rank != 1 || r.Candidates[2].Judge.Rank != 2 || r.Candidates[1].Judge.Reason != "now has the test" {
		t.Fatalf("ranks %+v", r.Candidates)
	}
	if len(r.Evaluations) != 2 || *r.Evaluations[0].Winner != 2 || r.Evaluations[0].Versions[1].Head != "" {
		t.Fatalf("the first evaluation changed: %+v", r.Evaluations[0])
	}
	// Still waiting for the person: no PR, nothing archived, the coding
	// agents untouched.
	if r.Status != WaitingGate || r.Gate == nil || !r.Gate.Pick || r.Gate.Default != 1 {
		t.Fatalf("status %s gate %+v", r.Status, r.Gate)
	}
	if h.count("pr:") != 0 || h.count("cleanup:") != 0 || h.count("start_agent:") != 3 || h.count("prompt:") != 0 {
		t.Fatalf("calls %v", h.calls)
	}
	// Approving without naming one takes the rerun's winner.
	if err := e.Decide(id, "", Decision{Approve: true, By: "cli"}); err != nil {
		t.Fatal(err)
	}
	r = waitStatus(t, e, id, Succeeded, Failed)
	if r.Status != Succeeded || !r.Candidates[1].Picked {
		t.Fatalf("%s %s %+v", r.Status, r.Error, r.Candidates)
	}
	// Once picked, there is no judging again.
	if _, err := e.Rejudge(id); !errors.Is(err, ErrDone) {
		t.Fatalf("rejudge after the pick: %v", err)
	}
}

func TestRejudgeInvalidReplyIsAFailureWithTheChecksFallback(t *testing.T) {
	h := newRejudgeHost(`{"winner": 3, "ranking": [3, 2, 1]}`, reply("Attempt two looks best to me."))
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	id := startAttempts(t, e)
	if _, err := e.Rejudge(id); err != nil {
		t.Fatal(err)
	}
	r, ev := waitEval(t, e, id, 2)
	if ev.Status != Failed || !ev.Fallback() || ev.Source != "checks" || !strings.Contains(ev.Error, "not valid") {
		t.Fatalf("rerun %+v", ev)
	}
	// Asked once more, then the checks stood in: attempt 2 passes with the
	// smallest diff.
	if h.count("headless:1.v2.ask") != 2 || *ev.Winner != 1 || !strings.Contains(ev.Output, "by the checks, attempt 2") {
		t.Fatalf("calls %v, ev %+v", h.calls, ev)
	}
	// A fallback is not a verdict: nothing shows as ranked by the judge.
	for _, c := range r.Candidates {
		if c.Judge.Rank != 0 || c.Judge.Reason != "" {
			t.Fatalf("ranked by a fallback: %+v", c)
		}
	}
	if r.Status != WaitingGate || r.Gate.Default != 1 {
		t.Fatalf("status %s gate %+v", r.Status, r.Gate)
	}
	// Retry: a good answer this time replaces it as the current one.
	h.fakeHost.mu.Lock()
	leaf := h.fakeHost.leaf
	h.fakeHost.leaf = func(ctx context.Context, x *StepCtx) Result {
		if x.Step.Kind == "headless" && strings.Contains(x.Path, ".v3") {
			return Result{Status: Succeeded, Out: `{"winner": 3, "ranking": [3, 2, 1]}`}
		}
		return leaf(ctx, x)
	}
	h.fakeHost.mu.Unlock()
	if _, err := e.Rejudge(id); err != nil {
		t.Fatal(err)
	}
	r, ev = waitEval(t, e, id, 3)
	if ev.Status != Succeeded || ev.Source != "judge" || r.Gate.Default != 2 || r.Candidates[2].Judge.Rank != 1 || len(r.Evaluations) != 3 {
		t.Fatalf("retry %+v, gate %+v", ev, r.Gate)
	}
}

func TestRejudgeOneAtATimeAndAPickStopsIt(t *testing.T) {
	release := make(chan struct{})
	asked := make(chan struct{}, 4)
	h := newRejudgeHost(`{"winner": 3, "ranking": [3, 2, 1]}`, func(ctx context.Context, x *StepCtx) Result {
		asked <- struct{}{}
		select {
		case <-release:
			return Result{Status: Succeeded, Out: `{"winner": 1}`}
		case <-ctx.Done():
			return Result{Status: Failed, Err: "stopped"}
		}
	})
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	id := startAttempts(t, e)

	// Many at once: one runs, the rest are told it is already running.
	var wg sync.WaitGroup
	var mu sync.Mutex
	started, busy := 0, 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := e.Rejudge(id)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				started++
			case errors.Is(err, ErrJudging):
				busy++
			default:
				t.Errorf("rejudge: %v", err)
			}
		}()
	}
	wg.Wait()
	if started != 1 || busy != 7 {
		t.Fatalf("%d started, %d busy", started, busy)
	}
	<-asked
	r, _ := e.Get(id)
	if r.Status != WaitingGate || r.Evaluations[1].Status != Running {
		t.Fatalf("while judging: %s %+v", r.Status, r.Evaluations)
	}
	// The person picks before the judge answers: the rerun stops, the run
	// goes on with the pick.
	two := 1
	if err := e.Decide(id, "", Decision{Approve: true, Pick: &two, By: "cli"}); err != nil {
		t.Fatal(err)
	}
	r = waitStatus(t, e, id, Succeeded, Failed)
	if r.Status != Succeeded || !r.Candidates[1].Picked {
		t.Fatalf("%s %s", r.Status, r.Error)
	}
	if ev := r.Evaluations[1]; ev.Status != Failed || ev.Winner != nil || !strings.Contains(ev.Error, "stopped") {
		t.Fatalf("the stopped rerun: %+v", ev)
	}
	close(release)
}

func TestRejudgeNeedsAPickGate(t *testing.T) {
	h := &fakeHost{leaf: func(ctx context.Context, x *StepCtx) Result {
		<-ctx.Done()
		return Result{Status: Failed}
	}}
	e, stop := newEngine(t, t.TempDir(), h)
	defer stop()
	if _, err := e.Rejudge("r_nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no run: %v", err)
	}
	s, _, _ := e.Start(Request{Flow: []Step{{Kind: "run", Command: "sleep 9"}}})
	waitStatus(t, e, s.ID, Running)
	if _, err := e.Rejudge(s.ID); !errors.Is(err, ErrNotPicking) {
		t.Fatalf("a running run: %v", err)
	}
	g, _, _ := e.Start(Request{Flow: []Step{{Kind: "gate", Title: "Ship it?"}}})
	waitStatus(t, e, g.ID, WaitingGate)
	if _, err := e.Rejudge(g.ID); !errors.Is(err, ErrNotPicking) {
		t.Fatalf("a plain gate: %v", err)
	}
}

// berthd stopping in the middle of a rerun leaves it failed, the run at
// its gate, and the judge free to be asked again.
func TestRejudgeAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	hold := func(ctx context.Context, x *StepCtx) Result {
		<-ctx.Done()
		return Result{Status: Failed, Err: "stopped"}
	}
	h := newRejudgeHost(`{"winner": 3, "ranking": [3, 2, 1]}`, hold)
	e, stop := newEngine(t, dir, h)
	id := startAttempts(t, e)
	if _, err := e.Rejudge(id); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for h.count("headless:1.v2.ask") == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	stop()

	h2 := newRejudgeHost(`{"winner": 3, "ranking": [3, 2, 1]}`, reply(`{"winner": 1, "ranking": [1, 3, 2]}`))
	e2, stop2 := newEngine(t, dir, h2)
	defer stop2()
	r := waitStatus(t, e2, id, WaitingGate)
	if len(r.Evaluations) != 2 || r.Evaluations[1].Status != Failed || r.Gate.Default != 2 {
		t.Fatalf("after the restart: %+v gate %+v", r.Evaluations, r.Gate)
	}
	// Nothing ran again: the agents, their checks and the first judge
	// came back from the journal.
	if h2.count("start_agent:") != 0 || h2.count("headless:") != 0 {
		t.Fatalf("re-ran %v", h2.calls)
	}
	if _, err := e2.Rejudge(id); err != nil {
		t.Fatal(err)
	}
	r, ev := waitEval(t, e2, id, 3)
	if ev.Status != Succeeded || *ev.Winner != 0 || r.Gate.Default != 0 || r.Candidates[0].Judge.Rank != 1 {
		t.Fatalf("the rerun after a restart: %+v gate %+v", ev, r.Gate)
	}
	// And a further restart keeps the rerun's verdict, not the first one's.
	stop2()
	e3, stop3 := newEngine(t, dir, newRejudgeHost("", reply("")))
	defer stop3()
	r = waitStatus(t, e3, id, WaitingGate)
	if r.Gate.Default != 0 || r.Candidates[0].Judge.Rank != 1 || len(r.Evaluations) != 3 {
		t.Fatalf("after another restart: gate %+v, %+v", r.Gate, r.Candidates)
	}
}
