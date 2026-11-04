package box

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseWorktrees(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "cal")
	billing := filepath.Join(dir, "cal-billing")
	other := filepath.Join(dir, "tailmux-smoke")
	for _, d := range []string{repo, billing, other} {
		os.MkdirAll(d, 0o755)
		os.WriteFile(filepath.Join(d, ".git"), []byte("gitdir: elsewhere\n"), 0o644)
	}
	out := []byte("worktree " + repo + "\nHEAD 5fdc8af8dd0123456789\nbranch refs/heads/main\n\n" +
		"worktree " + billing + "\nHEAD 62d41c1302abcdef\nbranch refs/heads/billing/4-customer-credit\n\n" +
		"worktree " + other + "\nHEAD 0d0ca9d73f000000\ndetached\n\n" +
		"worktree /tmp/gone-for-good\nHEAD 2301306497000000\ndetached\nprunable gitdir file points to non-existent location\n\n")
	got := parseWorktrees(out, repo)
	want := []Worktree{
		{Name: "cal", Path: repo, Branch: "main", Head: "5fdc8af8dd", Main: true},
		{Name: "billing", Path: billing, Branch: "billing/4-customer-credit", Head: "62d41c1302"},
		{Name: "tailmux-smoke", Path: other, Head: "0d0ca9d73f"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d worktrees, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("worktree %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(root, "cal")
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	os.MkdirAll(repo, 0o755)
	run("init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(repo, "README"), []byte("hi"), 0o644)
	run("add", ".")
	run("commit", "-q", "-m", "init")
	return repo
}

func TestLocationsWithWorktreesEndToEnd(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	loc, err := l.Add(ctx, "cal", repo)
	if err != nil {
		t.Fatal(err)
	}
	if !loc.Repo || len(loc.Worktrees) != 1 || !loc.Worktrees[0].Main {
		t.Fatalf("new repo location = %+v", loc)
	}
	wt, err := l.CreateWorktree(ctx, "cal", "billing", "alex/billing", "main")
	if err != nil {
		t.Fatal(err)
	}
	wantPath := filepath.Join(filepath.Dir(repo), "cal-billing")
	if wt.Name != "billing" || wt.Branch != "alex/billing" || wt.Path != wantPath {
		t.Fatalf("worktree = %+v, want billing on alex/billing at %s", wt, wantPath)
	}
	if dir, err := l.Dir(ctx, "cal/billing"); err != nil || dir != wantPath {
		t.Fatalf("Dir(cal/billing) = %q, %v", dir, err)
	}
	if dir, err := l.Dir(ctx, "cal"); err != nil || dir != repo {
		t.Fatalf("Dir(cal) = %q, %v", dir, err)
	}
	// Uncommitted work is protected unless the caller insists.
	os.WriteFile(filepath.Join(wantPath, "wip.txt"), []byte("unsaved"), 0o644)
	if err := l.RemoveWorktree(ctx, "cal", "billing", false); err == nil {
		t.Fatal("removed a worktree with uncommitted changes")
	}
	if err := l.RemoveWorktree(ctx, "cal", "billing", true); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Dir(ctx, "cal/billing"); !errors.Is(err, ErrUnknownWorktree) {
		t.Fatalf("removed worktree still resolves: %v", err)
	}
	if err := l.RemoveWorktree(ctx, "cal", "cal", true); err == nil {
		t.Fatal("removed the main checkout")
	}
}

func TestPlainDirectoriesAreLocationsToo(t *testing.T) {
	dir := t.TempDir()
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	loc, err := l.Add(context.Background(), "scratch", dir)
	if err != nil {
		t.Fatal(err)
	}
	if loc.Repo || len(loc.Worktrees) != 0 {
		t.Fatalf("plain directory reported as a repo: %+v", loc)
	}
	if _, err := l.CreateWorktree(context.Background(), "scratch", "x", "", ""); err == nil {
		t.Fatal("created a worktree in a non-repository")
	}
}

func TestAddRejectsMissingPathsAndBadNames(t *testing.T) {
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	if _, err := l.Add(context.Background(), "gone", "/definitely/not/here"); err == nil {
		t.Fatal("added a missing directory")
	}
	if _, err := l.Add(context.Background(), "bad name", t.TempDir()); err == nil {
		t.Fatal("added an invalid name")
	}
	if err := l.Remove("nope"); !errors.Is(err, ErrUnknownLocation) {
		t.Fatalf("removing unknown: %v", err)
	}
}

func TestAWorktreeChecksOutABranchThatAlreadyExists(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	if out, err := exec.Command("git", "-C", repo, "branch", "feature/review-me").CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	l.Add(ctx, "cal", repo)
	wt, err := l.CreateWorktree(ctx, "cal", "review", "feature/review-me", "main")
	if err != nil {
		t.Fatal(err)
	}
	if wt.Branch != "feature/review-me" {
		t.Fatalf("branch = %q", wt.Branch)
	}
}

// lockWorktree locks a worktree the way git does, by writing its lock file.
func lockWorktree(t *testing.T, repo, name, reason string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, ".git", "worktrees", name, "locked"), []byte(reason), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestArchivingAWorktreeLeftLockedByAnInterruptedAdd(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	if _, err := l.Add(ctx, "cal", repo); err != nil {
		t.Fatal(err)
	}
	wt, err := l.CreateWorktree(ctx, "cal", "audit", "audit", "main")
	if err != nil {
		t.Fatal(err)
	}
	// An add that was killed halfway leaves git's own lock behind.
	lockWorktree(t, repo, "cal-audit", "initializing")
	loc, _ := l.Get(ctx, "cal")
	if w := loc.Worktrees[1]; !w.Locked || w.LockReason != "initializing" {
		t.Fatalf("locked worktree = %+v", w)
	}
	if err := l.RemoveWorktree(ctx, "cal", "audit", false); err != nil {
		t.Fatalf("archiving a worktree an interrupted add left locked: %v", err)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatalf("worktree folder still there: %v", err)
	}
	if _, err := l.Dir(ctx, "cal/audit"); !errors.Is(err, ErrUnknownWorktree) {
		t.Fatalf("removed worktree still resolves: %v", err)
	}
}

func TestAWorktreeSomeoneLockedIsLeftAlone(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	if _, err := l.Add(ctx, "cal", repo); err != nil {
		t.Fatal(err)
	}
	wt, err := l.CreateWorktree(ctx, "cal", "usb", "usb", "main")
	if err != nil {
		t.Fatal(err)
	}
	for _, reason := range []string{"on a USB disk", ""} {
		lockWorktree(t, repo, "cal-usb", reason)
		err := l.RemoveWorktree(ctx, "cal", "usb", true)
		if err == nil {
			t.Fatalf("removed a worktree locked with reason %q", reason)
		}
		if !strings.Contains(err.Error(), "worktree unlock "+wt.Path) || statusFor(err) != 409 {
			t.Fatalf("refusal doesn't say how to unlock: %v (status %d)", err, statusFor(err))
		}
		if reason != "" && !strings.Contains(err.Error(), reason) {
			t.Fatalf("refusal doesn't give the reason: %v", err)
		}
		if _, err := os.Stat(wt.Path); err != nil {
			t.Fatalf("locked worktree's folder went: %v", err)
		}
	}
}

// submoduleGit runs git in dir for a test, local submodule clones allowed.
func submoduleGit(t *testing.T) func(dir string, args ...string) {
	return func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "protocol.file.allow=always"}, args...)...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
}

func TestAWorktreeWithSubmodulesIsRemovedWhenNothingWouldBeLost(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	run := submoduleGit(t)
	lib := filepath.Join(filepath.Dir(repo), "lib")
	os.MkdirAll(lib, 0o755)
	run(lib, "init", "-q", "-b", "main")
	run(lib, "commit", "-q", "--allow-empty", "-m", "lib")
	run(repo, "submodule", "add", "-q", lib, "lib")
	run(repo, "commit", "-q", "-m", "add lib")

	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	if _, err := l.Add(ctx, "cal", repo); err != nil {
		t.Fatal(err)
	}
	wt, err := l.CreateWorktree(ctx, "cal", "vendor", "vendor", "main")
	if err != nil {
		t.Fatal(err)
	}
	run(wt.Path, "submodule", "update", "-q", "--init")
	sub := filepath.Join(wt.Path, "lib")

	kept := func(what, want string) {
		t.Helper()
		err := l.RemoveWorktree(ctx, "cal", "vendor", false)
		if err == nil || !strings.Contains(err.Error(), want) || statusFor(err) != 409 {
			t.Fatalf("%s: err = %v (status %d), want a 409 saying %q", what, err, statusFor(err), want)
		}
		if _, err := os.Stat(wt.Path); err != nil {
			t.Fatalf("%s: the worktree went: %v", what, err)
		}
	}
	os.WriteFile(filepath.Join(sub, "notes"), []byte("wip"), 0o644)
	kept("a file in the submodule", "modified or untracked")
	// Config that hides untracked files from status doesn't hide them here.
	run(wt.Path, "config", "status.showUntrackedFiles", "no")
	run(sub, "config", "status.showUntrackedFiles", "no")
	kept("a file in the submodule, hidden from status", "untracked files in a submodule")
	os.WriteFile(filepath.Join(wt.Path, "todo"), []byte("wip"), 0o644)
	os.Remove(filepath.Join(sub, "notes"))
	kept("a file in the worktree, hidden from status", "modified or untracked")
	os.Remove(filepath.Join(wt.Path, "todo"))

	os.WriteFile(filepath.Join(sub, "notes"), []byte("wip"), 0o644)
	run(sub, "stash", "push", "-q", "-u")
	kept("a stash in the submodule", "stashes that no remote has")
	run(sub, "stash", "drop", "-q")

	run(sub, "commit", "-q", "--allow-empty", "-m", "local only")
	kept("a submodule commit, uncommitted in the worktree", "modified or untracked")
	// Committed in the worktree, git status is clean, but the submodule's
	// commit is only in the worktree's own copy of its history.
	run(wt.Path, "commit", "-q", "-am", "bump lib")
	kept("a submodule commit no remote has", "submodule commits or stashes that no remote has")
	run(sub, "push", "-q", "origin", "HEAD:refs/heads/shared")

	// A commit only a local tag holds, with the submodule back where the
	// worktree has it: clean, but the tag's commit would go.
	run(sub, "commit", "-q", "--allow-empty", "-m", "tagged")
	run(sub, "-c", "tag.gpgSign=false", "tag", "keep")
	run(sub, "checkout", "-q", "HEAD~1")
	kept("a commit only a submodule tag holds", "submodule commits or stashes")
	run(sub, "tag", "-d", "keep")

	// A deinit takes the submodule's checkout, not its repository: its
	// branches stay in the worktree's git folder, and so go with it.
	run(sub, "commit", "-q", "--allow-empty", "-m", "branched")
	run(sub, "branch", "keep")
	run(sub, "checkout", "-q", "HEAD~1")
	run(wt.Path, "submodule", "deinit", "-q", "-f", "lib")
	kept("a branch in a deinitialized submodule", "submodule commits or stashes")
	out, err := exec.Command("git", "-C", wt.Path, "rev-parse", "--absolute-git-dir").Output()
	if err != nil {
		t.Fatal(err)
	}
	run(wt.Path, "--git-dir="+filepath.Join(strings.TrimSpace(string(out)), "modules", "lib"), "branch", "-D", "-q", "keep")

	// A submodule cloned by hand keeps its repository in its own .git,
	// inside the worktree's folder, and so goes with it too.
	run(wt.Path, "clone", "-q", lib, "lib")
	run(sub, "checkout", "-q", "origin/shared")
	run(sub, "commit", "-q", "--allow-empty", "-m", "embedded")
	run(wt.Path, "commit", "-q", "-am", "bump lib again")
	kept("a commit in an embedded submodule repository", "submodule commits or stashes")
	run(sub, "push", "-q", "origin", "HEAD:refs/heads/embedded")

	if err := l.RemoveWorktree(ctx, "cal", "vendor", false); err != nil {
		t.Fatalf("a clean worktree with a submodule: %v", err)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatalf("worktree folder still there: %v", err)
	}
}

func TestADeinitializedSubmoduleInsideAClonedOneIsChecked(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	run := submoduleGit(t)
	// cal has lib, and lib has deep.
	deep := filepath.Join(filepath.Dir(repo), "deep")
	lib := filepath.Join(filepath.Dir(repo), "lib")
	os.MkdirAll(deep, 0o755)
	os.MkdirAll(lib, 0o755)
	run(deep, "init", "-q", "-b", "main")
	run(deep, "commit", "-q", "--allow-empty", "-m", "deep")
	run(lib, "init", "-q", "-b", "main")
	run(lib, "submodule", "add", "-q", deep, "deep")
	run(lib, "commit", "-q", "-m", "add deep")
	run(repo, "submodule", "add", "-q", lib, "lib")
	run(repo, "commit", "-q", "-m", "add lib")

	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	if _, err := l.Add(ctx, "cal", repo); err != nil {
		t.Fatal(err)
	}
	wt, err := l.CreateWorktree(ctx, "cal", "vendor", "vendor", "main")
	if err != nil {
		t.Fatal(err)
	}
	// lib cloned by hand: deep's repository lives in lib's own .git. A
	// branch only deep has, then deep deinitialized.
	sub := filepath.Join(wt.Path, "lib")
	run(wt.Path, "clone", "-q", lib, "lib")
	run(sub, "submodule", "update", "-q", "--init")
	run(filepath.Join(sub, "deep"), "commit", "-q", "--allow-empty", "-m", "only here")
	run(filepath.Join(sub, "deep"), "branch", "keep")
	run(filepath.Join(sub, "deep"), "checkout", "-q", "HEAD~1")
	run(sub, "submodule", "deinit", "-q", "-f", "deep")

	err = l.RemoveWorktree(ctx, "cal", "vendor", false)
	if err == nil || !strings.Contains(err.Error(), "submodule commits or stashes") || statusFor(err) != 409 {
		t.Fatalf("err = %v (status %d), want a 409 about submodule commits", err, statusFor(err))
	}
	run(sub, "--git-dir="+filepath.Join(sub, ".git", "modules", "deep"), "branch", "-D", "-q", "keep")
	if err := l.RemoveWorktree(ctx, "cal", "vendor", false); err != nil {
		t.Fatalf("with nothing left to lose: %v", err)
	}
}

func TestANestedSubmoduleMovedBehindAnIgnoreIsChecked(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	run := submoduleGit(t)
	// cal has lib, and lib has deep at deep's second commit.
	deep := filepath.Join(filepath.Dir(repo), "deep")
	lib := filepath.Join(filepath.Dir(repo), "lib")
	os.MkdirAll(deep, 0o755)
	os.MkdirAll(lib, 0o755)
	run(deep, "init", "-q", "-b", "main")
	run(deep, "commit", "-q", "--allow-empty", "-m", "deep")
	run(deep, "commit", "-q", "--allow-empty", "-m", "deep 2")
	run(lib, "init", "-q", "-b", "main")
	run(lib, "submodule", "add", "-q", deep, "deep")
	run(lib, "commit", "-q", "-m", "add deep")
	run(repo, "submodule", "add", "-q", lib, "lib")
	run(repo, "commit", "-q", "-m", "add lib")

	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	if _, err := l.Add(ctx, "cal", repo); err != nil {
		t.Fatal(err)
	}
	wt, err := l.CreateWorktree(ctx, "cal", "vendor", "vendor", "main")
	if err != nil {
		t.Fatal(err)
	}
	run(wt.Path, "submodule", "update", "-q", "--init", "--recursive")
	sub := filepath.Join(wt.Path, "lib")
	// lib ignores deep, and deep moves to a commit its remote has: only
	// asking lib itself, ignores overridden, shows the move.
	run(sub, "config", "submodule.deep.ignore", "all")
	run(filepath.Join(sub, "deep"), "checkout", "-q", "HEAD~1")

	err = l.RemoveWorktree(ctx, "cal", "vendor", false)
	if err == nil || !strings.Contains(err.Error(), "files in a submodule") || statusFor(err) != 409 {
		t.Fatalf("err = %v (status %d), want a 409 about changes in a submodule", err, statusFor(err))
	}
	run(filepath.Join(sub, "deep"), "checkout", "-q", "main")
	if err := l.RemoveWorktree(ctx, "cal", "vendor", false); err != nil {
		t.Fatalf("with deep back where lib has it: %v", err)
	}
}

func TestAFailedAddLeavesNothingBehind(t *testing.T) {
	repo := gitRepo(t)
	ctx := context.Background()
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	if _, err := l.Add(ctx, "cal", repo); err != nil {
		t.Fatal(err)
	}
	// A checkout that fails halfway: a post-checkout hook that errors makes
	// git give up after it has registered (and locked) the worktree.
	hook := filepath.Join(repo, ".git", "hooks", "post-checkout")
	os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755)
	if _, err := l.CreateWorktree(ctx, "cal", "broken", "broken", "main"); err == nil {
		t.Skip("this git does not fail an add on its post-checkout hook")
	}
	path := filepath.Join(filepath.Dir(repo), "cal-broken")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("half-made worktree folder left: %v", err)
	}
	if _, err := os.Stat(filepath.Join(repo, ".git", "worktrees", "cal-broken")); !os.IsNotExist(err) {
		t.Fatalf("half-made worktree still registered: %v", err)
	}
	if branchExists(ctx, repo, "refs/heads/broken") {
		t.Fatal("the failed add's branch is left")
	}
	// And the same name works once the cause is gone.
	os.Remove(hook)
	if _, err := l.CreateWorktree(ctx, "cal", "broken", "broken", "main"); err != nil {
		t.Fatalf("creating again after a failed add: %v", err)
	}
}
