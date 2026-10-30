// Package box is what berthd offers paired laptops beyond raw port streams:
// locations and worktrees, listening ports, agent sessions, and shares.
package box

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/trust"
)

// Location is a named place on a box where work happens: a repository or any
// directory. Agents and worktrees are created relative to a location.
type Location struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// Repo is true when Path is the root of a git repository.
	Repo      bool       `json:"repo"`
	Worktrees []Worktree `json:"worktrees,omitempty"`
	// Scripts run when berth creates or removes worktrees here.
	Scripts Scripts `json:"scripts"`
	// Agents are the repository's own agent presets.
	Agents []AgentPreset `json:"agents,omitempty"`
	// Remote is origin's URL, Slug its "owner/repo", and DefaultBranch
	// what new branches start from.
	Remote        string `json:"remote,omitempty"`
	Slug          string `json:"slug,omitempty"`
	DefaultBranch string `json:"default_branch,omitempty"`
	// RepoTrust is whether this box runs the repository's
	// .berth/config.json: "none" without one, "trusted", or "untrusted" /
	// "changed" while it waits to be trusted and only its ports apply.
	RepoTrust string `json:"repo_trust,omitempty"`
	// Check is how to tell the work here is right: the config's "check",
	// else one found in the repository (CheckFrom "config" or "detected").
	Check     string `json:"check,omitempty"`
	CheckFrom string `json:"check_from,omitempty"`
	// KitTeam is the org whose team setup the location's kit comes from,
	// when it does.
	KitTeam string `json:"kit_team,omitempty"`
	// keepMain is the config's keep_main: whether new branches keep the
	// default branch current (freshbase.go).
	keepMain bool
}

type Worktree struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
	Head   string `json:"head,omitempty"`
	// Main marks the repository's own checkout.
	Main bool `json:"main,omitempty"`
	// MainRefresh is what making it did to keep the default branch
	// current (freshbase.go); only in what a create returns.
	MainRefresh *BaseRefresh `json:"main_refresh,omitempty"`
	// SettingUp is true when the tool that made it is still running its
	// setup; a worktree.setup event follows.
	SettingUp bool `json:"setting_up,omitempty"`
	// Port is the first of the worktree's own ports ($BERTH_PORT).
	Port int `json:"port,omitempty"`
	// Locked is set when git has the worktree locked, with LockReason
	// its reason ("initializing" while `git worktree add` runs).
	Locked     bool   `json:"locked,omitempty"`
	LockReason string `json:"lock_reason,omitempty"`
	// Prunable is set when git has dropped the worktree's link: its .git
	// is gone, as a removal stopped halfway leaves it. What is left of the
	// folder is no worktree, and removing it finishes the job.
	Prunable bool `json:"prunable,omitempty"`
	// Title is the name a person gave the worktree to show in its place
	// (worktreetitles.go): a label only, its branch and folder keep Name.
	Title string `json:"title,omitempty"`
	// Parent is the path of the worktree whose agent handed this one off,
	// for clients to nest it under (worktreeparents.go).
	Parent string `json:"parent,omitempty"`
	// SetupOnOpen marks a worktree the repository had before Team setup
	// adopted it: its per-worktree setup runs the first time a terminal or
	// an agent starts there (firstopen.go).
	SetupOnOpen bool `json:"setup_on_open,omitempty"`
	// SetupPending marks a worktree made with --no-setup: its setup has
	// not run and only runs when asked for (worktreesetup.go).
	SetupPending bool `json:"setup_pending,omitempty"`
	// Review marks a pull request opened for review (prreview.go).
	Review *ReviewMark `json:"review,omitempty"`
}

var (
	ErrUnknownLocation = errors.New("no location with that name")
	ErrUnknownWorktree = errors.New("no worktree with that name in the location")
)

type Locations struct {
	path string
	// Ports gives each worktree its own block of ports.
	Ports *PortAlloc
}

func NewLocations(path string) *Locations {
	return &Locations{path: path, Ports: &PortAlloc{Path: filepath.Join(filepath.Dir(path), "ports.json")}}
}

type savedLocation struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Setup   string `json:"setup,omitempty"`
	Archive string `json:"archive,omitempty"`
	// Config is this box's own config for the location, laid over the
	// repository's.
	Config *RepoConfig `json:"config,omitempty"`
	// Kit is a kit installed for the location, between the two.
	Kit *InstalledKit `json:"kit,omitempty"`
	// RepoTrust is the sha256 of the repository's .berth/config.json as
	// someone trusted it here; any other version of the file does not run.
	RepoTrust string `json:"repo_trust,omitempty"`
	// Titles are the worktrees' display names, by worktree path
	// (worktreetitles.go).
	Titles map[string]string `json:"titles,omitempty"`
	// Parents are the worktrees handed off from another, child path to
	// parent path (worktreeparents.go).
	Parents map[string]string `json:"parents,omitempty"`
	// FirstOpen are worktrees set up the first time they are opened, by
	// path (firstopen.go).
	FirstOpen []string `json:"first_open,omitempty"`
	// SetupPending are worktrees made with --no-setup, by path, waiting
	// for an explicit setup (worktreesetup.go).
	SetupPending []string `json:"setup_pending,omitempty"`
	// Reviews are the worktrees opened to review a pull request, by path
	// (prreview.go).
	Reviews map[string]*ReviewMark `json:"reviews,omitempty"`
}

func (l *Locations) Add(ctx context.Context, name, path string) (Location, error) {
	if !trust.ValidName(name) {
		return Location{}, fmt.Errorf("invalid location name %q", name)
	}
	if ReservedName(name) {
		return Location{}, fmt.Errorf("location names can't start with %q: the proxy keeps those for artifacts", ArtifactHostPrefix)
	}
	abs, err := filepath.Abs(expandHome(path))
	if err != nil {
		return Location{}, err
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return Location{}, fmt.Errorf("%s is not a directory on this box", abs)
	}
	err = l.update(func(all []savedLocation) ([]savedLocation, error) {
		out := all[:0]
		for _, s := range all {
			if s.Name == name {
				continue
			}
			out = append(out, s)
		}
		return append(out, savedLocation{Name: name, Path: abs}), nil
	})
	if err != nil {
		return Location{}, err
	}
	return l.Get(ctx, name)
}

// SetScripts sets or, with empty values, clears a location's own lifecycle
// scripts.
func (l *Locations) SetScripts(name, setup, archive string) error {
	return l.update(func(all []savedLocation) ([]savedLocation, error) {
		for i := range all {
			if all[i].Name == name {
				all[i].Setup, all[i].Archive = setup, archive
				return all, nil
			}
		}
		return nil, ErrUnknownLocation
	})
}

func (l *Locations) Remove(name string) error {
	return l.update(func(all []savedLocation) ([]savedLocation, error) {
		for i, s := range all {
			if s.Name == name {
				return append(all[:i], all[i+1:]...), nil
			}
		}
		return nil, ErrUnknownLocation
	})
}

func (l *Locations) List(ctx context.Context) ([]Location, error) {
	saved, err := l.read()
	if err != nil {
		return nil, err
	}
	out := make([]Location, 0, len(saved))
	for _, s := range saved {
		out = append(out, l.withPorts(describe(ctx, s)))
	}
	return out, nil
}

// worktreePaths is each location with its worktrees' names and paths only,
// as List names them: for finding which worktree a directory is in, it
// skips what else List reads (remote, default branch, configs).
func (l *Locations) worktreePaths(ctx context.Context) []Location {
	saved, err := l.read()
	if err != nil {
		return nil
	}
	out := make([]Location, 0, len(saved))
	for _, s := range saved {
		loc := Location{Name: s.Name, Path: s.Path}
		if b, err := worktreeList(ctx, s.Path); err == nil {
			loc.Worktrees = parseWorktrees(b, s.Path)
		}
		out = append(out, loc)
	}
	return out
}

// withPorts adds each worktree's first port.
func (l *Locations) withPorts(loc Location) Location {
	for i := range loc.Worktrees {
		loc.Worktrees[i].Port, _ = l.Ports.For(loc.Worktrees[i].Path)
	}
	return loc
}

func (l *Locations) Get(ctx context.Context, name string) (Location, error) {
	saved, err := l.read()
	if err != nil {
		return Location{}, err
	}
	for _, s := range saved {
		if s.Name == name {
			return l.withPorts(describe(ctx, s)), nil
		}
	}
	return Location{}, ErrUnknownLocation
}

// Dir resolves "location" or "location/worktree" to a directory.
func (l *Locations) Dir(ctx context.Context, ref string) (string, error) {
	name, wt, _ := strings.Cut(ref, "/")
	loc, err := l.Get(ctx, name)
	if err != nil {
		return "", err
	}
	if wt == "" {
		return loc.Path, nil
	}
	for _, w := range loc.Worktrees {
		if w.Name == wt {
			return w.Path, nil
		}
	}
	return "", ErrUnknownWorktree
}

// CreateWorktree adds a git worktree next to the repository, following the
// <parent>/<repo>-<name> layout, on a new branch from base.
func (l *Locations) CreateWorktree(ctx context.Context, location, name, branch, base string) (Worktree, error) {
	return l.CreateWorktreeFrom(ctx, location, WorktreeRequest{Name: name, Branch: branch, Base: base})
}

// CreateWorktreeFrom makes a worktree for req: a new branch, an existing one
// (fetched from origin first, so it is current), or a pull request's head.
func (l *Locations) CreateWorktreeFrom(ctx context.Context, location string, req WorktreeRequest) (Worktree, error) {
	name, branch, base := req.Name, req.Branch, req.Base
	if !trust.ValidName(name) {
		return Worktree{}, fmt.Errorf("invalid worktree name %q", name)
	}
	if ReservedName(name) {
		return Worktree{}, fmt.Errorf("worktree names can't start with %q: the proxy keeps those for artifacts", ArtifactHostPrefix)
	}
	loc, err := l.Get(ctx, location)
	if err != nil {
		return Worktree{}, err
	}
	if !loc.Repo {
		return Worktree{}, fmt.Errorf("location %s is not a git repository", location)
	}
	if branch == "" {
		branch = name
	}
	path := filepath.Join(filepath.Dir(loc.Path), filepath.Base(loc.Path)+"-"+name)
	if !branchExists(ctx, loc.Path, "refs/heads/"+branch) && (req.PR > 0 || req.Ref != "" || branchExists(ctx, loc.Path, "refs/remotes/origin/"+branch)) {
		// Bring origin's branch up to date; a PR's own branch may live there.
		git(ctx, "-C", loc.Path, "fetch", "--quiet", "origin", branch)
		if !branchExists(ctx, loc.Path, "refs/remotes/origin/"+branch) && (req.PR > 0 || req.Ref != "") {
			ref := req.Ref
			if ref == "" {
				ref = fmt.Sprintf("pull/%d/head", req.PR)
			}
			if out, err := git(ctx, "-C", loc.Path, "fetch", "--quiet", "origin", ref+":"+branch); err != nil {
				return Worktree{}, fmt.Errorf("git fetch %s: %s", ref, strings.TrimSpace(string(out)))
			}
		}
	}
	args := []string{"-C", loc.Path, "worktree", "add"}
	var refresh *BaseRefresh
	switch {
	case branchExists(ctx, loc.Path, "refs/heads/"+branch):
		// An existing branch is checked out as it is, to review or continue.
		args = append(args, path, branch)
	case branchExists(ctx, loc.Path, "refs/remotes/origin/"+branch):
		args = append(args, "--track", "-b", branch, path, "origin/"+branch)
	default:
		var from string
		from, refresh = freshBase(ctx, loc, base)
		if from != base {
			// Branched from origin's, not tracking it: its upstream is
			// set by the first push, as a branch from main's would be.
			args = append(args, "--no-track")
		}
		args = append(args, "-b", branch, path)
		if from != "" {
			args = append(args, from)
		}
	}
	// The add runs to the end even if whoever asked goes away: one killed
	// halfway leaves a worktree git keeps locked as "initializing".
	_, statErr := os.Stat(path)
	hadPath := statErr == nil
	hadBranch := branchExists(ctx, loc.Path, "refs/heads/"+branch)
	if out, err := git(context.WithoutCancel(ctx), args...); err != nil {
		cleanUpFailedAdd(loc.Path, path, branch, hadPath, hadBranch)
		return Worktree{}, fmt.Errorf("git worktree add: %s", strings.TrimSpace(string(out)))
	}
	for _, w := range describe(ctx, savedLocation{Name: loc.Name, Path: loc.Path}).Worktrees {
		if w.Path == path {
			w.MainRefresh = refresh
			return w, nil
		}
	}
	return Worktree{Name: name, Path: path, Branch: branch, MainRefresh: refresh}, nil
}

// cleanUpFailedAdd undoes what a failed `git worktree add` left: its
// half-made worktree and lock, the folder if it was new, and the branch if
// the add made it.
func cleanUpFailedAdd(repo, path, branch string, hadPath, hadBranch bool) {
	ctx := context.Background()
	if !hadPath {
		git(ctx, "-C", repo, "worktree", "unlock", path)
		git(ctx, "-C", repo, "worktree", "remove", "--force", "--force", path)
		os.RemoveAll(path)
	}
	git(ctx, "-C", repo, "worktree", "prune")
	if !hadBranch && branchExists(ctx, repo, "refs/heads/"+branch) {
		git(ctx, "-C", repo, "branch", "-D", branch)
	}
}

// gitLockReason is the reason `git worktree add` locks a worktree with
// while it runs; one still there means the add was interrupted.
const gitLockReason = "initializing"

// berthLockPrefix starts the reason of any lock Shipyard itself sets.
const berthLockPrefix = "berth:"

// ownLock is true for a lock nobody chose: git's own from an interrupted
// add, or Shipyard's. Removing such a worktree unlocks it first; a lock a
// person set with `git worktree lock` is theirs to lift.
func ownLock(reason string) bool {
	return reason == gitLockReason || strings.HasPrefix(reason, berthLockPrefix)
}

// errLocked explains a lock a person set, and how to lift it.
func errLocked(repo string, w Worktree) error {
	why := "with no reason given"
	if w.LockReason != "" {
		why = fmt.Sprintf("with the reason %q", w.LockReason)
	}
	return httpError{status: http.StatusConflict, msg: fmt.Sprintf(
		"%s is locked (git worktree lock, %s), so it was left as it is. Unlock it on the box with `git -C %s worktree unlock %s`, then try again.",
		w.Name, why, repo, w.Path)}
}

func branchExists(ctx context.Context, repo, ref string) bool {
	_, err := git(ctx, "-C", repo, "rev-parse", "--verify", "--quiet", ref)
	return err == nil
}

// worktreeRemoveTimeout is how long `git worktree remove` may take: a big
// worktree on a busy box can take minutes, and one stopped halfway is left
// partly removed. BERTH_WORKTREE_REMOVE_TIMEOUT (a Go duration) sets
// another.
var worktreeRemoveTimeout = removeTimeout(os.Getenv("BERTH_WORKTREE_REMOVE_TIMEOUT"))

func removeTimeout(env string) time.Duration {
	if d, err := time.ParseDuration(env); err == nil && d > 0 {
		return d
	}
	return 10 * time.Minute
}

// RemoveWorktree removes a worktree. Git refuses when it has uncommitted
// changes unless force is set, and that refusal is passed on unchanged. One
// git has dropped the link to (a removal stopped halfway) is finished
// instead (finishRemoval), and so is one whose folder is already gone.
func (l *Locations) RemoveWorktree(ctx context.Context, location, name string, force bool) error {
	loc, err := l.Get(ctx, location)
	if err != nil {
		return err
	}
	w, ok := Worktree{}, false
	for _, c := range loc.Worktrees {
		if c.Name == name {
			w, ok = c, true
			break
		}
	}
	if !ok {
		if w, ok = goneWorktree(ctx, loc, name); !ok {
			return ErrUnknownWorktree
		}
	}
	if w.Main {
		return errors.New("refusing to remove the repository's main checkout")
	}
	if w.Locked {
		if !ownLock(w.LockReason) {
			return errLocked(loc.Path, w)
		}
		if out, err := git(ctx, "-C", loc.Path, "worktree", "unlock", w.Path); err != nil {
			return gitFailed("git worktree unlock", out, err)
		}
	}
	if w.Prunable {
		if err := finishRemoval(ctx, loc, w, force); err != nil {
			return err
		}
	} else if err := removeLinked(ctx, loc.Path, w, force); err != nil {
		return err
	}
	// A worktree made again under the same name starts without a title.
	l.forgetTitle(location, w.Path)
	l.forgetParent(location, w.Path)
	l.setReview(location, w.Path, nil)
	return nil
}

// removeLinked has git remove a worktree it still has the link to.
func removeLinked(ctx context.Context, repo string, w Worktree, force bool) error {
	args := []string{"-C", repo, "worktree", "remove", w.Path}
	if force {
		args = append(args, "--force")
	}
	out, err := gitWithin(ctx, worktreeRemoveTimeout, args...)
	// git refuses any worktree with a submodule checked out, however
	// clean, and only --force gets past it. Look for the work git won't,
	// and force only when there is none to lose.
	if err != nil && !force && strings.Contains(string(out), "containing submodules") {
		if why := unsavedWork(ctx, w.Path); why != "" {
			return httpError{status: http.StatusConflict, msg: fmt.Sprintf("git worktree remove: '%s' %s, use --force to delete it", w.Path, why)}
		}
		out, err = gitWithin(ctx, worktreeRemoveTimeout, append(args, "--force")...)
	}
	if err == nil {
		return nil
	}
	err = gitFailed("git worktree remove", out, err)
	if errors.Is(err, errGitTimedOut) {
		return fmt.Errorf("%w; the folder may be partly removed, and archiving it again finishes it", err)
	}
	return err
}

// goneWorktree finds a worktree by name that git still has but whose
// folder is gone, so it isn't listed.
func goneWorktree(ctx context.Context, loc Location, name string) (Worktree, bool) {
	out, err := git(ctx, "-C", loc.Path, "worktree", "list", "--porcelain")
	if err != nil {
		return Worktree{}, false
	}
	for _, w := range parseWorktreeList(out, loc.Path) {
		if w.Name != name || w.Main || !w.Prunable {
			continue
		}
		if _, err := os.Lstat(w.Path); errors.Is(err, fs.ErrNotExist) {
			return w, true
		}
	}
	return Worktree{}, false
}

// finishRemoval removes what is left of a worktree git has dropped the
// link to: its folder, then git's record of it. Only that one's, where
// `git worktree prune` would drop every half-removed worktree's record
// and leave their folders behind with nothing listing them. In that order,
// so a removal stopped again leaves a record that archiving again finishes,
// never a folder nothing lists. Unless forced, only when nothing would be
// lost (leftoverWork). The branch is kept.
func finishRemoval(ctx context.Context, loc Location, w Worktree, force bool) error {
	record, err := leftoverRefusal(ctx, loc, w, force)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(w.Path); err != nil {
		return fmt.Errorf("removing what was left of %s: %w", w.Path, err)
	}
	if err := os.RemoveAll(record); err != nil {
		return fmt.Errorf("removing git's record of %s: %w", w.Path, err)
	}
	return nil
}

// leftoverRefusal is why finishRemoval would leave what's left of w as it
// is, or nil with git's record of it, so a removal can ask before anything
// is torn down.
func leftoverRefusal(ctx context.Context, loc Location, w Worktree, force bool) (record string, err error) {
	// Never a folder git still treats as a worktree: git also calls one
	// prunable when only its own record is broken, with the .git still there.
	if _, err := os.Lstat(filepath.Join(w.Path, ".git")); !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("git worktree remove: '%s' has a .git that git can't read, so it was left as it is; run `git -C %s worktree repair %s` and try again", w.Path, loc.Path, w.Path)
	}
	for _, o := range loc.Worktrees {
		if o.Path != w.Path && strings.HasPrefix(o.Path, w.Path+string(filepath.Separator)) {
			return "", fmt.Errorf("git worktree remove: '%s' holds the worktree %s, so it was left as it is", w.Path, o.Path)
		}
	}
	// Nor one with any repository in it, a worktree of another's under an
	// ignored folder included, which git status here wouldn't see.
	if inner := gitInside(w.Path); inner != "" {
		return "", fmt.Errorf("git worktree remove: '%s' has a git repository in it at %s, so it was left as it is", w.Path, inner)
	}
	record, err = worktreeRecord(ctx, loc.Path, w.Path)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(w.Path); !force && err == nil {
		if why := leftoverWork(ctx, record, w.Path); why != "" {
			return "", httpError{status: http.StatusConflict, msg: fmt.Sprintf("git worktree remove: '%s' %s, use --force to delete it", w.Path, why)}
		}
	}
	return record, nil
}

// gitInside is the first folder under dir with a .git in it, or "". A
// walk that fails part way counts as one, so nothing unseen is deleted.
func gitInside(dir string) string {
	found := ""
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == dir && errors.Is(err, fs.ErrNotExist) {
				return filepath.SkipAll
			}
			return err
		}
		if d.Name() == ".git" {
			found = filepath.Dir(p)
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil && found == "" {
		return dir + " (it could not be read: " + err.Error() + ")"
	}
	return found
}

// leftoverWork says what deleting the folder of a worktree git dropped the
// link to would lose, or "" for nothing. git is asked about the folder
// through the worktree's record, which still has its HEAD and index: files
// a removal stopped halfway already deleted are nothing to lose, since
// they are in a commit, and ignored ones are what git deletes anyway. A
// changed, staged or new file is work, as it would be to git worktree
// remove, and when git can't tell, that counts too. The removal may have
// deleted .gitignore files before what they ignore (node_modules would
// then read as new), so those are put back as committed and git is asked
// again.
func leftoverWork(ctx context.Context, record, path string) string {
	changed, ignores, err := leftoverStatus(ctx, record, path)
	if err == nil && changed && len(ignores) > 0 {
		args := append([]string{"-C", path, "--git-dir=" + record, "--work-tree=" + path, "checkout-index", "--"}, ignores...)
		if out, cerr := git(ctx, args...); cerr != nil {
			err = gitFailed("git checkout-index", out, cerr)
		} else {
			changed, _, err = leftoverStatus(ctx, record, path)
		}
	}
	if err != nil {
		return "could not be checked for changes"
	}
	if changed {
		return "contains modified or untracked files"
	}
	return ""
}

// leftoverStatus is git status of what's left of a worktree: whether
// anything but a deleted file shows, and the deleted .gitignore files.
func leftoverStatus(ctx context.Context, record, path string) (changed bool, ignores []string, err error) {
	out, err := git(ctx, "--no-optional-locks", "--git-dir="+record, "--work-tree="+path, "status", "--porcelain", "-z", "--untracked-files=normal", "--ignore-submodules=none")
	if err != nil {
		return false, nil, err
	}
	entries := strings.Split(string(out), "\x00")
	for i := 0; i < len(entries); i++ {
		e := entries[i]
		if e == "" {
			continue
		}
		if len(e) < 4 || e[:3] != " D " {
			changed = true
			// A rename's entry is followed by its old path.
			if e[0] == 'R' || e[0] == 'C' {
				i++
			}
			continue
		}
		if filepath.Base(e[3:]) == ".gitignore" {
			ignores = append(ignores, e[3:])
		}
	}
	return changed, ignores, nil
}

// worktreeRecord is the folder git keeps a linked worktree's record in,
// under the repository's worktrees/: the one whose gitdir names path.
func worktreeRecord(ctx context.Context, repo, path string) (string, error) {
	out, err := git(ctx, "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", gitFailed("git rev-parse", out, err)
	}
	dir := filepath.Join(strings.TrimSpace(string(out)), "worktrees")
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		record := filepath.Join(dir, e.Name())
		b, err := os.ReadFile(filepath.Join(record, "gitdir"))
		if err != nil {
			continue
		}
		gitdir := strings.TrimSpace(string(b))
		if !filepath.IsAbs(gitdir) {
			gitdir = filepath.Join(record, gitdir)
		}
		if filepath.Dir(filepath.Clean(gitdir)) == path {
			return record, nil
		}
	}
	return "", fmt.Errorf("git worktree remove: git lists '%s' but has no record of it under %s, so it was left as it is", path, dir)
}

func describe(ctx context.Context, s savedLocation) Location {
	loc := Location{Name: s.Name, Path: s.Path, Scripts: scriptsFor(s)}
	if s.Kit != nil && s.Kit.Team != nil {
		loc.KitTeam = s.Kit.Team.Org
	}
	repo, trust, _ := repoLayer(s)
	loc.RepoTrust = trust.State
	out, err := worktreeList(ctx, s.Path)
	if err != nil {
		return loc
	}
	loc.Repo = true
	loc.Remote = remoteURL(ctx, s.Path)
	loc.Slug = slugOf(loc.Remote)
	loc.DefaultBranch = defaultBranch(ctx, s.Path)
	// Agent presets come from every layer: the repository's, its kit's,
	// and this box's own.
	local := RepoConfig{}
	if s.Config != nil {
		local = *s.Config
	}
	all := layered(repo, s.Kit, local)
	loc.Agents = all.Agents
	loc.keepMain = all.KeepMain == nil || *all.KeepMain
	if all.Check != "" {
		loc.Check, loc.CheckFrom = all.Check, "config"
	} else if c := detectCheck(s.Path); c != "" {
		loc.Check, loc.CheckFrom = c, "detected"
	}
	loc.Worktrees = parseWorktrees(out, s.Path)
	for i := range loc.Worktrees {
		loc.Worktrees[i].Title = s.Titles[loc.Worktrees[i].Path]
		loc.Worktrees[i].SetupOnOpen = slices.Contains(s.FirstOpen, loc.Worktrees[i].Path)
		loc.Worktrees[i].SetupPending = slices.Contains(s.SetupPending, loc.Worktrees[i].Path)
		if m := s.Reviews[loc.Worktrees[i].Path]; m != nil && !loc.Worktrees[i].Main {
			c := *m
			loc.Worktrees[i].Review = &c
		}
	}
	withParents(loc.Worktrees, s.Parents)
	return loc
}

// parseWorktrees reads `git worktree list --porcelain`. Each worktree is named
// by its directory, with the repository's own "<repo>-" prefix removed, so
// ~/work/shop-checkout is "checkout" in location "shop".
func parseWorktrees(out []byte, repo string) []Worktree {
	all := parseWorktreeList(out, repo)
	// Worktrees git has lost track of (prunable, e.g. under a cleared /tmp)
	// are not places anyone can work.
	live := all[:0]
	for _, w := range all {
		if _, err := os.Stat(w.Path); err == nil {
			// git calls one prunable when its .git is gone, but out may be
			// older than that (a cached listing), so look afresh.
			if _, err := os.Lstat(filepath.Join(w.Path, ".git")); !w.Main && errors.Is(err, fs.ErrNotExist) {
				w.Prunable = true
			}
			live = append(live, w)
		}
	}
	return live
}

// parseWorktreeList is every worktree git has registered, its folder there
// or not.
func parseWorktreeList(out []byte, repo string) []Worktree {
	var all []Worktree
	var cur *Worktree
	prefix := filepath.Base(repo) + "-"
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		key, value, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			all = append(all, Worktree{Path: value})
			cur = &all[len(all)-1]
			cur.Main = len(all) == 1
			if cur.Main {
				cur.Name = filepath.Base(value)
			} else {
				cur.Name = strings.TrimPrefix(filepath.Base(value), prefix)
			}
		case "HEAD":
			if cur != nil && len(value) >= 10 {
				cur.Head = value[:10]
			}
		case "branch":
			if cur != nil {
				cur.Branch = strings.TrimPrefix(value, "refs/heads/")
			}
		case "locked":
			if cur != nil {
				cur.Locked, cur.LockReason = true, unquoteGit(value)
			}
		case "prunable":
			if cur != nil {
				cur.Prunable = true
			}
		}
	}
	return all
}

// unquoteGit reads a value git may have C-quoted (one with a line break or
// a quote in it).
func unquoteGit(v string) string {
	if strings.HasPrefix(v, `"`) {
		if u, err := strconv.Unquote(v); err == nil {
			return u
		}
	}
	return v
}

func git(ctx context.Context, args ...string) ([]byte, error) {
	return gitWithin(ctx, 60*time.Second, args...)
}

// gitWithin is git with its own time limit. An error from running out of
// it is errGitTimedOut, and one from ctx ending is ctx's.
func gitWithin(ctx context.Context, limit time.Duration, args ...string) ([]byte, error) {
	run, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(run, "git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil && run.Err() != nil {
		if ctx.Err() != nil {
			return out, fmt.Errorf("%w (%v)", ctx.Err(), err)
		}
		return out, fmt.Errorf("%w after %s", errGitTimedOut, friendlyDuration(limit))
	}
	return out, err
}

var errGitTimedOut = errors.New("timed out")

func friendlyDuration(d time.Duration) string {
	if d >= time.Minute && d%time.Minute == 0 {
		return fmt.Sprintf("%d min", int(d/time.Minute))
	}
	return d.String()
}

// gitFailed says why a git command failed, for a person: git's own words
// when it said any, else how it ended (timed out, stopped by a signal, or
// its exit status), so a failure never reads as "git worktree remove:"
// alone.
func gitFailed(what string, out []byte, err error) error {
	if said := strings.TrimSpace(string(out)); said != "" && !errors.Is(err, errGitTimedOut) {
		return fmt.Errorf("%s: %s", what, said)
	}
	var exit *exec.ExitError
	switch {
	case errors.Is(err, errGitTimedOut):
		return fmt.Errorf("%s %w and was stopped", what, err)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s was cancelled (%v)", what, err)
	case errors.As(err, &exit) && !exit.Exited():
		return fmt.Errorf("%s was stopped (%v) and said nothing", what, err)
	case errors.As(err, &exit):
		return fmt.Errorf("%s failed with no output (%v)", what, err)
	}
	return fmt.Errorf("%s: %v", what, err)
}

// dirtyWorktree says git would refuse to remove dir unless forced: it has
// uncommitted or untracked files. When git can't tell, it says no, and git's
// own check at removal decides.
func dirtyWorktree(repo, dir string) bool {
	// No .git: git dropped the link (a removal stopped halfway), and git
	// status there would answer for whatever repository holds the folder.
	// Its record in repo answers instead.
	if _, err := os.Lstat(filepath.Join(dir, ".git")); errors.Is(err, fs.ErrNotExist) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		record, err := worktreeRecord(ctx, repo, dir)
		return err == nil && leftoverWork(ctx, record, dir) == "contains modified or untracked files"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "status", "--porcelain")
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// unsavedWork says what removing a worktree with submodules would lose, or
// "" for nothing: changes in it or its submodules, or submodule commits or
// stashes no remote has (any local ref's: a branch's, a tag's, the stash),
// since a worktree keeps its submodules' repositories inside its own git
// folder. A ref's name on history a remote has is not kept: whether a
// remote has the tag itself would take asking it, on every removal.
// Untracked files count whatever status.showUntrackedFiles says, and when
// git can't tell, that counts as something to lose.
func unsavedWork(ctx context.Context, dir string) string {
	out, err := git(ctx, "-C", dir, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none")
	if err != nil {
		return "could not be checked for changes"
	}
	if strings.TrimSpace(string(out)) != "" {
		return "contains modified or untracked files"
	}
	// Each checked-out submodule is asked itself too, so its own config
	// (status.showUntrackedFiles, submodule.<name>.ignore for the ones
	// inside it) can't hide a change from the status above.
	out, err = git(ctx, "-C", dir, "submodule", "foreach", "--quiet", "--recursive",
		"git status --porcelain --untracked-files=normal --ignore-submodules=none")
	if err != nil {
		return "has submodules that could not be checked for changes"
	}
	if strings.TrimSpace(string(out)) != "" {
		return "contains modified or untracked files in a submodule"
	}
	// Every submodule repository the removal deletes, against every local
	// ref it has: those in the worktree's git folder, checked out or not (a
	// deinit leaves one behind), and those a checked-out submodule keeps in
	// its own .git (one made with git clone), with the ones under that .git
	// in turn.
	gitDir, err := git(ctx, "-C", dir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return "has submodules that could not be checked for unpushed work"
	}
	repos, err := moduleRepos(filepath.Join(strings.TrimSpace(string(gitDir)), "modules"))
	if err != nil {
		return "has submodules that could not be checked for unpushed work"
	}
	out, err = git(ctx, "-C", dir, "submodule", "foreach", "--quiet", "--recursive", "git rev-parse --absolute-git-dir")
	if err != nil {
		return "has submodules that could not be checked for unpushed work"
	}
	for _, repo := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if repo == "" {
			continue
		}
		nested, err := moduleRepos(filepath.Join(repo, "modules"))
		if err != nil {
			return "has submodules that could not be checked for unpushed work"
		}
		for _, r := range append([]string{repo}, nested...) {
			if !slices.Contains(repos, r) {
				repos = append(repos, r)
			}
		}
	}
	for _, repo := range repos {
		out, err := git(ctx, "--git-dir="+repo, "rev-list", "-1", "--all", "--not", "--remotes")
		if err != nil {
			return "has submodules that could not be checked for unpushed work"
		}
		if strings.TrimSpace(string(out)) != "" {
			return "contains submodule commits or stashes that no remote has"
		}
	}
	return ""
}

// moduleRepos lists the submodule repositories git keeps under a modules
// folder, nested submodules' included. A name may hold slashes, so any
// folder that isn't a repository is looked into.
func moduleRepos(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var repos []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if _, err := os.Stat(filepath.Join(p, "HEAD")); err == nil {
			repos = append(repos, p)
			p = filepath.Join(p, "modules")
		}
		nested, err := moduleRepos(p)
		if err != nil {
			return nil, err
		}
		repos = append(repos, nested...)
	}
	return repos, nil
}

func expandHome(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~"))
		}
	}
	return path
}

func (l *Locations) read() ([]savedLocation, error) {
	b, err := os.ReadFile(l.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var all []savedLocation
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, fmt.Errorf("%s is unreadable (a backup may be at %s.bak): %w", l.path, l.path, err)
	}
	return all, nil
}

func (l *Locations) update(change func([]savedLocation) ([]savedLocation, error)) error {
	unlock, err := statefile.Lock(l.path)
	if err != nil {
		return err
	}
	defer unlock()
	all, err := l.read()
	if err != nil {
		return err
	}
	all, err = change(all)
	if err != nil {
		return err
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Name < all[j].Name })
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return statefile.WriteWithBackup(l.path, append(b, '\n'))
}
