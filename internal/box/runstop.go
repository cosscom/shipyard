package box

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/events"
)

// The stop template's leaves (runs/templates/stop.json): the app's bulk
// Stop, done by the box, so it carries on while the laptop sleeps. The words
// a worktree's step ends with are the ones the app shows on its row
// (app/src/lib/removing.ts, archive-after-stop.ts).
const (
	stopArchived   = "Archived; its branch is kept"
	stopArchiving  = "Archiving: its archive script runs, then it goes"
	keptDirty      = "Kept: uncommitted changes"
	keptStopFailed = "Kept: an agent there didn't stop"
	keptOtherAgent = "Kept: another agent is still running there"
)

func kept(why string) runs.Result { return runs.Result{Status: runs.Skipped, Out: why} }

// stopSession ends one session as DELETE /v1/sessions/{name} does, its
// session.stop gate included. One already gone is done. A cancelled run
// still finishes the stop it is in.
func (h *runHost) stopSession(ctx context.Context, x *runs.StepCtx) runs.Result {
	b := h.b
	name := target(x)
	if name == "" {
		return fail(errors.New("no session to stop"))
	}
	ctx = context.WithoutCancel(ctx)
	if err := b.beforeAs(ctx, origOf(x), "session.stop", map[string]any{"name": name}); err != nil {
		return fail(err)
	}
	if err := b.Sessions.Kill(ctx, name); err != nil {
		if errors.Is(err, ErrUnknownSession) {
			return runs.Result{Status: runs.Succeeded, Out: "already stopped"}
		}
		return fail(err)
	}
	b.Events.Publish(events.Event{Type: "session.stopped", Box: b.Name, Origin: origOf(x), Data: map[string]any{"name": name, "run": x.Run.ID}})
	return runs.Result{Status: runs.Succeeded, Out: "stopped"}
}

// archiveWorktree archives the worktree a stop run's item names, where it's
// safe: never forced and its branch kept, so a worktree with uncommitted
// changes stays, as does one where an agent still runs, which archiving
// would end (one of the run's whose stop failed, or anyone else's). Plain
// shells close with it, as when archiving by hand. One already gone is
// done; one already on its way out is waited for, not archived twice
// (dropWorktree). A review worktree's review/ branch is Shipyard's own and
// goes with it, as with every Archive (dropWorktree). The box's stop runs
// archive one at a time (archiveTurn), each looking for agents once its turn
// comes.
func (h *runHost) archiveWorktree(ctx context.Context, x *runs.StepCtx) runs.Result {
	b := h.b
	location, name, path := x.Vars["item.location"], x.Vars["item.name"], x.Vars["item.path"]
	// Its turn first, then the worktree looked up: one archived meanwhile
	// is found gone.
	release, err := b.archiveTurn(ctx)
	if err != nil {
		// Cancelled, or berthd stopping, while it waited its turn: nothing
		// was done, and a resumed run asks again.
		return runs.Result{Status: runs.Cancelled}
	}
	// The turn ends when the archive does, which may be after this step
	// (cancelled while the script runs).
	handed := false
	defer func() {
		if !handed {
			release()
		}
	}()
	loc, err := b.Locations.Get(ctx, location)
	if errors.Is(err, ErrUnknownLocation) {
		return runs.Result{Status: runs.Succeeded, Out: "already gone"}
	}
	if err != nil {
		return fail(err)
	}
	var wt Worktree
	for _, w := range loc.Worktrees {
		if w.Name == name {
			wt = w
		}
	}
	if wt.Path == "" || (path != "" && wt.Path != path) {
		// Its folder gone while git still has it (a removal stopped
		// halfway, then the rest deleted): what git kept goes too, so a
		// worktree can be made there again.
		if g, ok := goneWorktree(ctx, loc, name); ok && (path == "" || g.Path == path) {
			// RemoveWorktree forgets a review's mark: read it first.
			_, mark := b.Locations.reviewAt(g.Path)
			if err := b.Locations.RemoveWorktree(ctx, location, name, false); err != nil {
				return fail(err)
			}
			// As any removal does: the watcher can't have said so if
			// berthd was down when the folder went.
			b.Locations.Ports.Release(g.Path)
			b.Events.Publish(events.Event{Type: "worktree.removed", Box: b.Name, Origin: origOf(x), Data: map[string]any{"location": loc.Name, "name": name, "path": g.Path}})
			if mark != nil {
				git(ctx, "-C", loc.Path, "update-ref", "-d", reviewRef(mark.PR))
				b.Events.Publish(events.Event{Type: "review.removed", Box: b.Name, Origin: origOf(x), Data: map[string]any{
					"location": loc.Name, "name": name, "path": g.Path, "repo": mark.Repo, "pr": mark.PR, "reason": "archived",
				}})
			}
		}
		return runs.Result{Status: runs.Succeeded, Out: "already gone"}
	}
	if wt.Main {
		return fail(errors.New("the main checkout is never archived"))
	}
	batch := stopBatch(x.Vars["params.sessions"])
	why, err := h.agentsIn(ctx, wt.Path, batch)
	if err != nil {
		return fail(err)
	}
	if why != "" {
		return kept(why)
	}
	if dirtyWorktree(loc.Path, wt.Path) {
		return kept(keptDirty)
	}
	if err := b.beforeAs(ctx, origOf(x), "worktree.remove", map[string]any{"location": loc.Name, "name": wt.Name, "path": wt.Path}); err != nil {
		return fail(err)
	}
	b.own(wt.Path)
	// An agent started there while the archive script ran keeps it too:
	// the folder going would end it. None starts between this last look
	// and the folder going (removeAfter). A listing that fails fails the
	// step, rather than passing for an agent.
	keep := func() error {
		why, err := h.agentsIn(context.Background(), wt.Path, batch)
		if err != nil {
			return err
		}
		if why != "" {
			return errAgentArrived
		}
		return nil
	}
	done := make(chan error, 1)
	handed = true
	if _, err := b.dropWorktreeIf(origOf(x), loc, wt.Name, wt.Path, "", false, "archived", func(err error) { release(); done <- err }, keep); err != nil {
		release()
		if errors.Is(err, errAgentArrived) {
			return kept(keptOtherAgent)
		}
		if strings.Contains(err.Error(), "modified or untracked") {
			return kept(keptDirty)
		}
		return fail(err)
	}
	select {
	case err := <-done:
		if errors.Is(err, errAgentArrived) {
			return kept(keptOtherAgent)
		}
		if err != nil {
			return fail(err)
		}
		return runs.Result{Status: runs.Succeeded, Out: stopArchived}
	case <-ctx.Done():
		if x.Stopping != nil && x.Stopping() {
			// berthd is stopping: the step stays unfinished, and the
			// resumed run asks again, joining this archive if it still
			// runs (dropWorktree) or finding the worktree gone.
			return runs.Result{Status: runs.Cancelled}
		}
		// Cancelled: the archive goes on without the run.
		return runs.Result{Status: runs.Succeeded, Out: stopArchiving}
	}
}

var errAgentArrived = errors.New("an agent started in the worktree while it was being archived, so it was kept")

// agentsIn says why an agent session live in dir, or in a folder under it,
// keeps it: one of the run's whose stop didn't take, or another.
func (h *runHost) agentsIn(ctx context.Context, dir string, batch map[string]bool) (string, error) {
	all, err := h.b.Sessions.List(ctx)
	if err != nil {
		return "", err
	}
	why := ""
	for _, s := range all {
		if s.Exited || agentFor(s) == "" || (s.Dir != dir && !strings.HasPrefix(s.Dir, dir+string(filepath.Separator))) {
			continue
		}
		if batch[s.Name] {
			return keptStopFailed, nil
		}
		why = keptOtherAgent
	}
	return why, nil
}

// stopBatch is the run's sessions, by name: given as names or as
// {session, label, aside}.
func stopBatch(param string) map[string]bool {
	var items []any
	json.Unmarshal([]byte(param), &items)
	out := map[string]bool{}
	for _, it := range items {
		switch v := it.(type) {
		case string:
			out[v] = true
		case map[string]any:
			if s, ok := v["session"].(string); ok {
				out[s] = true
			}
		}
	}
	return out
}
