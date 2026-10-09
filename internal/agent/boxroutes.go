package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/sshroute"
	"github.com/cosscom/shipyard/internal/sshsetup"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/trust"
	"github.com/cosscom/shipyard/internal/wire"
)

// Routes to a box: besides the address it was paired at, the agent can
// reach a box over SSH (the host it was added with, through the person's
// own ssh) or at another address. internal/wire carries requests on the
// fastest one that works and moves to another when it stalls; this file is
// where the routes come from, what the person turned on or off, and how
// they show in the box's status. It sits under the health check: a box is
// online when any route answers.

// RouteSetting is a route the person (or `berth add ssh`) set up for a box,
// or the paired address turned off.
type RouteSetting struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Host is the SSH host as typed: [user@]host or a Host from
	// ~/.ssh/config. Identity is a key file chosen at setup (ssh -i): only
	// its path is kept. Forward is where berthd listens as the box sees it,
	// when that isn't the paired address.
	Host     string `json:"host,omitempty"`
	Identity string `json:"identity,omitempty"`
	Forward  string `json:"forward,omitempty"`
	// Address is a direct route's host:port.
	Address string `json:"address,omitempty"`
	Off     bool   `json:"off,omitempty"`
	// Auto marks the SSH route `berth add ssh` turned on.
	Auto bool `json:"auto,omitempty"`
}

// BoxRoutes are one box's route settings, for the key it was paired with.
type BoxRoutes struct {
	Fingerprint string         `json:"fingerprint"`
	Routes      []RouteSetting `json:"routes"`
}

// RouteStatus is one route as the app and `berth boxes` show it.
type RouteStatus struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
	// Detail is the SSH host or the address.
	Detail string `json:"detail,omitempty"`
	// State is up, stalled, down, unknown (not tried yet) or off.
	State     string `json:"state"`
	LatencyMs int64  `json:"latency_ms,omitempty"`
	Active    bool   `json:"active,omitempty"`
	Error     string `json:"error,omitempty"`
	Auto      bool   `json:"auto,omitempty"`
	// Suggested: ~/.ssh/config has a host named like the box; it is off
	// until the person turns it on.
	Suggested bool `json:"suggested,omitempty"`
}

// EventBoxRoute is published when a box's active route changes or a route
// is declared down.
const EventBoxRoute = "box.route"

const (
	routeSSH      = "ssh"
	routeLoopTick = time.Second
)

func routeStorePath(dir string) string { return filepath.Join(dir, "box-routes.json") }

func readBoxRoutes(path string) (map[string]BoxRoutes, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]BoxRoutes{}, nil
	}
	if err != nil {
		return nil, err
	}
	all := map[string]BoxRoutes{}
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, fmt.Errorf("%s is unreadable: %w", path, err)
	}
	return all, nil
}

// updateBoxRoutes changes one box's settings under the file's lock.
func updateBoxRoutes(dir string, box string, fingerprint string, change func(*BoxRoutes) error) error {
	path := routeStorePath(dir)
	unlock, err := statefile.Lock(path)
	if err != nil {
		return err
	}
	defer unlock()
	all, err := readBoxRoutes(path)
	if err != nil {
		return err
	}
	cur := all[box]
	if cur.Fingerprint != fingerprint {
		// Settings for an earlier box of this name don't carry over.
		cur = BoxRoutes{Fingerprint: fingerprint}
	}
	if err := change(&cur); err != nil {
		return err
	}
	all[box] = cur
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return statefile.Write(path, b)
}

// RecordSSHRoute remembers the SSH host a box was added with, so the agent
// can reach it over SSH too. It is on by default; the person can turn it
// off in Settings › Boxes.
func RecordSSHRoute(dir, box, fingerprint, host, identity, forward string) error {
	if !sshroute.ValidHost(host) {
		return fmt.Errorf("%q is not an SSH host", host)
	}
	if forward != "" && !sshroute.ValidForward(forward) {
		return fmt.Errorf("%q is not a host:port", forward)
	}
	return updateBoxRoutes(dir, box, fingerprint, func(r *BoxRoutes) error {
		r.Routes = slices.DeleteFunc(r.Routes, func(s RouteSetting) bool { return s.Kind == wire.RouteSSH })
		r.Routes = append(r.Routes, RouteSetting{ID: routeSSH, Kind: wire.RouteSSH, Host: host, Identity: identity, Forward: forward, Auto: true})
		return nil
	})
}

// routeSettings is the settings file, read again only once it changes:
// every request the app relays to a box syncs the boxes first. The map is
// shared: callers must not change it.
func (a *Agent) routeSettings() map[string]BoxRoutes {
	path := routeStorePath(a.cfg.Dir)
	all, err := a.boxRoutes.Load(path, func() (map[string]BoxRoutes, error) { return readBoxRoutes(path) })
	if err != nil {
		a.cfg.Log.Printf("box routes: %v", err)
		return map[string]BoxRoutes{}
	}
	return all
}

func (r BoxRoutes) forPeer(p trust.Peer) []RouteSetting {
	if r.Fingerprint != p.Fingerprint.String() {
		return nil
	}
	return r.Routes
}

func settingFor(settings []RouteSetting, id string) (RouteSetting, bool) {
	for _, s := range settings {
		if s.ID == id {
			return s, true
		}
	}
	return RouteSetting{}, false
}

// tailnetAddr reports whether an address is in Tailscale's ranges.
func tailnetAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return strings.HasSuffix(host, ".ts.net")
	}
	_, cgnat, _ := net.ParseCIDR("100.64.0.0/10")
	_, ula, _ := net.ParseCIDR("fd7a:115c:a1e0::/48")
	return cgnat.Contains(ip) || ula.Contains(ip)
}

// pairedRoute names the route to the address the box was paired at.
func pairedRoute(p trust.Peer) (kind, label string) {
	switch {
	case p.Network != "":
		return wire.RouteTailscale, "Tailscale (" + p.Network + ")"
	case tailnetAddr(p.Address):
		return wire.RouteTailscale, "Tailscale"
	}
	return wire.RouteDirect, "Direct"
}

// routesFor builds the routes the agent uses for a box from its settings:
// the paired address unless turned off, then SSH and direct addresses that
// are on. A box always keeps at least one route. key says whether they
// differ from the routes a client already has.
func (a *Agent) routesFor(p trust.Peer, settings []RouteSetting) (routes []wire.Route, ssh *sshroute.Dialer, key string) {
	kind, label := pairedRoute(p)
	paired := wire.Route{ID: wire.RoutePaired, Kind: kind, Label: label, Key: p.Network + "|" + p.Address, Dial: a.dialerFor(p.Network)}
	if a.isLocal(p) {
		return []wire.Route{paired}, nil, paired.Key
	}
	if s, ok := settingFor(settings, wire.RoutePaired); !ok || !s.Off {
		routes = append(routes, paired)
	}
	for _, s := range settings {
		if s.Off {
			continue
		}
		switch s.Kind {
		case wire.RouteSSH:
			forward := s.Forward
			if forward == "" {
				forward = p.Address
			}
			ssh = &sshroute.Dialer{SSH: a.cfg.SSH, Host: s.Host, Identity: s.Identity, Forward: forward, ControlDir: a.sshControlDir(), Finder: a.cfg.SSHFinder}
			routes = append(routes, wire.Route{ID: s.ID, Kind: wire.RouteSSH, Label: "SSH", Key: s.Host + "|" + s.Identity + "|" + forward, Dial: ssh.Dial})
		case wire.RouteDirect:
			addr := s.Address
			routes = append(routes, wire.Route{ID: s.ID, Kind: wire.RouteDirect, Label: "Direct", Key: addr, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
			}})
		}
	}
	if len(routes) == 0 {
		routes = []wire.Route{paired}
	}
	var keys []string
	for _, r := range routes {
		keys = append(keys, r.ID+"="+r.Key)
	}
	return routes, ssh, strings.Join(keys, ",")
}

// sshControlDir holds the SSH routes' shared connections. Under a state
// directory too long for a socket path, each connection logs in itself.
func (a *Agent) sshControlDir() string { return filepath.Join(a.cfg.Dir, "ssh") }

// applyRoutesLocked gives a box's client the routes its settings call for,
// when they changed. a.mu is held.
func (a *Agent) applyRoutesLocked(name string, st *boxState, settings []RouteSetting) {
	routes, ssh, key := a.routesFor(st.peer, settings)
	if key == st.routeKey {
		return
	}
	if st.ssh != nil && (ssh == nil || st.ssh.Host != ssh.Host) {
		go st.ssh.Close()
	}
	st.routeKey, st.ssh = key, ssh
	st.client.SetRoutes(routes)
	st.client.OnRouteChange(func(ch wire.RouteChange) { a.routeChanged(name, st, ch) })
	if a.cfg.RouteTiming != (wire.RouteTiming{}) {
		st.client.SetTiming(a.cfg.RouteTiming)
	}
}

// routeChanged is told when a box's active route changes or a route is
// declared down: it says so in the log, drops the proxy's pooled streams to
// the box when they rode a route that went down, and tells the app.
func (a *Agent) routeChanged(name string, st *boxState, ch wire.RouteChange) {
	label := map[string]string{}
	for _, r := range st.client.Routes() {
		label[r.ID] = r.Label
	}
	if ch.Down != "" {
		a.cfg.Log.Printf("box %s: route %s is down (%s); its streams move to %s", name, label[ch.Down], ch.Reason, label[ch.To])
		a.proxy.ResetBox(name)
	} else if ch.From != ch.To {
		a.cfg.Log.Printf("box %s: now via %s, was %s (%s)", name, label[ch.To], label[ch.From], ch.Reason)
	}
	a.publish(Event{Type: EventBoxRoute, Box: name, Data: map[string]any{"route": ch.To, "from": ch.From, "down": ch.Down}})
}

// routeLoop measures routes that are due, for every box: the routes not in
// use every minute or so while the box is in use, and a route that just
// stalled again soon (wire.Client.ProbeRoutes decides). It is apart from the
// health loop, which checks each box over its active route.
func (a *Agent) routeLoop(ctx context.Context) {
	timing := a.cfg.RouteTiming
	if timing == (wire.RouteTiming{}) {
		timing = wire.DefaultRouteTiming
	}
	tick := time.NewTicker(min(max(timing.ProbeStalled/2, 20*time.Millisecond), routeLoopTick))
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		a.mu.Lock()
		var clients []*wire.Client
		for _, st := range a.clients {
			if st.status.State == StateOnline {
				clients = append(clients, st.client)
			}
		}
		a.mu.Unlock()
		// Each box on its own: a slow first SSH login to one doesn't hold up
		// another's checks. A route being measured isn't measured twice.
		for _, c := range clients {
			go c.ProbeRoutes(ctx)
		}
	}
}

// routeStatusLocked is a box's routes for its status: the client's, then
// the ones turned off, then an SSH host the box might be reached at. a.mu
// is held.
func (a *Agent) routeStatusLocked(st *boxState, settings []RouteSetting, sshHosts []string) (string, []RouteStatus) {
	if a.isLocal(st.peer) {
		return "", nil
	}
	active := ""
	var out []RouteStatus
	seen := map[string]bool{}
	for _, r := range st.client.Routes() {
		s, _ := settingFor(settings, r.ID)
		rs := RouteStatus{ID: r.ID, Kind: r.Kind, Label: r.Label, State: r.State, LatencyMs: r.Latency.Milliseconds(), Active: r.Active, Error: r.Error, Auto: s.Auto}
		if r.Latency > 0 && rs.LatencyMs == 0 {
			rs.LatencyMs = 1
		}
		rs.Detail = routeDetail(st.peer, s, r.ID)
		if r.Active {
			active = r.ID
		}
		seen[r.ID] = true
		out = append(out, rs)
	}
	kind, label := pairedRoute(st.peer)
	for _, s := range settings {
		if seen[s.ID] || !s.Off {
			continue
		}
		rs := RouteStatus{ID: s.ID, Kind: s.Kind, Label: map[string]string{wire.RouteSSH: "SSH", wire.RouteDirect: "Direct"}[s.Kind], State: "off", Auto: s.Auto}
		if s.ID == wire.RoutePaired {
			rs.Kind, rs.Label = kind, label
		}
		rs.Detail = routeDetail(st.peer, s, s.ID)
		out = append(out, rs)
	}
	if !slices.ContainsFunc(settings, func(s RouteSetting) bool { return s.Kind == wire.RouteSSH }) && slices.Contains(sshHosts, st.peer.Name) {
		out = append(out, RouteStatus{ID: routeSSH, Kind: wire.RouteSSH, Label: "SSH", Detail: st.peer.Name, State: "off", Suggested: true})
	}
	return active, out
}

// markRelayed names the paired route "Tailscale relayed" when the link
// check (link.go) found Tailscale relays it.
func markRelayed(b *BoxStatus) {
	if b.Link.Path == nil || !b.Link.Path.Relayed() {
		return
	}
	for i, r := range b.Routes {
		if r.ID == wire.RoutePaired && r.Kind == wire.RouteTailscale {
			b.Routes[i].Label += " relayed"
		}
	}
}

// RelayedNow reports whether the box's requests go through a Tailscale
// relay: its link is relayed and the route in use is the paired address.
func (b BoxStatus) RelayedNow() bool {
	return b.Link.Path != nil && b.Link.Path.Relayed() && (b.Route == "" || b.Route == wire.RoutePaired)
}

func routeDetail(p trust.Peer, s RouteSetting, id string) string {
	switch {
	case id == wire.RoutePaired:
		return p.Address
	case s.Kind == wire.RouteSSH:
		return s.Host
	}
	return s.Address
}

// configHosts are the hosts ~/.ssh/config names, read at most once a minute
// (it is only read, never changed).
func (a *Agent) configHosts() []string {
	a.hostsMu.Lock()
	defer a.hostsMu.Unlock()
	if time.Since(a.hostsAt) > time.Minute {
		a.hostsAt = time.Now()
		if a.cfg.SSHHosts != nil {
			a.hosts = a.cfg.SSHHosts()
		} else {
			a.hosts = sshsetup.Hosts(sshFinder().Home)
		}
	}
	return a.hosts
}

// boxRouteAPI lets the app and the CLI add, turn on or off, and remove a
// box's routes:
//
//	POST   /v1/boxes/{box}/routes       {"kind":"ssh","host":"alex@devl"} or {"kind":"direct","address":"192.168.1.20:7444"}
//	PATCH  /v1/boxes/{box}/routes/{id}  {"off":true}
//	DELETE /v1/boxes/{box}/routes/{id}
func (a *Agent) boxRouteAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/boxes/{box}/routes", func(w http.ResponseWriter, r *http.Request) {
		a.sync()
		for _, b := range a.status().Boxes {
			if b.Name == r.PathValue("box") {
				writeJSON(w, http.StatusOK, b.Routes)
				return
			}
		}
		writeError(w, http.StatusNotFound, "no paired box named "+r.PathValue("box"))
	})
	mux.HandleFunc("POST /v1/boxes/{box}/routes", func(w http.ResponseWriter, r *http.Request) {
		var req RouteSetting
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request")
			return
		}
		a.changeRoutes(w, r.PathValue("box"), func(p trust.Peer, cur *BoxRoutes) error {
			switch req.Kind {
			case wire.RouteSSH:
				if !sshroute.ValidHost(req.Host) {
					return fmt.Errorf("%q is not an SSH host", req.Host)
				}
				if req.Forward != "" && !sshroute.ValidForward(req.Forward) {
					return fmt.Errorf("%q is not a host:port", req.Forward)
				}
				if req.Identity != "" && !filepath.IsAbs(req.Identity) {
					return errors.New("the key file must be a full path")
				}
				cur.Routes = slices.DeleteFunc(cur.Routes, func(s RouteSetting) bool { return s.Kind == wire.RouteSSH })
				cur.Routes = append(cur.Routes, RouteSetting{ID: routeSSH, Kind: wire.RouteSSH, Host: req.Host, Identity: req.Identity, Forward: req.Forward})
			case wire.RouteDirect:
				host, port, err := net.SplitHostPort(req.Address)
				if err != nil || host == "" || port == "" || strings.ContainsAny(req.Address, " /") {
					return fmt.Errorf("%q is not a host:port", req.Address)
				}
				id := "direct:" + req.Address
				if id == "direct:"+p.Address {
					return errors.New("that is the address the box was paired at")
				}
				cur.Routes = slices.DeleteFunc(cur.Routes, func(s RouteSetting) bool { return s.ID == id })
				cur.Routes = append(cur.Routes, RouteSetting{ID: id, Kind: wire.RouteDirect, Address: req.Address})
			default:
				return errors.New("a route is kind ssh (with host) or direct (with address)")
			}
			return nil
		})
	})
	mux.HandleFunc("PATCH /v1/boxes/{box}/routes/{id}", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Off bool `json:"off"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request")
			return
		}
		id := r.PathValue("id")
		a.changeRoutes(w, r.PathValue("box"), func(p trust.Peer, cur *BoxRoutes) error {
			i := slices.IndexFunc(cur.Routes, func(s RouteSetting) bool { return s.ID == id })
			switch {
			case i >= 0:
				cur.Routes[i].Off = req.Off
			case id == wire.RoutePaired:
				cur.Routes = append(cur.Routes, RouteSetting{ID: wire.RoutePaired, Kind: "paired", Off: req.Off})
			default:
				return errNoRoute
			}
			return keepOne(cur.Routes)
		})
	})
	mux.HandleFunc("DELETE /v1/boxes/{box}/routes/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		a.changeRoutes(w, r.PathValue("box"), func(p trust.Peer, cur *BoxRoutes) error {
			if id == wire.RoutePaired {
				return errors.New("the address the box was paired at can be turned off, not removed")
			}
			n := len(cur.Routes)
			cur.Routes = slices.DeleteFunc(cur.Routes, func(s RouteSetting) bool { return s.ID == id })
			if len(cur.Routes) == n {
				return errNoRoute
			}
			return keepOne(cur.Routes)
		})
	})
}

var errNoRoute = errors.New("the box has no route with that id")

// keepOne refuses settings that would leave a box no route at all.
func keepOne(settings []RouteSetting) error {
	if s, ok := settingFor(settings, wire.RoutePaired); !ok || !s.Off {
		return nil
	}
	if slices.ContainsFunc(settings, func(s RouteSetting) bool { return s.ID != wire.RoutePaired && !s.Off }) {
		return nil
	}
	return errors.New("a box needs one route on: turn another on first")
}

func (a *Agent) changeRoutes(w http.ResponseWriter, box string, change func(trust.Peer, *BoxRoutes) error) {
	p, ok, err := a.boxes.ByName(box)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "no paired box named "+box)
		return
	}
	if a.isLocal(p) {
		writeError(w, http.StatusBadRequest, box+" is this computer: it has one route")
		return
	}
	if err := updateBoxRoutes(a.cfg.Dir, p.Name, p.Fingerprint.String(), func(cur *BoxRoutes) error { return change(p, cur) }); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errNoRoute) {
			status = http.StatusNotFound
		}
		writeError(w, status, err.Error())
		return
	}
	a.sync()
	for _, b := range a.status().Boxes {
		if b.Name == p.Name {
			a.publish(Event{Type: EventBoxRoute, Box: p.Name})
			writeJSON(w, http.StatusOK, b.Routes)
			return
		}
	}
	writeJSON(w, http.StatusOK, []RouteStatus{})
}
