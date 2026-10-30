package box

import (
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// lookGuard keeps an agent from starting unseen in a worktree on its way
// out. A removal holds its folder from its last look for agents until the
// removal ends, the folder gone or not (removeAfter), and a session start
// holds its own folder while it starts (startUnseen). Each waits only for
// the other in the same folder, or one holding a folder around it, so a
// removal that takes git minutes holds up no session anywhere else on the
// box.
type lookGuard struct {
	mu       sync.Mutex
	changed  *sync.Cond
	removing []string
	starting []string
}

// remove holds dir for a removal, once no session is starting in it or
// under it and no other removal holds a folder that overlaps it.
func (g *lookGuard) remove(dir string) (release func()) {
	return g.hold(&g.removing, dir, func() bool {
		return slices.ContainsFunc(g.starting, func(s string) bool { return within(s, dir) }) ||
			slices.ContainsFunc(g.removing, func(r string) bool { return within(r, dir) || within(dir, r) })
	})
}

// start holds dir for a session start, once no removal holds it or a
// folder around it. A session with no folder never waits.
func (g *lookGuard) start(dir string) (release func()) {
	if dir == "" {
		return func() {}
	}
	return g.hold(&g.starting, dir, func() bool {
		return slices.ContainsFunc(g.removing, func(r string) bool { return within(dir, r) })
	})
}

func (g *lookGuard) hold(held *[]string, dir string, blocked func() bool) func() {
	dir = filepath.Clean(dir)
	g.mu.Lock()
	if g.changed == nil {
		g.changed = sync.NewCond(&g.mu)
	}
	for blocked() {
		g.changed.Wait()
	}
	*held = append(*held, dir)
	g.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			if i := slices.Index(*held, dir); i >= 0 {
				*held = slices.Delete(*held, i, i+1)
			}
			g.changed.Broadcast()
			g.mu.Unlock()
		})
	}
}

// within says dir is folder or inside it.
func within(dir, folder string) bool {
	dir, folder = filepath.Clean(dir), filepath.Clean(folder)
	return dir == folder || strings.HasPrefix(dir, folder+string(filepath.Separator))
}
