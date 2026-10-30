package box

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/hooks"
)

// stopFixture is a box with a repo "cal" and its worktrees, each with an
// agent in it: a session running claude, so the box counts it as one,
// which is cat here.
type stopFixture struct {
	b      *Box
	do     func(method, path string, in, out any, header ...string) int
	repo   string
	count  string // a line per archive script run
	agents map[string]string
}

func newStopFixture(t *testing.T, script string, worktrees ...string) *stopFixture {
	t.Helper()
	t.Setenv("SHELL", "/bin/sh")
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nexec cat\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	b, do := runsBox(t)
	f := &stopFixture{b: b, do: do, repo: gitRepo(t), count: filepath.Join(t.TempDir(), "archived"), agents: map[string]string{}}
	if st := do("POST", "/v1/locations", map[string]string{"name": "cal", "path": f.repo}, nil); st != 200 {
		t.Fatalf("add location: %d", st)
	}
	for _, wt := range worktrees {
		if st := do("POST", "/v1/locations/cal/worktrees", WorktreeRequest{Name: wt}, nil); st != 200 {
			t.Fatalf("add worktree %s: %d", wt, st)
		}
		f.agents[wt] = f.agent(t, wt, "agent-"+wt)
	}
	if script != "" {
		if st := do("PUT", "/v1/locations/cal/scripts", map[string]string{"archive": strings.ReplaceAll(script, "COUNT", f.count)}, nil); st != 200 {
			t.Fatalf("set scripts: %d", st)
		}
	}
	return f
}

func (f *stopFixture) agent(t *testing.T, wt, name string) string {
	t.Helper()
	var s Session
	if st := f.do("POST", "/v1/sessions", SessionRequest{Name: name, Location: "cal/" + wt, Command: "claude"}, &s); st != 200 {
		t.Fatalf("start %s in %s: %d", name, wt, st)
	}
	return s.Name
}

func (f *stopFixture) worktree(name string) Worktree {
	loc, _ := f.b.Locations.Get(context.Background(), "cal")
	for _, w := range loc.Worktrees {
		if w.Name == name {
			return w
		}
	}
	return Worktree{}
}

func (f *stopFixture) item(t *testing.T, name string) map[string]string {
	t.Helper()
	w := f.worktree(name)
	if w.Path == "" {
		t.Fatalf("no worktree %s", name)
	}
	return map[string]string{"location": "cal", "name": name, "path": w.Path}
}

func (f *stopFixture) start(t *testing.T, sessions []string, worktrees []map[string]string) runs.Summary {
	t.Helper()
	var s runs.Summary
	if st := f.do("POST", "/v1/runs", RunRequest{Template: "stop", Params: map[string]any{"sessions": sessions, "worktrees": worktrees}}, &s); st != 202 {
		t.Fatalf("start stop run: %d", st)
	}
	return s
}

func (f *stopFixture) archives() int {
	b, _ := os.ReadFile(f.count)
	return strings.Count(string(b), "\n")
}

func (f *stopFixture) live(t *testing.T) map[string]bool {
	t.Helper()
	all, err := f.b.Sessions.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, s := range all {
		if !s.Exited {
			out[s.Name] = true
		}
	}
	return out
}

// stepAt finds a step by its path in a run's tree.
func stepAt(steps []runs.StepRun, path string) (runs.StepRun, bool) {
	for _, s := range steps {
		if s.Path == path {
			return s, true
		}
		if strings.HasPrefix(path, s.Path+".") {
			return stepAt(s.Children, path)
		}
	}
	return runs.StepRun{}, false
}

// A stop run stops its agents, then archives each worktree where that's
// safe: one with uncommitted work, one where another agent still runs and
// one whose agent the box wouldn't stop are kept as they are, with why.
// Branches stay; a session or worktree already gone counts as done.
func TestAStopRunArchivesOnlyWhatIsSafe(t *testing.T) {
	f := newStopFixture(t, "", "clean", "dirty", "shared", "held")
	os.WriteFile(filepath.Join(f.worktree("dirty").Path, "notes.txt"), []byte("wip"), 0o600)
	other := f.agent(t, "shared", "outsider")
	cfg := filepath.Join(t.TempDir(), "hooks.json")
	os.WriteFile(cfg, []byte(`{"hooks":[{"on":"before:session.stop","run":"if grep -q agent-held; then echo held back; exit 1; fi"}]}`), 0o600)
	f.b.Hooks = &hooks.Runner{Path: cfg}

	sessions := []string{f.agents["clean"], f.agents["dirty"], f.agents["shared"], f.agents["held"], "never-was"}
	items := []map[string]string{f.item(t, "clean"), f.item(t, "dirty"), f.item(t, "shared"), f.item(t, "held"), {"location": "cal", "name": "gone-already", "path": "/nowhere"}}
	s := f.start(t, sessions, items)
	r := waitRunStatus(t, f.b, s.ID, runs.Failed, runs.Succeeded)

	want := map[string][2]string{
		"0.i0.0": {runs.Succeeded, "stopped"},
		"0.i3.0": {runs.Failed, ""},
		"0.i4.0": {runs.Succeeded, "already stopped"},
		"1.i0.0": {runs.Succeeded, stopArchived},
		"1.i1.0": {runs.Skipped, keptDirty},
		"1.i2.0": {runs.Skipped, keptOtherAgent},
		"1.i3.0": {runs.Skipped, keptStopFailed},
		"1.i4.0": {runs.Succeeded, "already gone"},
	}
	for path, w := range want {
		st, ok := stepAt(r.Steps, path)
		if !ok || st.Status != w[0] || (w[1] != "" && st.Output != w[1]) {
			t.Errorf("step %s = %+v, want %s %q", path, st, w[0], w[1])
		}
	}
	if st, _ := stepAt(r.Steps, "0.i3.0"); !strings.Contains(st.Error, "held back") {
		t.Errorf("the refused stop says %q", st.Error)
	}
	if f.worktree("clean").Path != "" {
		t.Error("the clean worktree is still there")
	}
	for _, kept := range []string{"dirty", "shared", "held"} {
		if f.worktree(kept).Path == "" {
			t.Errorf("%s was archived", kept)
		}
	}
	if out, err := git(context.Background(), "-C", f.repo, "branch", "--list", "clean"); err != nil || !strings.Contains(string(out), "clean") {
		t.Errorf("the archived worktree's branch went: %q %v", out, err)
	}
	live := f.live(t)
	if !live[other] || !live[f.agents["held"]] || live[f.agents["clean"]] || live[f.agents["dirty"]] {
		t.Errorf("live sessions after the run: %v", live)
	}
}

// A removal stopped halfway leaves a folder with no .git, or none at all:
// the stop run finishes both, and keeps their branches.
func TestAStopRunFinishesAHalfRemovedWorktree(t *testing.T) {
	// Its archive script ran before the removal that was stopped: it isn't
	// run again on what's left, which may no longer have what it needs.
	f := newStopFixture(t, "echo run >> COUNT", "half", "gone", "dirty")
	os.WriteFile(filepath.Join(f.repo, ".git", "info", "exclude"), []byte("node_modules\n"), 0o644)
	items := []map[string]string{f.item(t, "half"), f.item(t, "gone"), f.item(t, "dirty")}
	os.WriteFile(filepath.Join(items[2]["path"], "notes.txt"), []byte("wip"), 0o600)
	os.Remove(filepath.Join(items[2]["path"], ".git"))
	half, gone := items[0]["path"], items[1]["path"]
	os.MkdirAll(filepath.Join(half, "node_modules", "left"), 0o755)
	os.WriteFile(filepath.Join(half, "node_modules", "left", "index.js"), []byte("x"), 0o644)
	if err := os.Remove(filepath.Join(half, ".git")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	s := f.start(t, []string{f.agents["half"], f.agents["gone"], f.agents["dirty"]}, items)
	r := waitRunStatus(t, f.b, s.ID, runs.Failed, runs.Succeeded)
	for path, out := range map[string][2]string{"1.i0.0": {runs.Succeeded, stopArchived}, "1.i1.0": {runs.Succeeded, "already gone"}, "1.i2.0": {runs.Skipped, keptDirty}} {
		if st, _ := stepAt(r.Steps, path); st.Status != out[0] || st.Output != out[1] {
			t.Errorf("step %s = %+v, want %s %q", path, st, out[0], out[1])
		}
	}
	if n := f.archives(); n != 0 {
		t.Errorf("the archive script ran %d times on what was left", n)
	}
	if _, err := os.Stat(filepath.Join(items[2]["path"], "notes.txt")); err != nil {
		t.Errorf("the half-removed worktree with work in it lost it: %v", err)
	}
	if _, err := os.Stat(half); !os.IsNotExist(err) {
		t.Errorf("what was left of the half-removed worktree is still there: %v", err)
	}
	out, _ := git(context.Background(), "-C", f.repo, "worktree", "list", "--porcelain")
	if strings.Contains(string(out), half) || strings.Contains(string(out), gone) {
		t.Errorf("git still lists them:\n%s", out)
	}
	for _, br := range []string{"half", "gone", "dirty"} {
		if !branchExists(context.Background(), f.repo, "refs/heads/"+br) {
			t.Errorf("branch %s went", br)
		}
	}
}

// A removal git fails without a word says how it ended, never a bare
// "git worktree remove:".
func TestAStopRunSaysWhyARemovalFailed(t *testing.T) {
	f := newStopFixture(t, "", "stuck")
	fakeGitRemove(t, "exit 1")
	s := f.start(t, []string{f.agents["stuck"]}, []map[string]string{f.item(t, "stuck")})
	r := waitRunStatus(t, f.b, s.ID, runs.Failed, runs.Succeeded)
	st, _ := stepAt(r.Steps, "1.i0.0")
	if st.Status != runs.Failed || !strings.Contains(st.Error, "failed with no output (exit status 1)") {
		t.Fatalf("archive step = %+v, want it failed, saying git exited 1 with no output", st)
	}
}

// berthd stopping in the middle of a worktree's archive script: the
// resumed run goes on from there and never runs a script twice.
func TestAResumedStopRunNeverArchivesTwice(t *testing.T) {
	f := newStopFixture(t, "echo run >> COUNT; sleep 1", "one", "two")
	dir := filepath.Join(t.TempDir(), "runs")
	ctx, stop := context.WithCancel(context.Background())
	f.b.NewRuns(dir, 0, 0, nil)
	f.b.Runs.Resume(ctx)

	s := f.start(t, []string{f.agents["one"], f.agents["two"]}, []map[string]string{f.item(t, "one"), f.item(t, "two")})
	deadline := time.Now().Add(10 * time.Second)
	for f.archives() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	stop()
	f.b.Runs.Wait()

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); f.b.Runs.Wait() })
	f.b.NewRuns(dir, 0, 0, nil)
	// The archive in flight is left unfinished in the journal, for the
	// resumed run to ask again.
	if r, _ := f.b.Runs.Get(s.ID); r.Status == runs.Succeeded {
		t.Fatalf("the run finished as berthd stopped: %+v", r.Steps)
	} else if st, ok := stepAt(r.Steps, "1.i0.0"); !ok || st.Status != runs.Running {
		t.Fatalf("the archive in flight = %+v", st)
	}
	f.b.Runs.Resume(ctx)
	waitRunStatus(t, f.b, s.ID, runs.Succeeded)
	deadline = time.Now().Add(10 * time.Second)
	for (f.worktree("one").Path != "" || f.worktree("two").Path != "") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if f.worktree("one").Path != "" || f.worktree("two").Path != "" {
		t.Fatal("a worktree is still there")
	}
	if n := f.archives(); n != 2 {
		t.Fatalf("the archive script ran %d times for two worktrees", n)
	}
}

// Two runs archiving the same worktree: the second waits for the first's
// archive and says how it went, rather than running the script again.
func TestADuplicateStopRunJoinsTheArchiveInFlight(t *testing.T) {
	f := newStopFixture(t, "echo run >> COUNT; sleep 1", "dup")
	item := f.item(t, "dup")
	a := f.start(t, []string{f.agents["dup"]}, []map[string]string{item})
	deadline := time.Now().Add(10 * time.Second)
	for f.archives() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	b := f.start(t, []string{f.agents["dup"]}, []map[string]string{item})
	for _, id := range []string{a.ID, b.ID} {
		r := waitRunStatus(t, f.b, id, runs.Succeeded)
		if st, _ := stepAt(r.Steps, "1.i0.0"); st.Output != stopArchived && st.Output != "already gone" {
			t.Errorf("run %s's archive = %+v", id, st)
		}
	}
	if n := f.archives(); n != 1 {
		t.Fatalf("the archive script ran %d times", n)
	}
}

// Cancelling a stop run: the archive in flight finishes on the box, and
// the worktrees not yet started are left as they are.
func TestCancellingAStopRunSkipsWhatHasNotStarted(t *testing.T) {
	f := newStopFixture(t, "echo run >> COUNT; sleep 1", "first", "second", "third")
	s := f.start(t, []string{f.agents["first"], f.agents["second"], f.agents["third"]}, []map[string]string{f.item(t, "first"), f.item(t, "second"), f.item(t, "third")})
	deadline := time.Now().Add(10 * time.Second)
	for f.archives() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if st := f.do("POST", "/v1/runs/"+s.ID+"/cancel", nil, nil); st != 200 {
		t.Fatalf("cancel: %d", st)
	}
	r := waitRunStatus(t, f.b, s.ID, runs.Cancelled)
	if st, _ := stepAt(r.Steps, "1.i0.0"); st.Output != stopArchiving {
		t.Errorf("the archive in flight = %+v", st)
	}
	for _, p := range []string{"1.i1.0", "1.i2.0"} {
		if st, ok := stepAt(r.Steps, p); ok {
			t.Errorf("step %s ran after the cancel: %+v", p, st)
		}
	}
	deadline = time.Now().Add(10 * time.Second)
	for f.worktree("first").Path != "" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if f.worktree("first").Path != "" || f.worktree("second").Path == "" || f.worktree("third").Path == "" {
		t.Fatalf("after the cancel: first %q, second %q, third %q", f.worktree("first").Path, f.worktree("second").Path, f.worktree("third").Path)
	}
	if n := f.archives(); n != 1 {
		t.Fatalf("the archive script ran %d times", n)
	}
}

// An agent started in a worktree while its archive script runs keeps it:
// the folder going would end that agent.
func TestAnAgentStartedDuringTheArchiveKeepsTheWorktree(t *testing.T) {
	f := newStopFixture(t, "echo run >> COUNT; sleep 1", "late")
	s := f.start(t, []string{f.agents["late"]}, []map[string]string{f.item(t, "late")})
	deadline := time.Now().Add(10 * time.Second)
	for f.archives() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	newcomer := f.agent(t, "late", "newcomer")
	r := waitRunStatus(t, f.b, s.ID, runs.Succeeded, runs.Failed)
	if st, _ := stepAt(r.Steps, "1.i0.0"); st.Status != runs.Skipped || st.Output != keptOtherAgent {
		t.Fatalf("the archive = %+v", st)
	}
	if f.worktree("late").Path == "" || !f.live(t)[newcomer] {
		t.Fatalf("the worktree went (%q) or the newcomer stopped (%v)", f.worktree("late").Path, f.live(t))
	}
}

// Two stop runs archiving on one box take turns: the second's archive
// script starts only once the first's worktree is gone.
func TestStopRunsOnABoxArchiveOneAtATime(t *testing.T) {
	f := newStopFixture(t, "echo start >> COUNT; sleep 0.5; echo end >> COUNT", "left", "right")
	a := f.start(t, []string{f.agents["left"]}, []map[string]string{f.item(t, "left")})
	b := f.start(t, []string{f.agents["right"]}, []map[string]string{f.item(t, "right")})
	for _, id := range []string{a.ID, b.ID} {
		r := waitRunStatus(t, f.b, id, runs.Succeeded)
		if st, _ := stepAt(r.Steps, "1.i0.0"); st.Output != stopArchived {
			t.Errorf("run %s's archive = %+v", id, st)
		}
	}
	if b, _ := os.ReadFile(f.count); string(b) != "start\nend\nstart\nend\n" {
		t.Fatalf("the archive scripts ran side by side: %q", b)
	}
}

// A review worktree whose folder went while berthd was down is finished
// by a stop run like any other: its review mark and ref go, and the app
// hears so.
func TestAStopRunFinishingAGoneReviewWorktreeSaysTheReviewWent(t *testing.T) {
	f := newStopFixture(t, "", "pr-7")
	wt := f.worktree("pr-7")
	f.b.Locations.setReview("cal", wt.Path, &ReviewMark{Repo: "acme/shop", PR: 7})
	if out, err := exec.Command("git", "-C", f.repo, "update-ref", reviewRef(7), "HEAD").CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	item := f.item(t, "pr-7")
	if err := os.RemoveAll(wt.Path); err != nil {
		t.Fatal(err)
	}
	ch, unsubscribe := f.b.Events.Subscribe()
	defer unsubscribe()
	r := waitRunStatus(t, f.b, f.start(t, []string{}, []map[string]string{item}).ID, runs.Failed, runs.Succeeded)
	if st, _ := stepAt(r.Steps, "1.i0.0"); st.Status != runs.Succeeded || st.Output != "already gone" {
		t.Fatalf("archive step = %+v", st)
	}
	if _, m := f.b.Locations.reviewAt(wt.Path); m != nil {
		t.Errorf("the review mark is still there: %+v", m)
	}
	if out, err := exec.Command("git", "-C", f.repo, "rev-parse", "--verify", "-q", reviewRef(7)).CombinedOutput(); err == nil {
		t.Errorf("the review ref is still there: %s", out)
	}
	for {
		select {
		case e := <-ch:
			if e.Type == "review.removed" {
				if e.Data["pr"] != 7 || e.Data["path"] != wt.Path {
					t.Errorf("review.removed = %+v", e.Data)
				}
				return
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no review.removed")
		}
	}
}

// No session starts between a stop run's last look for agents and its
// worktree going: one asked for meanwhile waits, then finds no folder.
func TestNoAgentStartsUnseenAsAWorktreeGoes(t *testing.T) {
	f := newStopFixture(t, "", "last", "elsewhere")
	looking, done := make(chan struct{}), make(chan struct{})
	removed := make(chan error, 1)
	go func() {
		removed <- f.b.removeAfter(f.worktree("last").Path, func() error {
			close(looking)
			<-done
			return nil
		}, func() error { return f.b.Locations.RemoveWorktree(context.Background(), "cal", "last", true) })
	}()
	<-looking
	// A session anywhere else starts meanwhile: a removal git takes
	// minutes over holds up only its own folder.
	bystander := make(chan int, 1)
	go func() {
		bystander <- f.do("POST", "/v1/sessions", SessionRequest{Name: "bystander", Location: "cal/elsewhere", Command: "claude"}, nil)
	}()
	select {
	case st := <-bystander:
		if st != 200 {
			t.Errorf("a session in another worktree during the last look: %d", st)
		}
	case <-time.After(5 * time.Second):
		t.Error("a session in another worktree waited for the last look")
	}
	started := make(chan int, 1)
	go func() {
		started <- f.do("POST", "/v1/sessions", SessionRequest{Name: "latecomer", Location: "cal/last", Command: "claude"}, nil)
	}()
	select {
	case st := <-started:
		t.Fatalf("a session started (%d) during the last look", st)
	case <-time.After(300 * time.Millisecond):
	}
	close(done)
	if err := <-removed; err != nil {
		t.Fatal(err)
	}
	if st := <-started; st == 200 || f.live(t)["latecomer"] {
		t.Fatalf("a session started in the removed worktree: %d", st)
	}
}
