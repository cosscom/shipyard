package box

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
)

// attemptRepo is acme/shop cloned as the location "shop", with an attempt's
// worktree shop-refunds-a1 on its own branch from origin/main.
func attemptRepo(t *testing.T) (b *Box, repo, wt string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_AUTHOR_NAME", "acme")
	t.Setenv("GIT_AUTHOR_EMAIL", "dev@acme.test")
	t.Setenv("GIT_COMMITTER_NAME", "acme")
	t.Setenv("GIT_COMMITTER_EMAIL", "dev@acme.test")
	bare := filepath.Join(root, "shop.git")
	runGit(t, root, "init", "-q", "--bare", "-b", "main", bare)
	work := filepath.Join(root, "work")
	os.MkdirAll(work, 0o755)
	runGit(t, work, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(work, "refunds.ts"), []byte("export const refund = 1\n"), 0o644)
	os.WriteFile(filepath.Join(work, "ledger.ts"), []byte("a\nb\nc\n"), 0o644)
	runGit(t, work, "add", "-A")
	runGit(t, work, "commit", "-q", "-m", "shop")
	runGit(t, work, "push", "-q", bare, "HEAD:refs/heads/main")
	repo = filepath.Join(root, "shop")
	runGit(t, root, "clone", "-q", bare, repo)
	wt = filepath.Join(root, "shop-refunds-a1")
	runGit(t, repo, "worktree", "add", "-q", "-b", "refunds-a1", wt, "origin/main")
	b = &Box{Name: "devbox", Locations: NewLocations(filepath.Join(root, "box", "locations.json"))}
	if _, err := b.Locations.Add(context.Background(), "shop", repo); err != nil {
		t.Fatal(err)
	}
	return b, repo, wt
}

// An attempt that committed some of its work and left the rest in the
// worktree counts all of it, as the file list under it shows it.
func TestDiffSummaryCountsCommittedAndUncommitted(t *testing.T) {
	b, _, wt := attemptRepo(t)
	ctx := context.Background()
	os.WriteFile(filepath.Join(wt, "refunds.ts"), []byte("export const refund = 1\nexport const partial = 2\n"), 0o644)
	runGit(t, wt, "commit", "-q", "-am", "feat: partial refunds")
	os.WriteFile(filepath.Join(wt, "ledger.ts"), []byte("a\nc\n"), 0o644)                 // not committed
	os.WriteFile(filepath.Join(wt, "refunds.test.ts"), []byte("test 1\ntest 2\n"), 0o644) // untracked
	base := b.attemptBase(ctx, "", "shop")
	if base != "origin/main" {
		t.Fatalf("base %q, want origin/main", base)
	}
	d := diffSummary(ctx, wt, base)
	if d.files != 3 || d.added != 3 || d.removed != 1 || d.commits != 1 {
		t.Fatalf("diff %+v, want 3 files +3 -1, 1 commit", d)
	}
	if !d.dirty || d.head != runGit(t, wt, "rev-parse", "HEAD") || d.subjects != "feat: partial refunds" {
		t.Fatalf("version %q dirty %v subjects %q", d.head, d.dirty, d.subjects)
	}
	paths := map[string]bool{}
	for _, f := range d.list {
		paths[f.Path] = true
	}
	if len(d.list) != d.files || !paths["refunds.ts"] || !paths["ledger.ts"] || !paths["refunds.test.ts"] {
		t.Fatalf("files %+v", d.list)
	}
}

// A clone whose checkout has no local main (it sits on another branch)
// still compares an attempt with origin's main: the summary used to say
// "0 files, 0 commits" for work that was all committed.
func TestAttemptBaseWithoutLocalDefaultBranch(t *testing.T) {
	b, repo, wt := attemptRepo(t)
	ctx := context.Background()
	runGit(t, repo, "checkout", "-q", "-b", "dev")
	runGit(t, repo, "branch", "-q", "-D", "main")
	os.WriteFile(filepath.Join(wt, "refunds.ts"), []byte("export const refund = 2\n"), 0o644)
	runGit(t, wt, "commit", "-q", "-am", "fix: refund")
	if d := diffSummary(ctx, wt, "main"); d.files != 0 || d.commits != 0 {
		t.Fatalf("against a missing main: %+v (the old base)", d)
	}
	d := diffSummary(ctx, wt, b.attemptBase(ctx, "", "shop"))
	if d.files != 1 || d.added != 1 || d.removed != 1 || d.commits != 1 || d.dirty {
		t.Fatalf("diff %+v, want 1 file +1 -1, 1 commit, clean", d)
	}
}

// Over the API: a run waiting at its pick has its attempts judged again,
// read from the worktree as it is now, and Review's Compare gets every
// evaluation and the worktree's changes now.
func TestRejudgeOverTheAPI(t *testing.T) {
	b, do := runsBox(t)
	repo := gitRepo(t)
	do("POST", "/v1/locations", map[string]string{"name": "shop", "path": repo}, nil)
	flow := []runs.Step{
		{Kind: "collect", Mode: "attempt"},
		{Kind: "judge", By: "check", When: "always"},
		{Kind: "gate", Pick: true, Title: "Pick one", When: "always"},
	}
	var s runs.Summary
	if st := do("POST", "/v1/runs", RunRequest{Flow: flow, Path: repo}, &s); st != 202 {
		t.Fatalf("start: %d", st)
	}
	waitRunStatus(t, b, s.ID, runs.WaitingGate)
	var missing map[string]any
	if st := do("POST", "/v1/runs/r_nope/judge", nil, &missing); st != 404 {
		t.Fatalf("no such run: %d", st)
	}

	// The agent goes on: a file it adds after the run collected it.
	os.WriteFile(filepath.Join(repo, "refunds.ts"), []byte("one\ntwo\n"), 0o644)
	var ev runs.Evaluation
	if st := do("POST", "/v1/runs/"+s.ID+"/judge", nil, &ev); st != 202 || ev.N != 2 || ev.Status != runs.Running || !ev.Rerun {
		t.Fatalf("rejudge: %d %+v", st, ev)
	}
	var compare struct {
		Gate        *runs.Gate        `json:"gate"`
		Judge       string            `json:"judge"`
		CanRejudge  bool              `json:"can_rejudge"`
		Evaluations []runs.Evaluation `json:"evaluations"`
		Candidates  []struct {
			runs.Candidate
			Now struct {
				Files []ReviewFile `json:"files"`
				Head  string       `json:"head"`
				Dirty bool         `json:"dirty"`
			} `json:"now"`
		} `json:"candidates"`
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		do("GET", "/v1/review?run="+s.ID, nil, &compare)
		if len(compare.Evaluations) == 2 && compare.Evaluations[1].Status != runs.Running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the rerun never ended: %+v", compare.Evaluations)
		}
		time.Sleep(20 * time.Millisecond)
	}
	ev = compare.Evaluations[1]
	// No attempt passed a check here: a failure, with nothing to fall back on.
	if ev.Status != runs.Failed || ev.Winner != nil || ev.Error != "no attempt passed its check" || compare.Judge != ev.Output {
		t.Fatalf("rerun %+v, judge line %q", ev, compare.Judge)
	}
	if len(ev.Versions) != 1 || !ev.Versions[0].Dirty || ev.Versions[0].Files != 1 || ev.Versions[0].Head == "" {
		t.Fatalf("versions %+v", ev.Versions)
	}
	c := compare.Candidates[0]
	if !compare.CanRejudge || compare.Gate == nil || c.Diff.Files != 1 || len(c.Now.Files) != 1 || c.Now.Files[0].Path != "refunds.ts" || !c.Now.Dirty {
		t.Fatalf("compare %+v", compare)
	}
	if r, _ := b.Runs.Get(s.ID); r.Status != runs.WaitingGate {
		t.Fatalf("the run moved on: %s", r.Status)
	}
	var busy map[string]any
	do("POST", "/v1/runs/"+s.ID+"/gates/current/decide", GateDecision{Approve: false}, nil)
	waitRunStatus(t, b, s.ID, runs.Failed)
	if st := do("POST", "/v1/runs/"+s.ID+"/judge", nil, &busy); st != 409 {
		t.Fatalf("rejudge after the gate: %d %v", st, busy)
	}
}

// Rerunning the judge reads each attempt's worktree again: what an agent
// did after the run collected it counts.
func TestRefreshReadsWorktreesAgain(t *testing.T) {
	b, _, wt := attemptRepo(t)
	h := &runHost{b: b, env: map[string]*runEnv{}}
	cands := []runs.Candidate{{Index: 0, Location: "shop", Path: wt, Summary: "stale"}, {Index: 1, Location: "shop", Path: filepath.Join(wt, "gone")}}
	cands[0].Verify.Passed = true
	before := h.Refresh(context.Background(), runs.Summary{}, map[string]string{}, cands)
	if before[0].Diff.Files != 0 || before[0].Dirty || before[0].Head == "" {
		t.Fatalf("clean worktree: %+v", before[0])
	}
	os.WriteFile(filepath.Join(wt, "ledger.ts"), []byte("a\nb\nc\nd\n"), 0o644)
	after := h.Refresh(context.Background(), runs.Summary{}, map[string]string{}, cands)
	if after[0].Diff.Files != 1 || after[0].Diff.Added != 1 || !after[0].Dirty || after[0].Summary != "" || !after[0].Verify.Passed {
		t.Fatalf("after a change: %+v", after[0])
	}
	if after[1].Head != "" || after[1].Diff.Files != 0 {
		t.Fatalf("a worktree that is gone: %+v", after[1])
	}
	if cands[0].Summary != "stale" {
		t.Fatal("Refresh changed its input")
	}
}
