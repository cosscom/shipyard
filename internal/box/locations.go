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
}

type Worktree struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
	Head   string `json:"head,omitempty"`
	// Main marks the repository's own checkout.
	Main bool `json:"main,omitempty"`
	// SettingUp is true when the tool that made it is still running its
	// setup; a worktree.setup event follows.
	SettingUp bool `json:"setting_up,omitempty"`
	// Port is the first of the worktree's own ports ($BERTH_PORT).
	Port int `json:"port,omitempty"`
	// Locked is set when git has the worktree locked, with LockReason
	// its reason ("initializing" while `git worktree add` runs).
	Locked     bool   `json:"locked,omitempty"`
	LockReason string `json:"lock_reason,omitempty"`
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
		if b, err := git(ctx, "-C", s.Path, "worktree", "list", "--porcelain"); err == nil {
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
	switch {
	case branchExists(ctx, loc.Path, "refs/heads/"+branch):
		// An existing branch is checked out as it is, to review or continue.
		args = append(args, path, branch)
	case branchExists(ctx, loc.Path, "refs/remotes/origin/"+branch):
		args = append(args, "--track", "-b", branch, path, "origin/"+branch)
	default:
		args = append(args, "-b", branch, path)
		if base != "" {
			args = append(args, base)
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
			return w, nil
		}
	}
	return Worktree{Name: name, Path: path, Branch: branch}, nil
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

// RemoveWorktree removes a worktree. Git refuses when it has uncommitted
// changes unless force is set, and that refusal is passed on unchanged.
func (l *Locations) RemoveWorktree(ctx context.Context, location, name string, force bool) error {
	loc, err := l.Get(ctx, location)
	if err != nil {
		return err
	}
	for _, w := range loc.Worktrees {
		if w.Name != name {
			continue
		}
		if w.Main {
			return errors.New("refusing to remove the repository's main checkout")
		}
		if w.Locked {
			if !ownLock(w.LockReason) {
				return errLocked(loc.Path, w)
			}
			if out, err := git(ctx, "-C", loc.Path, "worktree", "unlock", w.Path); err != nil {
				return fmt.Errorf("git worktree unlock: %s", strings.TrimSpace(string(out)))
			}
		}
		args := []string{"-C", loc.Path, "worktree", "remove", w.Path}
		if force {
			args = append(args, "--force")
		}
		if out, err := git(ctx, args...); err != nil {
			return fmt.Errorf("git worktree remove: %s", strings.TrimSpace(string(out)))
		}
		// A worktree made again under the same name starts without a title.
		l.forgetTitle(location, w.Path)
		l.forgetParent(location, w.Path)
		l.setReview(location, w.Path, nil)
		return nil
	}
	return ErrUnknownWorktree
}

func describe(ctx context.Context, s savedLocation) Location {
	loc := Location{Name: s.Name, Path: s.Path, Scripts: scriptsFor(s)}
	if s.Kit != nil && s.Kit.Team != nil {
		loc.KitTeam = s.Kit.Team.Org
	}
	repo, trust, _ := repoLayer(s)
	loc.RepoTrust = trust.State
	out, err := git(ctx, "-C", s.Path, "worktree", "list", "--porcelain")
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
	if all.Check != "" {
		loc.Check, loc.CheckFrom = all.Check, "config"
	} else if c := detectCheck(s.Path); c != "" {
		loc.Check, loc.CheckFrom = c, "detected"
	}
	loc.Worktrees = parseWorktrees(out, s.Path)
	for i := range loc.Worktrees {
		loc.Worktrees[i].Title = s.Titles[loc.Worktrees[i].Path]
		loc.Worktrees[i].SetupOnOpen = slices.Contains(s.FirstOpen, loc.Worktrees[i].Path)
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
		}
	}
	// Worktrees git has lost track of (prunable, e.g. under a cleared /tmp)
	// are not places anyone can work.
	live := all[:0]
	for _, w := range all {
		if _, err := os.Stat(w.Path); err == nil {
			live = append(live, w)
		}
	}
	return live
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
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	return cmd.CombinedOutput()
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
