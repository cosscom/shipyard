package box

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
)

// fakeGitRemove puts a git first on PATH that does `worktree remove` its own
// way (script, run by sh with the real git's arguments) and hands every
// other command to the real git.
func fakeGitRemove(t *testing.T, script string) {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	bin := t.TempDir()
	body := "#!/bin/sh\nif [ \"$3\" = worktree ] && [ \"$4\" = remove ]; then\n" + script + "\nfi\nexec " + real + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func worktreeIn(t *testing.T, name string) (*Locations, string, Worktree) {
	t.Helper()
	repo := gitRepo(t)
	// What a removal stopped halfway leaves is mostly what git ignores.
	write(t, filepath.Join(repo, ".git", "info", "exclude"), "node_modules\n")
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	if _, err := l.Add(context.Background(), "cal", repo); err != nil {
		t.Fatal(err)
	}
	wt, err := l.CreateWorktree(context.Background(), "cal", name, "alex/"+name, "main")
	if err != nil {
		t.Fatal(err)
	}
	return l, repo, wt
}

func listed(t *testing.T, repo, path string) bool {
	t.Helper()
	out, err := exec.Command("git", "-C", repo, "worktree", "list", "--porcelain").CombinedOutput()
	if err != nil {
		t.Fatalf("git worktree list: %v: %s", err, out)
	}
	return strings.Contains(string(out), "worktree "+path+"\n")
}

func TestAWorktreeRemoveThatFailsWithNoOutputSaysWhy(t *testing.T) {
	l, _, wt := worktreeIn(t, "billing")
	fakeGitRemove(t, "exit 1")
	err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false)
	if err == nil {
		t.Fatal("a failed git worktree remove passed")
	}
	if msg := err.Error(); strings.HasSuffix(strings.TrimSpace(msg), ":") || !strings.Contains(msg, "exit status 1") {
		t.Fatalf("error = %q, want git's exit status in words", msg)
	}
}

func TestAWorktreeRemoveThatTimesOutSaysSo(t *testing.T) {
	l, _, wt := worktreeIn(t, "billing")
	fakeGitRemove(t, "exec sleep 30")
	defer func(d time.Duration) { worktreeRemoveTimeout = d }(worktreeRemoveTimeout)
	worktreeRemoveTimeout = 300 * time.Millisecond
	start := time.Now()
	err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false)
	if err == nil {
		t.Fatal("a git worktree remove that never ended passed")
	}
	if time.Since(start) > 20*time.Second {
		t.Fatalf("waited %s, past the removal's budget", time.Since(start))
	}
	if msg := err.Error(); !strings.Contains(msg, "timed out after 300ms") || !strings.Contains(msg, "partly removed") {
		t.Fatalf("error = %q, want it to say it timed out and may have left the folder partly removed", msg)
	}
}

func TestAWorktreeRemoveKeepsGitsOwnWords(t *testing.T) {
	l, _, wt := worktreeIn(t, "billing")
	write(t, filepath.Join(wt.Path, "wip.txt"), "unsaved")
	err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false)
	if err == nil || !strings.Contains(err.Error(), "contains modified or untracked files") {
		t.Fatalf("a dirty worktree's removal = %v, want git's refusal", err)
	}
	if _, statErr := os.Stat(wt.Path); statErr != nil {
		t.Fatalf("the dirty worktree's folder went: %v", statErr)
	}
}

// A removal stopped halfway (git killed mid-delete) leaves the folder with
// files in it and no .git, which git lists as prunable: archiving finishes
// the job, and keeps the branch.
func TestAHalfRemovedWorktreeIsFinished(t *testing.T) {
	l, repo, wt := worktreeIn(t, "billing")
	other, err := l.CreateWorktree(context.Background(), "cal", "checkout", "alex/checkout", "main")
	if err != nil {
		t.Fatal(err)
	}
	live, err := l.CreateWorktree(context.Background(), "cal", "search", "alex/search", "main")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(wt.Path, "README")); err != nil {
		t.Fatal(err)
	}
	for _, w := range []Worktree{wt, other} {
		write(t, filepath.Join(w.Path, "node_modules", "left", "index.js"), "x")
		if err := os.Remove(filepath.Join(w.Path, ".git")); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(live.Path, "wip.txt"), "unsaved")

	if err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false); err != nil {
		t.Fatalf("archiving a half-removed worktree: %v", err)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatalf("its folder is still there: %v", err)
	}
	if listed(t, repo, wt.Path) {
		t.Fatal("git still lists it")
	}
	if !branchExists(context.Background(), repo, "refs/heads/alex/billing") {
		t.Fatal("its branch went with it")
	}
	// Only that one: another half-removed worktree stays for its own archive.
	if !listed(t, repo, other.Path) {
		t.Fatal("another half-removed worktree was pruned with it")
	}
	if _, err := os.Stat(filepath.Join(other.Path, "node_modules", "left", "index.js")); err != nil {
		t.Fatalf("another half-removed worktree's files went: %v", err)
	}
	// A live worktree with changes is still refused, and the main checkout.
	if err := l.RemoveWorktree(context.Background(), "cal", live.Name, false); err == nil || !strings.Contains(err.Error(), "modified or untracked") {
		t.Fatalf("a live dirty worktree's removal = %v, want git's refusal", err)
	}
	if err := l.RemoveWorktree(context.Background(), "cal", "cal", false); err == nil {
		t.Fatal("removed the main checkout")
	}
	if _, err := os.Stat(filepath.Join(repo, "README")); err != nil {
		t.Fatalf("the main checkout lost files: %v", err)
	}
}

// A listing read before the .git went (a cached one) still shows what is
// left as git dropped: whether it has a .git is looked at afresh.
func TestAListingFromBeforeTheGitWentShowsItDropped(t *testing.T) {
	_, repo, wt := worktreeIn(t, "billing")
	out, err := exec.Command("git", "-C", repo, "worktree", "list", "--porcelain").CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if err := os.Remove(filepath.Join(wt.Path, ".git")); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, w := range parseWorktrees(out, repo) {
		if w.Main && w.Prunable {
			t.Fatal("the main checkout reads as dropped")
		}
		if w.Path == wt.Path {
			found = true
			if !w.Prunable {
				t.Fatalf("%s reads as a live worktree from an older listing", w.Name)
			}
		}
	}
	if !found {
		t.Fatalf("%s is missing from the listing, so nothing was checked", wt.Name)
	}
}

// A removal stopped halfway can delete the .gitignore files before what
// they ignore: node_modules then reads as new files. They are asked about
// with the .gitignore files put back as committed, so what's left goes,
// and a file that is really new still keeps it.
func TestAHalfRemovedWorktreeThatLostItsGitignore(t *testing.T) {
	for name, extra := range map[string]string{"ignored only": "", "with a new file": "notes.txt"} {
		t.Run(name, func(t *testing.T) {
			l, repo, wt := worktreeIn(t, "billing")
			os.WriteFile(filepath.Join(repo, ".git", "info", "exclude"), nil, 0o644)
			for _, dir := range []string{repo, wt.Path} {
				os.MkdirAll(filepath.Join(dir, "web"), 0o755)
				os.WriteFile(filepath.Join(dir, "web", ".gitignore"), []byte("dist/\n"), 0o644)
				os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("node_modules\n"), 0o644)
			}
			for _, args := range [][]string{{"add", "."}, {"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "ignore"}} {
				if out, err := exec.Command("git", append([]string{"-C", wt.Path}, args...)...).CombinedOutput(); err != nil {
					t.Fatalf("%v: %s", err, out)
				}
			}
			os.MkdirAll(filepath.Join(wt.Path, "node_modules", "left"), 0o755)
			os.WriteFile(filepath.Join(wt.Path, "node_modules", "left", "index.js"), []byte("x"), 0o644)
			os.MkdirAll(filepath.Join(wt.Path, "web", "dist"), 0o755)
			os.WriteFile(filepath.Join(wt.Path, "web", "dist", "app.js"), []byte("x"), 0o644)
			if extra != "" {
				os.WriteFile(filepath.Join(wt.Path, extra), []byte("mine"), 0o644)
			}
			for _, gone := range []string{".gitignore", "web/.gitignore", "README", ".git"} {
				if err := os.Remove(filepath.Join(wt.Path, gone)); err != nil {
					t.Fatal(err)
				}
			}
			err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false)
			if extra == "" {
				if err != nil {
					t.Fatalf("archiving it: %v", err)
				}
				if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
					t.Fatalf("its folder is still there: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "contains modified or untracked files") {
				t.Fatalf("archiving it with a new file = %v, want git's refusal", err)
			}
			if _, err := os.Stat(filepath.Join(wt.Path, extra)); err != nil {
				t.Fatalf("the new file went: %v", err)
			}
		})
	}
}

// A folder git dropped the link to is only deleted when nothing in it is
// work: a file changed or added since, as git worktree remove would see it,
// keeps it, in git's words. Remove anyway still deletes it.
func TestAHalfRemovedWorktreeWithWorkInItIsKept(t *testing.T) {
	for name, change := range map[string]func(dir string){
		"changed": func(dir string) { os.WriteFile(filepath.Join(dir, "README"), []byte("rewritten"), 0o644) },
		"added":   func(dir string) { os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("mine"), 0o644) },
	} {
		t.Run(name, func(t *testing.T) {
			l, repo, wt := worktreeIn(t, "billing")
			change(wt.Path)
			if err := os.Remove(filepath.Join(wt.Path, ".git")); err != nil {
				t.Fatal(err)
			}
			if !dirtyWorktree(repo, wt.Path) {
				t.Error("dirtyWorktree calls it clean")
			}
			err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false)
			if err == nil || !strings.Contains(err.Error(), "contains modified or untracked files") {
				t.Fatalf("archiving it = %v, want git's refusal", err)
			}
			if _, err := os.Stat(wt.Path); err != nil {
				t.Fatalf("its folder went: %v", err)
			}
			if err := l.RemoveWorktree(context.Background(), "cal", wt.Name, true); err != nil {
				t.Fatalf("Remove anyway: %v", err)
			}
			if _, err := os.Stat(wt.Path); !os.IsNotExist(err) || listed(t, repo, wt.Path) {
				t.Fatalf("Remove anyway left it: %v", err)
			}
		})
	}
}

// A repository inside what's left, even under a folder git ignores (another
// project's worktree in node_modules), keeps it all.
func TestAHalfRemovedWorktreeHoldingARepositoryIsKept(t *testing.T) {
	l, _, wt := worktreeIn(t, "billing")
	inner := filepath.Join(wt.Path, "node_modules", "vendored")
	if out, err := exec.Command("git", "init", "-q", inner).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	write(t, filepath.Join(inner, "wip.txt"), "unsaved")
	if err := os.Remove(filepath.Join(wt.Path, ".git")); err != nil {
		t.Fatal(err)
	}
	err := l.RemoveWorktree(context.Background(), "cal", wt.Name, true)
	if err == nil || !strings.Contains(err.Error(), "has a git repository in it") {
		t.Fatalf("removing it = %v, want it kept for the repository inside", err)
	}
	if _, err := os.Stat(filepath.Join(inner, "wip.txt")); err != nil {
		t.Fatalf("the repository inside lost its work: %v", err)
	}
}

// A half-removed worktree that will be kept is refused before anything is
// torn down: its services still run.
func TestAHalfRemovedWorktreeThatIsKeptKeepsItsServices(t *testing.T) {
	ctx := context.Background()
	l, _, wt := worktreeIn(t, "billing")
	ops, calls := fakeService()
	b := &Box{Name: "devbox", Locations: l, Events: &events.Bus{}, Units: &Units{Dir: t.TempDir(), svc: ops}}
	if err := l.SetLocalConfig("cal", RepoConfig{Services: []WorktreeService{{Name: "web", Run: "sleep 600"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.StartService(ctx, "cal", wt.Name, "web"); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "init", "-q", filepath.Join(wt.Path, "node_modules", "vendored")).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if err := os.Remove(filepath.Join(wt.Path, ".git")); err != nil {
		t.Fatal(err)
	}
	loc, err := l.Get(ctx, "cal")
	if err != nil {
		t.Fatal(err)
	}
	if !halfRemoved(loc, wt.Path) {
		t.Fatal("the worktree doesn't read as half removed")
	}
	_, err = b.dropWorktree("", loc, wt.Name, wt.Path, "", false, "archived", nil)
	if err == nil || !strings.Contains(err.Error(), "has a git repository in it") {
		t.Fatalf("archiving it = %v, want it kept for the repository inside", err)
	}
	for _, c := range *calls {
		if strings.HasPrefix(c, "uninstall ") {
			t.Fatalf("its service was stopped though it was kept: %v", *calls)
		}
	}
}

// One whose folder is gone altogether is no place to work, so it isn't
// listed; archiving it still drops what git kept of it, so a worktree can be
// made at that path again.
func TestAWorktreeWhoseFolderIsGoneIsPruned(t *testing.T) {
	l, repo, wt := worktreeIn(t, "billing")
	if err := os.RemoveAll(wt.Path); err != nil {
		t.Fatal(err)
	}
	if err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false); err != nil {
		t.Fatalf("archiving a worktree whose folder is gone: %v", err)
	}
	if listed(t, repo, wt.Path) {
		t.Fatal("git still lists it")
	}
	if !branchExists(context.Background(), repo, "refs/heads/alex/billing") {
		t.Fatal("its branch went")
	}
	if err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false); !errors.Is(err, ErrUnknownWorktree) {
		t.Fatalf("archiving it again = %v, want unknown", err)
	}
	if _, err := l.CreateWorktree(context.Background(), "cal", "billing", "alex/billing-2", "main"); err != nil {
		t.Fatalf("a worktree at the same path again: %v", err)
	}
}

// A folder git still treats as a worktree is never deleted by hand, even
// one git refuses to remove.
func TestAWorktreeGitStillHasIsNeverDeletedByHand(t *testing.T) {
	l, repo, wt := worktreeIn(t, "billing")
	fakeGitRemove(t, "exit 1")
	if err := l.RemoveWorktree(context.Background(), "cal", wt.Name, false); err == nil {
		t.Fatal("a failed git worktree remove passed")
	}
	if _, err := os.Stat(filepath.Join(wt.Path, "README")); err != nil {
		t.Fatalf("its files went: %v", err)
	}
	if !listed(t, repo, wt.Path) {
		t.Fatal("git no longer lists it")
	}
}
