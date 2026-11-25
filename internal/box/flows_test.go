package box

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/events"
)

func TestFlowsAreValidated(t *testing.T) {
	ok := Flow{ID: "check", Name: "Check", Trigger: Trigger{Event: "agent.finished"}, Steps: []Step{{Kind: "run", Command: "pnpm test"}}}
	if err := ValidateFlows([]Flow{ok}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Flow{
		{ID: "Bad Id", Name: "x", Trigger: ok.Trigger, Steps: ok.Steps},
		{ID: "a", Name: "x", Trigger: Trigger{Event: "before:worktree.create"}, Steps: ok.Steps},
		{ID: "a", Name: "x", Trigger: ok.Trigger},
		{ID: "a", Name: "x", Trigger: ok.Trigger, Steps: []Step{{Kind: "teleport"}}},
		{ID: "a", Name: "x", Trigger: ok.Trigger, Steps: []Step{{Kind: "prompt"}}},
		{ID: "a", Name: "x", Trigger: ok.Trigger, Steps: []Step{{Kind: "run", Command: "x", When: "sometimes"}}},
		{ID: "a", Name: "x", Trigger: ok.Trigger, Steps: []Step{{Kind: "webhook", URL: "file:///etc/passwd"}}},
	} {
		if err := ValidateFlows([]Flow{bad}); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

// flowBox is a box with one repository, a stand-in agent session in a
// worktree of it, and flows running.
// Each opt changes the box before its flows start.
func flowBox(t *testing.T, flows []Flow, opts ...func(*Box)) (*Box, Session, Worktree) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	repo := gitRepo(t)
	writeRepoConfig(t, repo, RepoConfig{Flows: flows})
	dir := t.TempDir()
	b := &Box{Name: "devbox", Locations: NewLocations(filepath.Join(dir, "locations.json")), Events: &events.Bus{},
		Sessions: testSessions(t), Turns: &Turns{}, Flows: &Flows{Path: filepath.Join(dir, "flows.json")}}
	b.Locations.Add(ctx, "cal", repo)
	trustRepo(t, b.Locations, "cal")
	wt, err := b.Locations.CreateWorktree(ctx, "cal", "billing", "", "")
	if err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(fake, []byte("#!/bin/sh\nexec cat\n"), 0o755)
	sess, err := b.Sessions.Create(ctx, "agent", "cal/billing", wt.Path, fake, nil)
	if err != nil {
		t.Fatal(err)
	}
	b.Turns.Attach(b.Events)
	for _, o := range opts {
		o(b)
	}
	go b.Flows.Run(ctx, b)
	// Runs finish in the background, saving their records into the temp
	// dirs; let them settle before those dirs are removed (cleanups run
	// last-registered first, so this one runs before TempDir's).
	// Then stop the flows and runs themselves, so nothing writes into those
	// dirs while they go (cancel, registered first, would run after them).
	t.Cleanup(func() {
		settleRuns(b)
		cancel()
		if eng := b.runsNow(); eng != nil {
			eng.Wait()
		}
	})
	time.Sleep(100 * time.Millisecond)
	return b, sess, wt
}

// settleRuns waits, briefly, until no run is still going, then cancels
// what is (a run waiting on an agent that never answers).
func settleRuns(b *Box) {
	eng := b.runsNow()
	if eng == nil {
		return
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(eng.List(runs.Filter{Status: "active"})) == 0 {
			// The last record may still be on its way to disk.
			time.Sleep(50 * time.Millisecond)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	for _, s := range eng.List(runs.Filter{Status: "active"}) {
		eng.Cancel(s.ID)
	}
	deadline = time.Now().Add(3 * time.Second)
	for eng.Active() > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
}

func waitRun(t *testing.T, b *Box, flow string) FlowRun {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if runs := b.Flows.Runs(flow, 1); len(runs) == 1 && runs[0].Status != "running" {
			return runs[0]
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("flow %s never finished", flow)
	return FlowRun{}
}

func TestAFailedCheckIsSentBackToTheAgentThatFinished(t *testing.T) {
	b, sess, wt := flowBox(t, []Flow{{
		ID: "check", Name: "Check after each turn", Enabled: true,
		Trigger: Trigger{Event: "agent.finished"},
		Steps: []Step{
			{ID: "test", Kind: "run", Command: "echo boom-on-$BERTH_WORKTREE_NAME; exit 2"},
			{Kind: "prompt", When: "failure", Text: "The check failed ({{prev.exit_code}}): {{steps.test.output}}"},
			{Kind: "notify", When: "always", Title: "Checked {{worktree.name}}"},
		},
	}})
	notes, stop := b.Events.Subscribe()
	defer stop()
	b.Events.Publish(events.Event{Type: "agent.finished", Origin: "claude", Data: map[string]any{"path": wt.Path, "agent": "claude"}})

	run := waitRun(t, b, "check")
	if run.Status != "succeeded" || len(run.Steps) != 3 || run.Steps[0].Status != "failed" || run.Steps[1].Status != "succeeded" || run.Steps[2].Status != "succeeded" {
		t.Fatalf("run = %+v", run)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		screen, _ := b.Sessions.Screen(context.Background(), sess.Name, 0)
		if strings.Contains(screen, "The check failed (2): boom-on-billing") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the agent never got the failure: %q", screen)
		}
		time.Sleep(50 * time.Millisecond)
	}
	for {
		select {
		case e := <-notes:
			if e.Type == "notify" {
				if e.Data["title"] != "Checked billing" || e.Origin != "flow:check" {
					t.Fatalf("notify = %+v", e)
				}
				return
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no notify event")
		}
	}
}

func TestRepoFlowsIgnoreOtherReposAndStopRunningAway(t *testing.T) {
	b, _, wt := flowBox(t, []Flow{{
		ID: "count", Name: "Count", Enabled: true, MaxRunsPerHour: 2,
		Trigger: Trigger{Event: "worktree.*", Where: Where{Branch: "bill*"}},
		Steps:   []Step{{Kind: "run", Command: "true"}},
	}})
	b.Events.Publish(events.Event{Type: "worktree.created", Data: map[string]any{"path": "/somewhere/else"}})
	for range 4 {
		b.Events.Publish(events.Event{Type: "worktree.changed", Data: map[string]any{"path": wt.Path}})
		time.Sleep(300 * time.Millisecond)
	}
	if runs := b.Flows.Runs("count", 10); len(runs) != 2 {
		t.Fatalf("%d runs, want the hourly limit of 2", len(runs))
	}
}

func TestWebhooksPostTheRunsContext(t *testing.T) {
	got := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m map[string]any
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &m)
		got <- m
	}))
	defer srv.Close()
	b, _, wt := flowBox(t, []Flow{{ID: "hook", Name: "Tell Slack", Enabled: true, Trigger: Trigger{Event: "agent.waiting"},
		Steps: []Step{{Kind: "webhook", URL: srv.URL, Text: `{"text":"{{worktree.name}} needs you"}`}}}})
	b.Flows.AllowOutbound = []string{"127.0.0.1"}
	b.Events.Publish(events.Event{Type: "agent.waiting", Data: map[string]any{"path": wt.Path}})
	select {
	case m := <-got:
		if m["text"] != "billing needs you" {
			t.Fatalf("body = %v", m)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the webhook was never called")
	}
}

func echoFlow(id, says string, enabled bool) Flow {
	return Flow{ID: id, Name: id, Enabled: enabled, Trigger: Trigger{Event: "agent.finished"}, Steps: []Step{{Kind: "run", Command: "echo " + says}}}
}

func TestFlowLayersMergeByIDTheMostLocalWinning(t *testing.T) {
	ctx := context.Background()
	b, _, _ := flowBox(t, []Flow{echoFlow("check", "repo", true), echoFlow("repo-only", "repo", true), echoFlow("lint", "repo", true)})
	if err := b.Locations.setKit("cal", &InstalledKit{ID: "cal-dev", Name: "Cal dev", Config: RepoConfig{Flows: []Flow{echoFlow("check", "kit", true), echoFlow("kit-only", "kit", true), echoFlow("lint", "kit", true)}}}); err != nil {
		t.Fatal(err)
	}
	if err := b.Locations.SetLocalConfig("cal", RepoConfig{Flows: []Flow{echoFlow("check", "local", false)}}); err != nil {
		t.Fatal(err)
	}
	all, err := b.AllFlows(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var listed []string
	for _, sf := range all {
		s := sf.Source + "/" + sf.Flow.ID
		if sf.Overridden {
			s += " (overridden)"
		}
		if sf.Scope != "repo:cal" || sf.Editable != (sf.Source == "local") {
			t.Errorf("%s: scope %s, editable %v", s, sf.Scope, sf.Editable)
		}
		listed = append(listed, s)
	}
	want := "repo/check (overridden),repo/repo-only,repo/lint (overridden),kit/check (overridden),kit/kit-only,kit/lint,local/check"
	if got := strings.Join(listed, ","); got != want {
		t.Fatalf("listed %s\nwant   %s", got, want)
	}
	active, _ := b.ActiveFlows(ctx)
	var running []string
	for _, sf := range active {
		running = append(running, sf.Source+"/"+sf.Flow.ID)
	}
	if got := strings.Join(running, ","); got != "repo/repo-only,kit/kit-only,kit/lint,local/check" {
		t.Fatalf("active = %s", got)
	}
}

func TestKitFlowsRunAndAnOverrideRunsInsteadOfTheCommittedFlow(t *testing.T) {
	b, _, wt := flowBox(t, []Flow{echoFlow("check", "committed", true)})
	b.Locations.setKit("cal", &InstalledKit{ID: "cal-dev", Name: "Cal dev", Config: RepoConfig{Flows: []Flow{echoFlow("kit-check", "from-the-kit", true)}}})
	b.Locations.SetLocalConfig("cal", RepoConfig{Flows: []Flow{echoFlow("check", "overridden-here", true)}})
	b.Events.Publish(events.Event{Type: "agent.finished", Data: map[string]any{"path": wt.Path}})

	if run := waitRun(t, b, "kit-check"); run.Status != "succeeded" || strings.TrimSpace(run.Steps[0].Output) != "from-the-kit" || run.Scope != "repo:cal" {
		t.Fatalf("kit run = %+v", run)
	}
	if run := waitRun(t, b, "check"); strings.TrimSpace(run.Steps[0].Output) != "overridden-here" {
		t.Fatalf("check ran %q, want the override", run.Steps[0].Output)
	}
	time.Sleep(300 * time.Millisecond)
	if runs := b.Flows.Runs("check", 10); len(runs) != 1 {
		t.Fatalf("check ran %d times, want only the override", len(runs))
	}
}

func TestADisabledOverrideStopsTheFlowItReplaces(t *testing.T) {
	b, _, wt := flowBox(t, []Flow{echoFlow("check", "committed", true), echoFlow("sentinel", "ok", true)})
	b.Locations.setKit("cal", &InstalledKit{ID: "cal-dev", Name: "Cal dev", Config: RepoConfig{Flows: []Flow{echoFlow("lint", "kit", true)}}})
	b.Locations.SetLocalConfig("cal", RepoConfig{Flows: []Flow{echoFlow("check", "committed", false), echoFlow("lint", "kit", false)}})
	b.Events.Publish(events.Event{Type: "agent.finished", Data: map[string]any{"path": wt.Path}})

	waitRun(t, b, "sentinel")
	time.Sleep(300 * time.Millisecond)
	for _, id := range []string{"check", "lint"} {
		if runs := b.Flows.Runs(id, 10); len(runs) != 0 {
			t.Errorf("%s ran %d times though this box switched it off", id, len(runs))
		}
	}
}

// testClock is a clock for Flows.Now that a test moves on.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// testLog keeps what Flows.Logf is given.
type testLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *testLog) logf(format string, args ...any) {
	l.mu.Lock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
	l.mu.Unlock()
}

// with is the lines that contain s.
func (l *testLog) with(s string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, line := range l.lines {
		if strings.Contains(line, s) {
			out = append(out, line)
		}
	}
	return out
}

// await is with, once a line has it or five seconds have gone by.
func (l *testLog) await(s string) []string {
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if got := l.with(s); len(got) > 0 {
			return got
		}
	}
	return l.with(s)
}

// clocked gives a flow box the test clock and log.
func clocked(c *testClock, l *testLog) func(*Box) {
	return func(b *Box) { b.Flows.Now, b.Flows.Logf = c.now, l.logf }
}

func waitRuns(t *testing.T, b *Box, flow string, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for len(b.Flows.Runs(flow, 50)) < n {
		if time.Now().After(deadline) {
			t.Fatalf("%d runs of %s, want %d", len(b.Flows.Runs(flow, 50)), flow, n)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestAStartTheLimitRefusesIsCountedAndLoggedOncePerStreak(t *testing.T) {
	clock, logs := &testClock{t: time.Date(2026, 11, 24, 10, 0, 0, 0, time.Local)}, &testLog{}
	b, _, wt := flowBox(t, []Flow{{
		ID: "count", Name: "Count", Enabled: true, MaxRunsPerHour: 2,
		Trigger: Trigger{Event: "worktree.changed"},
		Steps:   []Step{{Kind: "run", Command: "true"}},
	}}, clocked(clock, logs))
	for range 4 {
		b.Events.Publish(events.Event{Type: "worktree.changed", Data: map[string]any{"path": wt.Path}})
		time.Sleep(300 * time.Millisecond)
		clock.add(time.Minute)
	}
	settleRuns(b)
	if runs := b.Flows.Runs("count", 10); len(runs) != 2 {
		t.Fatalf("%d runs, want the hourly limit of 2", len(runs))
	}
	n, last := b.Flows.refusals("repo:cal/count")
	if n != 2 || !last.Equal(time.Date(2026, 11, 24, 10, 3, 0, 0, time.Local)) {
		t.Fatalf("refused %d, last at %v; want 2, the last at 10:03", n, last)
	}
	reached := logs.with("reached its limit")
	if len(reached) != 1 || !strings.Contains(reached[0], "repo:cal/count") || !strings.Contains(reached[0], "limit of 2 runs an hour") || !strings.Contains(reached[0], "event") {
		t.Fatalf("limit lines = %q", reached)
	}
	if got := logs.with("refused 10:"); len(got) != 0 {
		t.Fatalf("summed up while still refusing: %q", got)
	}

	// An hour on, the window has room again: the start is allowed, and the
	// streak it ends is summed up in one line.
	clock.add(time.Hour)
	b.Events.Publish(events.Event{Type: "worktree.changed", Data: map[string]any{"path": wt.Path}})
	waitRuns(t, b, "count", 3)
	if got := logs.await("starts refused"); len(got) != 1 || !strings.Contains(got[0], "repo:cal/count: 2 starts refused 10:02–10:03") {
		t.Fatalf("summary lines = %q", got)
	}
	if n, last := b.Flows.refusals("repo:cal/count"); n != 0 || !last.IsZero() {
		t.Fatalf("%d refusals in the last hour, the last at %v, an hour after the last", n, last)
	}
}

func TestTheFlowListSaysWhatTheLimitRefusedAndWarnsOfASchedule(t *testing.T) {
	ctx := context.Background()
	b, _, _ := flowBox(t, []Flow{
		{ID: "every-minute", Name: "Every minute", Trigger: Trigger{Schedule: "* * * * *"}, Steps: []Step{{Kind: "run", Command: "true"}}},
		{ID: "five", Name: "Every five", Trigger: Trigger{Schedule: "*/5 * * * *"}, Steps: []Step{{Kind: "run", Command: "true"}}},
		{ID: "each", Name: "Each worktree", Trigger: Trigger{Schedule: "*/5 * * * *", EachWorktree: true}, Steps: []Step{{Kind: "run", Command: "true"}}},
		{ID: "event", Name: "Event", MaxRunsPerHour: 1, Trigger: Trigger{Event: "agent.finished"}, Steps: []Step{{Kind: "run", Command: "true"}}},
	})
	b.Locations.CreateWorktree(ctx, "cal", "two", "", "")
	b.Locations.CreateWorktree(ctx, "cal", "three", "", "")
	b.Flows.allowRate("repo:cal/event", 1, "api")
	b.Flows.allowRate("repo:cal/event", 1, "api")

	rec := httptest.NewRecorder()
	if err := b.listFlows(rec, httptest.NewRequest("GET", "/v1/flows", nil)); err != nil {
		t.Fatal(err)
	}
	var got []ScopedFlow
	json.Unmarshal(rec.Body.Bytes(), &got)
	by := map[string]ScopedFlow{}
	for _, sf := range got {
		by[sf.Flow.ID] = sf
	}
	if f := by["every-minute"]; f.FiresPerHour != 60 || f.Warning != "This schedule fires up to 60 times an hour; the limit is 20, so about 40 starts an hour will be refused." {
		t.Errorf("every minute: %d %q", f.FiresPerHour, f.Warning)
	}
	if f := by["five"]; f.FiresPerHour != 12 || f.Warning != "" {
		t.Errorf("every five minutes: %d %q", f.FiresPerHour, f.Warning)
	}
	// Three worktrees, one limit.
	if f := by["each"]; f.FiresPerHour != 36 || !strings.Contains(f.Warning, "up to 36 times an hour across its worktrees, which share the limit") {
		t.Errorf("each worktree: %d %q", f.FiresPerHour, f.Warning)
	}
	if f := by["event"]; f.RefusedLastHour != 1 || f.LastRefusedAt.IsZero() || f.FiresPerHour != 0 || f.Warning != "" {
		t.Errorf("event flow: %+v", f)
	}
	if !strings.Contains(rec.Body.String(), `"refused_last_hour":1`) || !strings.Contains(rec.Body.String(), `"last_refused_at":`) {
		t.Errorf("GET /v1/flows = %s", rec.Body.String())
	}
}

func TestARateLimitedRunIs429AndAFullQueueKeepsItsSlot(t *testing.T) {
	b, do := runsBox(t)
	steps := []Step{{Kind: "run", Command: "sleep 30"}}
	if st := do("PUT", "/v1/flows", map[string]any{"flows": []Flow{
		{ID: "once", Name: "Once", MaxRunsPerHour: 1, Trigger: Trigger{Event: "agent.finished"}, Steps: []Step{{Kind: "run", Command: "true"}}},
		{ID: "queued", Name: "Queued", MaxRunsPerHour: 3, Queue: 1, Trigger: Trigger{Event: "agent.finished"}, Steps: steps},
	}}, nil); st != 200 {
		t.Fatalf("PUT /v1/flows: %d", st)
	}
	var s runs.Summary
	if st := do("POST", "/v1/runs", RunRequest{FlowID: "once"}, &s); st != 202 {
		t.Fatalf("first start: %d", st)
	}
	var e struct {
		Error string `json:"error"`
	}
	if st := do("POST", "/v1/runs", RunRequest{FlowID: "once"}, &e); st != 429 {
		t.Fatalf("a start past the limit: %d %q, want 429", st, e.Error)
	}

	// One runs, one waits, and the third finds the queue full: that one
	// takes none of the three starts an hour.
	var first, second runs.Summary
	do("POST", "/v1/runs", RunRequest{FlowID: "queued"}, &first)
	do("POST", "/v1/runs", RunRequest{FlowID: "queued"}, &second)
	if st := do("POST", "/v1/runs", RunRequest{FlowID: "queued"}, nil); st != 409 {
		t.Fatalf("a start with the queue full: %d, want 409", st)
	}
	b.Runs.Cancel(first.ID)
	waitRunStatus(t, b, second.ID, runs.Running)
	var fourth runs.Summary
	if st := do("POST", "/v1/runs", RunRequest{FlowID: "queued"}, &fourth); st != 202 {
		t.Fatalf("a start once the queue has room: %d, want 202 (the full queue used a slot)", st)
	}
	for _, id := range []string{second.ID, fourth.ID} {
		b.Runs.Cancel(id)
	}
}
