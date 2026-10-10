package agent

import (
	"context"
	"slices"
	"time"

	"github.com/cosscom/shipyard/internal/box"
)

// serviceTTL bounds how stale the map of servers to worktrees may be; a dev
// server that just started shows up within this time.
const serviceTTL = 10 * time.Second

type serviceCache struct {
	at   time.Time
	list []box.Service
}

// serviceRecheck is how old the map may be before a URL that found nothing
// asks the box again: a dev server started a moment ago opens at once rather
// than after serviceTTL.
const serviceRecheck = time.Second

// services returns which worktree each listening server on a box belongs to.
func (a *Agent) services(ctx context.Context, name string) []box.Service {
	return a.servicesWithin(ctx, name, serviceTTL)
}

func (a *Agent) servicesWithin(ctx context.Context, name string, maxAge time.Duration) []box.Service {
	a.mu.Lock()
	cached, fresh := a.svc[name]
	st := a.clients[name]
	a.mu.Unlock()
	if fresh && time.Since(cached.at) < maxAge {
		return cached.list
	}
	if st == nil || st.status.State != StateOnline {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	list, err := box.NewClient(st.client).Services(ctx)
	if err != nil {
		return cached.list
	}
	a.mu.Lock()
	if a.svc == nil {
		a.svc = map[string]serviceCache{}
	}
	a.svc[name] = serviceCache{at: time.Now(), list: list}
	a.mu.Unlock()
	return list
}

// worktree resolves host labels to a worktree's dev server, its lowest port:
//
//	[worktree, location, box]  feat-checkout.shop.devl.localhost
//	[location, box]            shop.devl.localhost (the main checkout)
//	[worktree, location]       feat-checkout.shop.localhost, when one box has it
func (a *Agent) worktree(labels []string) (string, int, bool) {
	ctx := context.Background()
	lowest := func(boxName string, match func(box.Service) bool) (int, bool) {
		find := func(list []box.Service) int {
			port := 0
			for _, s := range list {
				if match(s) && (port == 0 || s.Port < port) {
					port = s.Port
				}
			}
			return port
		}
		port := find(a.services(ctx, boxName))
		if port == 0 {
			port = find(a.servicesWithin(ctx, boxName, serviceRecheck))
		}
		return port, port != 0
	}
	switch len(labels) {
	case 3:
		wt, loc, boxName := labels[0], labels[1], labels[2]
		port, ok := lowest(boxName, func(s box.Service) bool { return s.Location == loc && s.Worktree == wt })
		return boxName, port, ok
	case 2:
		if _, ok := a.client(labels[1]); ok {
			loc, boxName := labels[0], labels[1]
			port, ok := lowest(boxName, func(s box.Service) bool { return s.Location == loc && s.Main })
			return boxName, port, ok
		}
		wt, loc := labels[0], labels[1]
		found, foundPort := "", 0
		// Only the boxes' names: this runs for every request the proxy
		// relays, and the whole status reads files.
		for _, name := range a.boxNames() {
			if port, ok := lowest(name, func(s box.Service) bool { return s.Location == loc && s.Worktree == wt }); ok {
				if found != "" {
					return "", 0, false // ambiguous: name the box
				}
				found, foundPort = name, port
			}
		}
		return found, foundPort, found != ""
	}
	return "", 0, false
}

// boxNames is every paired box's name, sorted.
func (a *Agent) boxNames() []string {
	a.mu.Lock()
	names := make([]string, 0, len(a.clients))
	for name := range a.clients {
		names = append(names, name)
	}
	a.mu.Unlock()
	slices.Sort(names)
	return names
}
