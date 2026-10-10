package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"

	"github.com/cosscom/shipyard/internal/proxy"
	"github.com/cosscom/shipyard/internal/statefile"
)

// Route sends every host matching Pattern to one port on a box with the Host
// header unchanged, for routers on the box that pick a worktree by hostname.
type Route struct {
	Pattern string `json:"pattern"`
	Box     string `json:"box"`
	Port    int    `json:"port"`
}

var errUnknownRoute = errors.New("no route with that pattern")

type routeStore struct {
	path string
	// cache keeps the routes until the file changes: the proxy looks them
	// up for every request it relays. Nil reads the file every time.
	cache *statefile.Cache[[]Route]
}

func newRouteStore(path string) routeStore {
	return routeStore{path: path, cache: new(statefile.Cache[[]Route])}
}

// current is list, read again only once the file has changed. Its result
// is shared: callers must not change it.
func (s routeStore) current() ([]Route, error) {
	if s.cache == nil {
		return s.list()
	}
	return s.cache.Load(s.path, s.list)
}

func (s routeStore) list() ([]Route, error) {
	b, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var all []Route
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, fmt.Errorf("%s is unreadable (a backup may be at %s.bak): %w", s.path, s.path, err)
	}
	return all, nil
}

// update changes the file under its lock, never from memory, like forwards.
func (s routeStore) update(change func([]Route) ([]Route, error)) error {
	unlock, err := statefile.Lock(s.path)
	if err != nil {
		return err
	}
	defer unlock()
	all, err := s.list()
	if err != nil {
		return err
	}
	if all, err = change(all); err != nil {
		return err
	}
	// Longest pattern first, so a more specific route wins.
	sort.Slice(all, func(i, j int) bool { return len(all[i].Pattern) > len(all[j].Pattern) })
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return statefile.WriteWithBackup(s.path, append(b, '\n'))
}

func (a *Agent) addRoute(r Route) error {
	if !proxy.ValidRoutePattern(r.Pattern) {
		return fmt.Errorf("route %q must look like *.name.localhost", r.Pattern)
	}
	if r.Port < 1 || r.Port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	if _, ok := a.client(r.Box); !ok {
		return fmt.Errorf("no paired box named %q", r.Box)
	}
	return a.routes.update(func(all []Route) ([]Route, error) {
		out := all[:0]
		for _, existing := range all {
			if existing.Pattern != r.Pattern {
				out = append(out, existing)
			}
		}
		return append(out, r), nil
	})
}

func (a *Agent) removeRoute(pattern string) error {
	return a.routes.update(func(all []Route) ([]Route, error) {
		for i, r := range all {
			if r.Pattern == pattern {
				return append(all[:i], all[i+1:]...), nil
			}
		}
		return nil, errUnknownRoute
	})
}

// route resolves a request host. Routes are read from disk whenever the
// file changes (a stat tells), so edits apply without restarting the agent.
func (a *Agent) route(host string) (string, int, bool) {
	all, err := a.routes.current()
	if err != nil {
		return "", 0, false
	}
	for _, r := range all {
		if proxy.MatchRoute(r.Pattern, host) {
			return r.Box, r.Port, true
		}
	}
	return "", 0, false
}
