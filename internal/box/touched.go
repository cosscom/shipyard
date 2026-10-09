package box

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// What the agents in a worktree changed in their latest turn, for ⌘P
// ("Changed by Claude this turn") and the File tab's margin.
//
// The list comes from the agents' own records (internal/transcript): every
// file an edit or write touched since the last prompt. The counts are a
// real line diff on the box, from the file as the turn found it to the file
// now. Claude Code's record keeps that first version beside each edit
// (originalFile), so the counts and the margin are this turn's alone. For a
// record without it (Codex), the base is the last commit, and Base says so.

// TouchedFile is one file an agent changed this turn.
type TouchedFile struct {
	Path    string `json:"path"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	// Created: the turn made it. Deleted: it's gone now.
	Created bool `json:"created,omitempty"`
	Deleted bool `json:"deleted,omitempty"`
	// At is when the agent last wrote it (Unix ms).
	At int64 `json:"at,omitempty"`
	// Live: the agent wrote it in the last liveFor and its session is
	// working still, so it is likely writing it now.
	Live    bool   `json:"live,omitempty"`
	Session string `json:"session"`
	Agent   string `json:"agent"`
	// Base is what Added and Removed count from: "turn", the file as the
	// turn found it; "head", the last commit, when the record doesn't keep
	// the file's earlier version.
	Base string `json:"base"`
}

// FileTurn is TouchedFile for one file, with the file as the turn found it
// (Before; null for a file the turn made).
type FileTurn struct {
	TouchedFile
	Before *string `json:"before"`
}

// liveFor is how long after an agent's write the file counts as being
// written (TouchedFile.Live), while the agent works.
const liveFor = 20 * time.Second

func (b *Box) worktreeTouched(w http.ResponseWriter, r *http.Request) error {
	_, wt, err := b.worktreeRef(r.Context(), r.PathValue("name"), r.PathValue("worktree"))
	if err != nil {
		return err
	}
	files := []TouchedFile{}
	for _, f := range b.touchedIn(r, wt) {
		files = append(files, f.TouchedFile)
	}
	writeJSON(w, map[string]any{"files": files})
	return nil
}

// fileTurn is what this turn did to one file of the worktree, if anything.
func (b *Box) fileTurn(r *http.Request, wt Worktree, rel string) *FileTurn {
	for _, f := range b.touchedIn(r, wt) {
		if f.Path == rel {
			return &f
		}
	}
	return nil
}

// touchedIn reads every agent session in the worktree (or a folder inside
// it) for its latest turn's files, newest first. One file two agents both
// touched is the latest's.
func (b *Box) touchedIn(r *http.Request, wt Worktree) []FileTurn {
	if b.Sessions == nil {
		return nil
	}
	sessions, err := b.Sessions.List(r.Context())
	if err != nil {
		return nil
	}
	// Each agent's state: a file is live only while its agent works.
	sessions = b.enrich(r.Context(), sessions)
	now := time.Now()
	root, err := filepath.EvalSymlinks(wt.Path)
	if err != nil {
		return nil
	}
	byPath := map[string]FileTurn{}
	for _, s := range sessions {
		if s.Service != "" {
			continue
		}
		dir, err := filepath.EvalSymlinks(s.Dir)
		if err != nil {
			continue
		}
		if _, inside := relInside(root, dir); !inside && dir != root {
			continue
		}
		agent, path, _ := b.transcriptFile(r, s, sessions)
		if path == "" || (agent != "claude" && agent != "codex") {
			continue
		}
		turn, ok := cachedTurn(agent, path, s.Dir)
		if !ok {
			continue
		}
		for _, f := range turn.Files {
			ft, ok := touchedFile(r.Context(), root, dir, f)
			if !ok {
				continue
			}
			ft.Session, ft.Agent = s.Name, agent
			ft.Live = s.AgentState == "running" && !ft.Deleted && ft.At > 0 && now.Sub(time.UnixMilli(ft.At)) < liveFor
			if have, ok := byPath[ft.Path]; !ok || ft.At > have.At {
				byPath[ft.Path] = ft
			}
		}
	}
	out := make([]FileTurn, 0, len(byPath))
	for _, f := range byPath {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].At != out[j].At {
			return out[i].At > out[j].At
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// touchedFile is one file of a turn as the worktree at root has it now:
// its path in the worktree, its base and its counts. dir is the session's
// folder, which a relative path in the record is relative to.
func touchedFile(ctx context.Context, root, dir string, f transcript.TurnFile) (FileTurn, bool) {
	abs := filepath.FromSlash(f.Path)
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(dir, abs)
	}
	real, err := realPath(abs)
	if err != nil {
		// Its folder is gone too: nothing to show for it.
		return FileTurn{}, false
	}
	rel, ok := relInside(root, real)
	if !ok || gitPart(rel) {
		return FileTurn{}, false
	}
	ft := FileTurn{TouchedFile: TouchedFile{Path: filepath.ToSlash(rel), At: f.At, Created: f.Created, Base: "turn"}}
	switch {
	case f.Original != nil:
		ft.Before = f.Original
	case f.Created:
	default:
		// The record didn't keep it: the last commit's, or none for a file
		// git doesn't know (the turn made it, as far as can be told).
		ft.Base = "head"
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		head, err := gitOut(cctx, root, "show", "HEAD:"+ft.Path)
		cancel()
		if err == nil {
			s := string(head)
			ft.Before = &s
		} else {
			ft.Created = true
		}
	}
	before := ""
	if ft.Before != nil {
		before = *ft.Before
	}
	st, err := os.Stat(real)
	switch {
	case err != nil:
		ft.Deleted = true
		ft.Added, ft.Removed = 0, len(splitLines(before))
	case st.Size() <= maxEditableFile:
		data, err := os.ReadFile(real)
		if err != nil || isBinary(data) {
			ft.Added, ft.Removed = f.Added, f.Removed
			break
		}
		ft.Added, ft.Removed = lineCounts(before, string(data))
	default:
		ft.Added, ft.Removed = f.Added, f.Removed
	}
	if ft.At == 0 && st != nil {
		ft.At = st.ModTime().UnixMilli()
	}
	return ft, true
}

// turnCache keeps each record's latest turn until the record grows, for
// the maxTurnCache records read most recently. A turn holds every file it
// edited as it found it, so a box that runs for weeks must not keep one
// for every conversation it ever showed.
var turnCache = struct {
	sync.Mutex
	m map[string]turnEntry // record path → its latest turn
}{m: map[string]turnEntry{}}

const maxTurnCache = 64

type turnEntry struct {
	size  int64
	mtime time.Time
	dir   string
	turn  transcript.Turn
	used  time.Time
}

func cachedTurn(agent, path, dir string) (transcript.Turn, bool) {
	st, err := os.Stat(path)
	if err != nil {
		return transcript.Turn{}, false
	}
	turnCache.Lock()
	if e, ok := turnCache.m[path]; ok && e.size == st.Size() && e.mtime.Equal(st.ModTime()) && e.dir == dir {
		e.used = time.Now()
		turnCache.m[path] = e
		turnCache.Unlock()
		return e.turn, true
	}
	turnCache.Unlock()
	turn, err := transcript.LastTurn(agent, path, dir)
	if err != nil {
		return transcript.Turn{}, false
	}
	turnCache.Lock()
	defer turnCache.Unlock()
	turnCache.m[path] = turnEntry{size: st.Size(), mtime: st.ModTime(), dir: dir, turn: turn, used: time.Now()}
	for len(turnCache.m) > maxTurnCache {
		var oldest string
		var at time.Time
		for p, e := range turnCache.m {
			if oldest == "" || e.used.Before(at) {
				oldest, at = p, e.used
			}
		}
		delete(turnCache.m, oldest)
	}
	return turn, true
}
