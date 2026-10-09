// Package agent is the laptop's background process. It holds a connection to
// every paired box, runs saved forwards and the *.localhost proxy, and serves
// a local API that the CLI and the desktop app are clients of.
package agent

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/debugserver"
	"github.com/cosscom/shipyard/internal/doctor"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/forward"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/identity"
	"github.com/cosscom/shipyard/internal/network"
	"github.com/cosscom/shipyard/internal/pfredirect"
	"github.com/cosscom/shipyard/internal/proxy"
	"github.com/cosscom/shipyard/internal/sshroute"
	"github.com/cosscom/shipyard/internal/sshsetup"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/trust"
	"github.com/cosscom/shipyard/internal/wire"
	"tailscale.com/ipn/ipnstate"
)

const (
	DefaultProxyPort      = 1377
	defaultHealthInterval = 10 * time.Second
	defaultPingTimeout    = 8 * time.Second
	// A tick arriving this much later than scheduled means the laptop slept.
	wakeSkew = 20 * time.Second
	// A box's event stream that ends is followed again after a wait that
	// starts here and doubles up to relayRetryMax (with jitter).
	relayRetryBase = time.Second
	relayRetryMax  = 30 * time.Second
)

const (
	StateConnecting = "connecting"
	StateOnline     = "online"
	StateOffline    = "offline"
	StateUntrusted  = "untrusted"
)

type Config struct {
	// Dir is the laptop's state directory, holding identity.pem and boxes.json.
	Dir string
	// Socket is the local API socket. Defaults to Dir/agent.sock.
	Socket string
	// ProxyAddrs are where the *.localhost proxy listens. Defaults to port
	// 1377 on both loopback addresses.
	ProxyAddrs     []string
	HealthInterval time.Duration
	// PingTimeout is how long a health check waits for the box (default
	// 8s). The check that confirms a failed one waits a quarter longer
	// (10s): a box that stops answering shows away within about 20s.
	PingTimeout time.Duration
	// TailscaleStatus reads this computer's Tailscale (`tailscale status
	// --json`), to tell a box reached directly from one relayed; defaults to
	// the tailscale CLI. It is asked at most every couple of minutes.
	TailscaleStatus func(ctx context.Context) (*ipnstate.Status, error)
	// UIAddr is where the desktop app's API listens; "off" turns it off.
	// Defaults to 127.0.0.1:1378.
	UIAddr string
	// CLI is the berth binary the app's box management runs. Defaults to
	// this executable.
	CLI string
	// SSHDir is the SSH configuration editors use; defaults to ~/.ssh.
	SSHDir string
	// EditorRoots are where editor apps are looked for; defaults to
	// /Applications and ~/Applications.
	EditorRoots []string
	// Run, when set, runs an editor command instead of starting it; tests
	// use it to see what would run.
	Run func(command []string) error
	// UserDir holds hooks, themes, templates and plugins. Defaults to
	// ~/.berth.
	UserDir string
	Log     *log.Logger
	// Now reads the wall clock; tests replace it to simulate sleep.
	Now func() time.Time
	// Networks reaches boxes on other tailnets. Defaults to embedded
	// Tailscale nodes under Dir/networks.
	Networks Networks
	// QueueIdleTimeout is how long a queued prompt waits for a busy agent's
	// turn to end before it is typed anyway (default 30 minutes), and
	// QueueWaitStep how long one wait on the box lasts (default 5 minutes).
	QueueIdleTimeout time.Duration
	QueueWaitStep    time.Duration
	// Berthd is the berthd Use this Mac installs; defaults to the one beside
	// the berth executable or in the app's Contents/Resources (localbox.go).
	// LocalBoxPort is the first port tried for it (default 7445).
	Berthd       string
	LocalBoxPort int
	// Codex is the codex CLI that generates chat backgrounds, and CodexHome
	// where it keeps its images; default to the one on PATH and ~/.codex.
	Codex     string
	CodexHome string
	// Doctor runs `berth doctor`'s checks of this laptop, for the app's
	// Copy diagnostics (GET /v1/doctor); nil answers that there are none.
	Doctor func(ctx context.Context) []doctor.Check
	// Routes to boxes (boxroutes.go): SSH is the ssh program SSH routes run
	// ("ssh" on the PATH), SSHFinder finds the SSH agent it uses when this
	// process has none (nil: this computer's), SSHHosts lists the hosts
	// ~/.ssh/config names (nil reads it), and RouteTiming how quickly
	// routes are judged (zero: wire.DefaultRouteTiming).
	SSH         string
	SSHFinder   *sshsetup.Finder
	SSHHosts    func() []string
	RouteTiming wire.RouteTiming
}

// Networks is the set of other tailnets the agent can dial through.
type Networks interface {
	Dial(ctx context.Context, name, addr string) (net.Conn, error)
	Login(ctx context.Context, name string, onURL func(string)) (network.Info, error)
	List(ctx context.Context) []network.Info
	Peers(ctx context.Context, name string) ([]network.Peer, error)
	// Status is a network's view of its tailnet, for how it reaches a box.
	Status(ctx context.Context, name string) (*ipnstate.Status, error)
	Close()
}

func (c *Config) defaults() {
	if c.Socket == "" {
		c.Socket = filepath.Join(c.Dir, "agent.sock")
	}
	if c.ProxyAddrs == nil {
		port := strconv.Itoa(DefaultProxyPort)
		c.ProxyAddrs = []string{net.JoinHostPort("127.0.0.1", port), net.JoinHostPort("::1", port)}
	}
	if c.UIAddr == "" {
		c.UIAddr = net.JoinHostPort("127.0.0.1", strconv.Itoa(DefaultUIPort))
	}
	if c.UserDir == "" {
		if dir, err := statefile.UserDir(); err == nil {
			c.UserDir = dir
		} else {
			c.UserDir = filepath.Join(c.Dir, "user")
		}
	}
	if c.HealthInterval == 0 {
		c.HealthInterval = defaultHealthInterval
	}
	if c.PingTimeout == 0 {
		c.PingTimeout = defaultPingTimeout
	}
	if c.TailscaleStatus == nil {
		c.TailscaleStatus = network.SystemStatus
	}
	if c.Log == nil {
		c.Log = log.New(os.Stderr, "", log.LstdFlags)
	}
	if c.Networks == nil {
		c.Networks = &network.Manager{Dir: filepath.Join(c.Dir, "networks"), Log: c.Log}
	}
	if c.Now == nil {
		// Round(0) drops the monotonic reading: on macOS the monotonic clock
		// stops during sleep, so only wall-clock time reveals that it happened.
		c.Now = func() time.Time { return time.Now().Round(0) }
	}
}

type BoxStatus struct {
	Name        string    `json:"name"`
	Address     string    `json:"address"`
	Network     string    `json:"network,omitempty"`
	Fingerprint string    `json:"fingerprint"`
	State       string    `json:"state"`
	Error       string    `json:"error,omitempty"`
	LatencyMs   int64     `json:"latency_ms,omitempty"`
	Since       time.Time `json:"since"`
	// Local marks a box on this computer itself (Use this Mac).
	Local bool `json:"local,omitempty"`
	// RetryAt is when the agent next tries a box that isn't online, and
	// Attempts how many tries in a row have failed: the app counts down to
	// it ("Reconnecting to devl… next try in 6s").
	RetryAt  *time.Time `json:"retry_at,omitempty"`
	Attempts int        `json:"attempts,omitempty"`
	// Link is how well the laptop reaches it (link.go): slow or not, the
	// latency's recent max and jitter, and whether Tailscale relays it.
	Link Link `json:"link,omitzero"`
	// Route is the ID of the route new requests to the box take, and Routes
	// every way the agent knows to reach it (boxroutes.go).
	Route  string        `json:"route,omitempty"`
	Routes []RouteStatus `json:"routes,omitempty"`
}

type ForwardStatus struct {
	Forward
	State string `json:"state"`
	Error string `json:"error,omitempty"`
}

type ProxyStatus struct {
	Port int `json:"port"`
	// URLPort is the port URLs should name: 80 once the port 80 redirect is
	// installed, so http://3000.devl.localhost/ needs no port at all.
	URLPort int    `json:"url_port"`
	Error   string `json:"error,omitempty"`
}

type Status struct {
	Boxes    []BoxStatus     `json:"boxes"`
	Forwards []ForwardStatus `json:"forwards"`
	Routes   []Route         `json:"routes"`
	Proxy    ProxyStatus     `json:"proxy"`
	// TeamSuggestions are orgs of the person's projects that publish a team
	// setup they haven't accepted (teamsuggest.go).
	TeamSuggestions []TeamSuggestion `json:"team_suggestions"`
}

type Agent struct {
	seqs     *seqStore
	cfg      Config
	hooks    *hooks.Runner
	id       *identity.Identity
	boxes    *trust.Store
	forwards forwardStore
	routes   routeStore
	bus      events.Bus
	proxy    *proxy.Proxy
	proxySt  ProxyStatus
	queue    *promptQueue
	local    localBox
	// imageGenBusy lets one chat background generate at a time.
	imageGenBusy sync.Mutex
	// outdated remembers which boxes run an older berthd (outdated.go).
	outdated outdatedCache
	// selfNames are the boxes' own names, which the proxy accepts too
	// (aliases.go).
	selfNames selfNames
	// startedAs is the program this agent runs, and work the long work
	// under way that a restart waits for (restart.go).
	startedAs startedAs
	work      workSet
	// suggest is what team suggestions know (teamsuggest.go).
	suggest teamSuggest

	// ctx lives as long as the agent; forwards added through the API run under
	// it rather than under the request that created them.
	ctx context.Context

	// tsMu guards this computer's Tailscale status, read at most every
	// couple of minutes (link.go).
	tsMu     sync.Mutex
	tsAt     time.Time
	tsStatus *ipnstate.Status
	tsErr    error
	// held keeps a terminal's typing that a route going down may have
	// lost, for its next attach (attachkeys.go); hosts the hosts
	// ~/.ssh/config names, read now and then (boxroutes.go).
	held    heldKeys
	hostsMu sync.Mutex
	hostsAt time.Time
	hosts   []string
	// boxRoutes keeps box-routes.json between changes (boxroutes.go).
	boxRoutes statefile.Cache[map[string]BoxRoutes]

	mu      sync.Mutex
	svc     map[string]serviceCache
	clients map[string]*boxState
	running map[string]*runningForward
	wake    chan struct{}
}

type boxState struct {
	peer   trust.Peer
	client *wire.Client
	status BoxStatus
	// stopRelay ends the goroutine relaying this box's events, if running.
	stopRelay context.CancelFunc
	// A box that isn't online is tried again with backoff (backoff.go):
	// fails in a row, the next try (monotonic time) and its timer; checking
	// while a check is under way, so a slow one isn't doubled.
	fails    int
	retryAt  time.Time
	retry    *time.Timer
	checking bool
	// back wakes the event relay waiting out its backoff when the box
	// answers again.
	back chan struct{}
	// samples are the latest checks' latencies, and pathAt when the agent
	// last asked Tailscale how it reaches the box (learning: asking now).
	samples  []time.Duration
	pathAt   time.Time
	learning bool
	// routeKey is the routes the client was given, and ssh the SSH route's
	// dialer, if it has one (boxroutes.go).
	routeKey string
	ssh      *sshroute.Dialer
}

type runningForward struct {
	fwd    Forward
	cancel context.CancelFunc
	state  string
	err    string
}

// ErrAlreadyRunning means another agent owns this state directory.
var ErrAlreadyRunning = errors.New("another berth agent is already running")

// Run serves until ctx is cancelled or a client asks the agent to stop.
func Run(ctx context.Context, cfg Config) error {
	cfg.defaults()
	if len(cfg.Socket) > 100 {
		return fmt.Errorf("agent socket path %s is too long for a Unix socket; set a shorter BERTH_HOME", cfg.Socket)
	}
	unlock, err := lockAgent(cfg.Dir)
	if err != nil {
		return err
	}
	defer unlock()
	id, err := identity.LoadOrCreate(filepath.Join(cfg.Dir, "identity.pem"))
	if err != nil {
		return err
	}
	a := &Agent{
		cfg:      cfg,
		id:       id,
		boxes:    trust.NewStore(filepath.Join(cfg.Dir, "boxes.json")),
		forwards: forwardStore{path: filepath.Join(cfg.Dir, "forwards.json")},
		routes:   newRouteStore(filepath.Join(cfg.Dir, "routes.json")),
		clients:  map[string]*boxState{},
		seqs:     newSeqStore(cfg.Dir),
		running:  map[string]*runningForward{},
		wake:     make(chan struct{}, 1),
	}
	a.startedAs = readStartedAs(cfg.Now())
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	a.ctx = ctx
	a.queue = newPromptQueue(ctx, filepath.Join(cfg.Dir, "queue.json"), agentBoxes{a}, a.publish, cfg.Now, cfg.Log.Printf, cfg.QueueIdleTimeout, cfg.QueueWaitStep)

	// Holding the agent lock means any socket file left here is stale.
	os.Remove(cfg.Socket)
	apiLn, err := net.Listen("unix", cfg.Socket)
	if err != nil {
		return err
	}
	defer os.Remove(cfg.Socket)
	if err := os.Chmod(cfg.Socket, 0o600); err != nil {
		apiLn.Close()
		return err
	}
	a.startProxy(ctx)
	a.sync()
	a.startSavedForwards(ctx)
	go a.healthLoop(ctx)
	go a.routeLoop(ctx)
	go a.keepLocalBoxCurrent(ctx)
	go a.watchTeamUpdates(ctx)
	go a.watchTeamSuggestions(ctx)
	a.hooks = &hooks.Runner{Path: filepath.Join(cfg.UserDir, "hooks.json"), PluginsDir: filepath.Join(cfg.UserDir, "plugins"), Log: cfg.Log}
	go a.hooks.Run(ctx, &a.bus)

	handler := a.api(cancel)
	a.startUI(ctx, handler)
	// BERTH_DEBUG_ADDR: goroutines, open files and profiles, for measuring.
	debugserver.Start(ctx, a.cfg.Log.Printf)
	api := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	stop := context.AfterFunc(ctx, func() { api.Close() })
	defer stop()
	a.publish(Event{Type: EventAgentStarted})
	a.cfg.Log.Printf("berth agent running; API %s, proxy port %d", cfg.Socket, a.proxySt.Port)
	err = api.Serve(apiLn)
	a.shutdown()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// lockAgent makes the agent a singleton per state directory. Losing the race
// is reported to the caller, which exits cleanly so a supervisor does not
// restart it against the winner forever.
func lockAgent(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "agent.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, ErrAlreadyRunning
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}

func (a *Agent) publish(e Event) {
	e.Time = a.cfg.Now()
	a.bus.Publish(e)
}

func (a *Agent) startProxy(ctx context.Context) {
	a.proxy = &proxy.Proxy{
		Dialer: func(box string) (proxy.DialFunc, bool) {
			c, ok := a.client(box)
			if !ok {
				return nil, false
			}
			return c.DialPort, true
		},
		Index:    http.HandlerFunc(a.serveIndex),
		Route:    a.route,
		Worktree: a.worktree,
		BoxAlias: a.boxAlias,
		// Logging a worktree in as a dev user (proxy/login.go, login.go).
		Login: a.login,
		// An artifact's page, for its own origin (proxy/artifact.go): over
		// this laptop's paired channel, so the page never holds a token.
		Artifact: func(ctx context.Context, name, id, version string) (*http.Response, error) {
			c, ok := a.client(name)
			if !ok {
				return nil, fmt.Errorf("no paired box named %s", name)
			}
			return c.DoWithHeader(ctx, http.MethodGet, "/v1/artifacts/"+url.PathEscape(id)+"/v/"+url.PathEscape(version), nil, http.Header{box.OriginHeader: {"proxy"}})
		},
	}
	srv := &http.Server{Handler: a.proxy, ReadHeaderTimeout: 30 * time.Second}
	context.AfterFunc(ctx, func() { srv.Close() })
	var errs []string
	for _, addr := range a.cfg.ProxyAddrs {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		if a.proxySt.Port == 0 {
			a.proxySt.Port = ln.Addr().(*net.TCPAddr).Port
		}
		go srv.Serve(ln)
	}
	// The IPv4 address is the one that must work; IPv6 is best effort.
	if a.proxySt.Port == 0 && len(errs) > 0 {
		a.proxySt.Error = "proxy could not listen: " + errs[0]
		a.cfg.Log.Print(a.proxySt.Error)
	}
}

func (a *Agent) runCtx() context.Context { return a.ctx }

// dialerFor returns how to reach a box on the named network; nil means this
// machine's own network.
func (a *Agent) dialerFor(name string) wire.DialFunc {
	if name == "" {
		return nil
	}
	return func(ctx context.Context, _, addr string) (net.Conn, error) {
		return a.cfg.Networks.Dial(ctx, name, addr)
	}
}

func (a *Agent) client(box string) (*wire.Client, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st, ok := a.clients[box]
	if !ok {
		return nil, false
	}
	return st.client, true
}

// sync brings the set of box clients in line with the trust store, which the
// CLI may have changed by pairing or forgetting a box.
func (a *Agent) sync() {
	peers, err := a.boxes.List()
	if err != nil {
		a.cfg.Log.Printf("reading paired boxes: %v", err)
		return
	}
	settings := a.routeSettings()
	a.mu.Lock()
	defer a.mu.Unlock()
	seen := map[string]bool{}
	for _, p := range peers {
		seen[p.Name] = true
		if st, ok := a.clients[p.Name]; ok && st.peer == p {
			a.applyRoutesLocked(p.Name, st, settings[p.Name].forPeer(p))
			continue
		}
		if st, ok := a.clients[p.Name]; ok {
			st.close()
		}
		a.clients[p.Name] = &boxState{
			peer:   p,
			client: wire.NewClientVia(a.id, p, a.dialerFor(p.Network)),
			back:   make(chan struct{}, 1),
			status: BoxStatus{Name: p.Name, Address: p.Address, Network: p.Network, Fingerprint: p.Fingerprint.String(), State: StateConnecting, Since: a.cfg.Now()},
		}
		a.applyRoutesLocked(p.Name, a.clients[p.Name], settings[p.Name].forPeer(p))
	}
	for name, st := range a.clients {
		if !seen[name] {
			st.close()
			delete(a.clients, name)
		}
	}
}

func (st *boxState) close() {
	if st.stopRelay != nil {
		st.stopRelay()
	}
	if st.retry != nil {
		st.retry.Stop()
	}
	st.client.Reset()
	if st.ssh != nil {
		go st.ssh.Close()
	}
}

// scheduleRetryLocked sets when a box that failed its check is tried next:
// soon at first (a fifth of the health interval), doubling to four fifths
// of it, with jitter (±20%, so at most the interval itself), so a short
// blip reconnects in seconds and a box that stays away is tried at least
// as often as before. a.mu is held.
func (a *Agent) scheduleRetryLocked(name string, st *boxState) {
	st.fails++
	d := backoff(st.fails, a.cfg.HealthInterval/5, a.cfg.HealthInterval*4/5)
	st.retryAt = time.Now().Add(d)
	at := a.cfg.Now().Add(d)
	st.status.RetryAt, st.status.Attempts = &at, st.fails
	if st.status.State == StateOnline {
		// A slow box is checked again soon, but isn't reconnecting: the
		// app counts down only for a box that's away.
		st.status.RetryAt, st.status.Attempts = nil, 0
	}
	if st.retry != nil {
		st.retry.Stop()
	}
	st.retry = time.AfterFunc(d, func() {
		a.mu.Lock()
		current := a.clients[name] == st
		a.mu.Unlock()
		if current && a.ctx.Err() == nil {
			a.check(a.ctx, name, st)
		}
	})
}

// relay republishes a box's events on the agent's bus under the laptop's name
// for the box, so hooks and the app see one stream for every box. The stream
// reconnects until the box is removed.
func (a *Agent) relay(ctx context.Context, name string, c *wire.Client, back <-chan struct{}) {
	bc := box.NewClient(c)
	// The agent's own stream doesn't make the box count as in use.
	ctx = wire.Background(ctx)
	// The last event seen: a reconnect (after sleep, say) asks the box's
	// journal for what it missed, up to the box's replay limit. It is kept
	// on disk, so a restart of the agent catches up too.
	fp := c.Box().Fingerprint.String()
	last := a.seqs.get(name, fp)
	save := time.NewTicker(5 * time.Second)
	defer save.Stop()
	defer a.seqs.save()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-save.C:
				a.seqs.save()
			}
		}
	}()
	attempt := 0
	for ctx.Err() == nil {
		first := true
		got := false
		bc.EventsSince(ctx, last, func(e events.Event) {
			got = true
			if e.Seq > 0 {
				if e.Seq <= last && !(first && last > 0) {
					return
				}
				// A first event at or below the saved Seq means the box's
				// journal started over (a reinstall): take it from there.
				last = e.Seq
				a.seqs.set(name, fp, last)
			}
			first = false
			e.Box = name
			a.bus.Publish(e)
		})
		// The stream ended: the box went away, or the link dropped. Try
		// again after a short wait, longer each time nothing came through,
		// with jitter, from the last event seen (EventsSince replays the
		// rest from the box's journal).
		if got {
			attempt = 0
		}
		attempt++
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff(attempt, relayRetryBase, relayRetryMax)):
		case <-back:
		}
	}
}

func (a *Agent) healthLoop(ctx context.Context) {
	interval := a.cfg.HealthInterval
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	last := a.cfg.Now()
	a.checkAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-a.wake:
		}
		now := a.cfg.Now()
		woke := now.Sub(last) > interval+wakeSkew
		if woke {
			a.cfg.Log.Printf("clock jumped %s; the laptop slept, reconnecting every box", now.Sub(last).Round(time.Second))
			a.resetAll()
		}
		last = now
		// Boxes that are away are tried on their own backoff, except right
		// after a wake, when every box is tried at once.
		a.checkBoxes(ctx, woke, "")
	}
}

// slowAnswer is how long a request to a box may wait for its answer to
// begin before the box is checked, in case it went away. Long enough that a
// relayed link's spikes (2s and more) don't set it off.
const slowAnswer = 10 * time.Second

// away says whether the agent knows a box is offline, how to say so, and
// how long until it tries the box again.
func (a *Agent) away(name string) (string, time.Duration, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st, ok := a.clients[name]
	if !ok || st.status.State != StateOffline {
		return "", 0, false
	}
	retry := time.Until(st.retryAt)
	msg := name + " is offline; Shipyard is reconnecting"
	if retry > 0 {
		msg += fmt.Sprintf(" (next try in %ds)", int(retry.Round(time.Second)/time.Second))
	}
	if st.status.Error != "" {
		msg += ": " + st.status.Error
	}
	return msg, retry, true
}

// checkSoon asks the health loop to run now instead of at its next tick.
func (a *Agent) checkSoon() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *Agent) resetAll() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for name, st := range a.clients {
		st.client.Reset()
		a.proxy.ResetBox(name)
	}
}

func (a *Agent) checkAll(ctx context.Context) { a.checkBoxes(ctx, true, "") }

// checkBoxes checks every box (or only one), now. Unless forced, a box that
// is away waits for its own retry (scheduleRetry) rather than the tick.
func (a *Agent) checkBoxes(ctx context.Context, force bool, only string) {
	a.sync()
	a.retryFailedForwards(ctx)
	a.mu.Lock()
	boxes := make(map[string]*boxState, len(a.clients))
	now := time.Now()
	for name, st := range a.clients {
		if only != "" && name != only {
			continue
		}
		if !force && st.status.State != StateOnline && now.Before(st.retryAt) {
			continue
		}
		boxes[name] = st
	}
	a.mu.Unlock()
	var wg sync.WaitGroup
	for name, st := range boxes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.check(ctx, name, st)
		}()
	}
	wg.Wait()
	// Prompts queued while a box was away go once it answers again.
	a.queue.kickAll()
}

func (a *Agent) check(ctx context.Context, name string, st *boxState) {
	a.mu.Lock()
	if st.checking {
		a.mu.Unlock()
		return
	}
	st.checking = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		st.checking = false
		a.mu.Unlock()
	}()
	a.mu.Lock()
	timeout := a.cfg.PingTimeout
	if st.fails > 0 {
		// Confirming a failed check: give a slow link longer.
		timeout = timeout * 5 / 4
	}
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Over the active route, or the first other one to answer when it
	// stalls (boxroutes.go): latency is the route's that answered.
	_, latency, err := st.client.PingTimed(ctx)
	if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
		return
	}
	a.mu.Lock()
	if a.clients[name] != st {
		a.mu.Unlock()
		return
	}
	prev, wasSlow := st.status.State, st.status.Link.Slow
	step := stepLink(prev, st.fails, latency, timeout, err)
	state := step.State
	if prev != state {
		st.status.Since = a.cfg.Now()
	}
	st.status.State = state
	st.status.Error = ""
	st.status.Link.Slow = step.Slow
	st.status.Link.Reason = ""
	if step.Slow || state != StateOnline {
		st.status.Link.Reason = step.Reason
	}
	if err != nil {
		if state != StateOnline {
			st.status.Error = err.Error()
			st.status.LatencyMs = 0
		}
		a.scheduleRetryLocked(name, st)
	} else {
		st.status.LatencyMs = latency.Milliseconds()
		st.samples, st.status.Link.MaxMs, st.status.Link.JitterMs = noteSample(st.samples, latency)
		st.fails, st.retryAt, st.status.RetryAt, st.status.Attempts = 0, time.Time{}, nil, 0
		if st.retry != nil {
			st.retry.Stop()
			st.retry = nil
		}
	}
	a.mu.Unlock()

	// Every change of state is logged with why, once: not every check.
	from, to := linkLabel(prev, wasSlow), linkLabel(state, step.Slow)
	if from != to {
		a.cfg.Log.Printf("box %s: %s → %s (%s)", name, from, to, step.Reason)
	}
	if err != nil && state != StateOnline {
		// Away: whatever connection we had is suspect, and the next attempt
		// dials fresh. A box that is only slow keeps its connection, so the
		// requests and terminals on it ride the hiccup out.
		st.client.Reset()
		a.proxy.ResetBox(name)
	}
	if state == StateOnline || state == StateOffline {
		a.learnPath(name, st)
	}
	if prev == state {
		if state == StateOnline && wasSlow != step.Slow {
			a.publish(Event{Type: EventBoxLink, Box: name, Data: map[string]any{"slow": step.Slow, "reason": step.Reason}})
		}
		return
	}
	if state == StateOnline {
		a.mu.Lock()
		if st.stopRelay == nil && a.clients[name] == st {
			relayCtx, stop := context.WithCancel(a.ctx)
			st.stopRelay = stop
			go a.relay(relayCtx, name, st.client, st.back)
		}
		a.mu.Unlock()
		go a.learnSelfName(a.ctx, name, st.client)
	}
	switch state {
	case StateOnline:
		select {
		case st.back <- struct{}{}:
		default:
		}
		a.proxy.ResetBox(name)
		a.publish(Event{Type: EventBoxConnected, Box: name})
		a.queue.kick(name)
	case StateUntrusted:
		a.publish(Event{Type: EventBoxUntrusted, Box: name, Error: err.Error()})
	case StateOffline:
		if prev != StateConnecting {
			a.publish(Event{Type: EventBoxDisconnected, Box: name, Error: err.Error()})
		}
	}
}

func (a *Agent) dialer(box string) forward.DialFunc {
	return func(ctx context.Context, port int) (net.Conn, error) {
		c, ok := a.client(box)
		if !ok {
			return nil, fmt.Errorf("box %s is not paired", box)
		}
		return c.DialPort(ctx, port)
	}
}

func (a *Agent) startSavedForwards(ctx context.Context) {
	saved, err := a.forwards.list()
	if err != nil {
		a.cfg.Log.Printf("reading saved forwards: %v", err)
		return
	}
	for _, f := range saved {
		lns, err := forward.Listen(f.Local)
		a.run(ctx, f, lns, err)
	}
}

// run starts f on listeners that are already open, or records why it could
// not start; failed forwards are retried on every health check.
func (a *Agent) run(ctx context.Context, f Forward, lns []net.Listener, listenErr error) {
	rf := &runningForward{fwd: f, state: "listening"}
	if listenErr != nil {
		rf.state, rf.err = "failed", listenErr.Error()
		a.mu.Lock()
		a.running[f.ID] = rf
		a.mu.Unlock()
		a.publish(Event{Type: EventForwardFailed, Box: f.Box, Data: forwardData(f), Error: rf.err})
		return
	}
	fctx, cancel := context.WithCancel(ctx)
	rf.cancel = cancel
	a.mu.Lock()
	if old := a.running[f.ID]; old != nil && old.cancel != nil {
		old.cancel()
	}
	a.running[f.ID] = rf
	a.mu.Unlock()
	for _, ln := range lns {
		go forward.Serve(fctx, ln, f.Remote, a.dialer(f.Box), func(err error) {
			a.cfg.Log.Printf("forward %d → %s:%d: %v", f.Local, f.Box, f.Remote, err)
		})
	}
	a.publish(Event{Type: EventForwardStarted, Box: f.Box, Data: forwardData(f)})
}

func (a *Agent) retryFailedForwards(ctx context.Context) {
	a.mu.Lock()
	var failed []Forward
	for _, rf := range a.running {
		if rf.state == "failed" {
			failed = append(failed, rf.fwd)
		}
	}
	a.mu.Unlock()
	for _, f := range failed {
		if lns, err := forward.Listen(f.Local); err == nil {
			a.run(ctx, f, lns, nil)
		}
	}
}

func (a *Agent) addForward(ctx context.Context, box string, local, remote int, pin string) (Forward, error) {
	if local < 1 || local > 65535 || remote < 1 || remote > 65535 {
		return Forward{}, errors.New("ports must be between 1 and 65535")
	}
	if _, ok := a.client(box); !ok {
		return Forward{}, fmt.Errorf("no paired box named %q", box)
	}
	lns, err := forward.Listen(local)
	if err != nil {
		return Forward{}, err
	}
	f, err := a.forwards.add(Forward{Box: box, Local: local, Remote: remote, Pin: pin})
	if err != nil {
		for _, ln := range lns {
			ln.Close()
		}
		return Forward{}, err
	}
	a.run(ctx, f, lns, nil)
	return f, nil
}

func (a *Agent) removeForward(id string) (Forward, error) {
	f, err := a.forwards.remove(id)
	if err != nil {
		return Forward{}, err
	}
	a.mu.Lock()
	if rf := a.running[id]; rf != nil {
		if rf.cancel != nil {
			rf.cancel()
		}
		delete(a.running, id)
	}
	a.mu.Unlock()
	a.publish(Event{Type: EventForwardRemoved, Box: f.Box, Data: forwardData(f)})
	return f, nil
}

func (a *Agent) status() Status {
	settings := a.routeSettings()
	hosts := a.configHosts()
	suggestions := a.TeamSuggestions()
	a.mu.Lock()
	defer a.mu.Unlock()
	s := Status{Boxes: []BoxStatus{}, Forwards: []ForwardStatus{}, Routes: []Route{}, Proxy: a.proxySt, TeamSuggestions: suggestions}
	if routes, err := a.routes.current(); err == nil && routes != nil {
		s.Routes = routes
	}
	s.Proxy.URLPort = s.Proxy.Port
	if runtime.GOOS == "darwin" && s.Proxy.Port != 0 && pfredirect.Installed(s.Proxy.Port) {
		s.Proxy.URLPort = 80
	}
	for _, st := range a.clients {
		b := st.status
		b.Local = a.isLocal(st.peer)
		b.Route, b.Routes = a.routeStatusLocked(st, settings[b.Name].forPeer(st.peer), hosts)
		markRelayed(&b)
		s.Boxes = append(s.Boxes, b)
	}
	for _, rf := range a.running {
		s.Forwards = append(s.Forwards, ForwardStatus{Forward: rf.fwd, State: rf.state, Error: rf.err})
	}
	sort.Slice(s.Boxes, func(i, j int) bool { return s.Boxes[i].Name < s.Boxes[j].Name })
	sort.Slice(s.Forwards, func(i, j int) bool { return s.Forwards[i].Local < s.Forwards[j].Local })
	return s
}

func (a *Agent) shutdown() {
	defer a.cfg.Networks.Close()
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, rf := range a.running {
		if rf.cancel != nil {
			rf.cancel()
		}
	}
	for _, st := range a.clients {
		st.close()
	}
}
