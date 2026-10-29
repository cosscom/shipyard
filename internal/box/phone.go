package box

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/statefile"
)

// Phone access: berthd serves a small web app for a phone on the box's
// tailnet address, so you can see which agents need you and answer them
// while the laptop is asleep or away. It is off until a paired laptop turns
// it on, it answers only on the tailnet address (never every interface),
// and it offers a narrow set of actions: read sessions and their screens,
// type into a session, and press a few keys. Everything else — locations,
// worktrees, hooks, flows, kits, upgrades, shares — is not reachable from a
// phone.

// DefaultPhonePort is where the phone app listens, on the tailnet address.
const DefaultPhonePort = 1379

//go:embed phoneui
var phoneUI embed.FS

// PhoneConfig is what a paired laptop sets, and the phones that asked for
// notifications (phonev2.go).
type PhoneConfig struct {
	Enabled bool   `json:"enabled"`
	Token   string `json:"token,omitempty"`
	// Notify, when set, pushes to an ntfy topic when an agent needs you.
	Notify *PhoneNotify `json:"notify,omitempty"`
	// Push are the Shipyard phone apps that registered for notifications,
	// sent through the push relay.
	Push []PhonePush `json:"push,omitempty"`
	// Relay is the push relay's address, set only by a laptop; empty is
	// DefaultPushRelay.
	Relay string `json:"relay,omitempty"`
}

// PhoneNotify sends a push through ntfy (ntfy.sh or your own server), whose
// app delivers it on iOS and Android. URL is the topic's full URL, e.g.
// https://ntfy.sh/berth-3f9c2a…; a long random topic is the secret.
type PhoneNotify struct {
	URL string `json:"url"`
	// On lists the agent states that notify: waiting (default), finished.
	On []string `json:"on,omitempty"`
}

// PhoneStatus is what a paired laptop sees.
type PhoneStatus struct {
	PhoneConfig
	// URL is where the phone app answers, when enabled and listening.
	URL   string `json:"url,omitempty"`
	Error string `json:"error,omitempty"`
}

// Phone runs the phone listener for a box.
type Phone struct {
	// Path is phone.json in the box's state directory.
	Path string
	// Addr returns the tailnet address to listen on, without a port.
	Addr func() (string, error)
	Port int
	Log  *log.Logger

	mu       sync.Mutex
	srv      *http.Server
	url      string
	err      string
	failures map[string][]time.Time
	// streams counts the phones' open event streams (phonev2.go).
	streams int
	// edit serializes changes to phone.json: a laptop's, a phone
	// registering, and a relay saying a phone is gone.
	edit sync.Mutex
	// where remembers the session working in a folder, briefly, so an
	// agent event reaches every phone's stream with one lookup.
	where map[string]sessionAt
}

func (p *Phone) load() PhoneConfig {
	var c PhoneConfig
	if b, err := os.ReadFile(p.Path); err == nil {
		json.Unmarshal(b, &c)
	}
	return c
}

func (p *Phone) save(c PhoneConfig) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return statefile.Write(p.Path, b)
}

// update changes phone.json under the edit lock and returns what it saved.
func (p *Phone) update(fn func(*PhoneConfig) error) (PhoneConfig, error) {
	p.edit.Lock()
	defer p.edit.Unlock()
	c := p.load()
	if err := fn(&c); err != nil {
		return c, err
	}
	return c, p.save(c)
}

func newPhoneToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Status reports the config and where the app answers.
func (p *Phone) Status() PhoneStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.load()
	// A laptop sees which phones get notifications, never their keys.
	push := make([]PhonePush, len(c.Push))
	for i, d := range c.Push {
		d.Key = ""
		push[i] = d
	}
	c.Push = push
	return PhoneStatus{PhoneConfig: c, URL: p.url, Error: p.err}
}

// Apply starts or stops the listener to match the config on disk.
func (p *Phone) Apply(b *Box) {
	c := p.load()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.srv != nil {
		p.srv.Close()
		p.srv, p.url = nil, ""
	}
	p.err = ""
	if !c.Enabled || c.Token == "" {
		return
	}
	host, err := p.Addr()
	if err != nil {
		p.err = err.Error()
		return
	}
	port := p.Port
	if port == 0 {
		port = DefaultPhonePort
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		p.err = err.Error()
		return
	}
	srv := &http.Server{Handler: p.Handler(b, addr), ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	p.srv, p.url = srv, "http://"+addr+"/"
	if p.Log != nil {
		p.Log.Printf("phone access on %s", p.url)
	}
}

// Run applies the config now, and notifies on agent events until ctx ends.
func (p *Phone) Run(ctx context.Context, b *Box) {
	p.Apply(b)
	defer func() {
		p.mu.Lock()
		if p.srv != nil {
			p.srv.Close()
		}
		p.mu.Unlock()
	}()
	cur := b.Events.SubscribeFrom(-1).Named("phone")
	defer cur.Close()
	for {
		e, err := cur.Next(ctx)
		if err != nil {
			return
		}
		// A spooled or replayed state from long ago is not news.
		if time.Since(e.Time) > 10*time.Minute {
			continue
		}
		p.notify(ctx, b, e)
	}
}

// tailnetHosts says whether host (no port) is one the phone may use to reach
// the box: its tailnet address, a MagicDNS name, or the box's own name. Any
// other Host is a rebinding attempt.
func tailnetHost(host, listenHost string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == strings.ToLower(listenHost) {
		return true
	}
	if strings.HasSuffix(host, ".ts.net") {
		return true
	}
	if name, err := os.Hostname(); err == nil {
		short := strings.ToLower(strings.SplitN(name, ".", 2)[0])
		if host == short {
			return true
		}
	}
	return false
}

// phoneOrigin allows the app on another box of yours to read this one, so
// one phone page shows every box: tailnet addresses and MagicDNS names only.
func phoneOrigin(origin string) bool {
	rest, ok := strings.CutPrefix(origin, "http://")
	if !ok {
		rest, ok = strings.CutPrefix(origin, "https://")
	}
	if !ok {
		return false
	}
	host, _, err := net.SplitHostPort(rest)
	if err != nil {
		host = rest
	}
	if strings.HasSuffix(strings.ToLower(host), ".ts.net") {
		return true
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return carrierGradeNAT.Contains(ip.Unmap())
	}
	return false
}

var carrierGradeNAT = netip.MustParsePrefix("100.64.0.0/10")

const (
	maxPhoneFailures = 10
	phoneLockout     = time.Minute
)

// limited reports whether ip has failed authentication too often lately,
// and records a failure when fail is set.
func (p *Phone) limited(ip string, fail bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failures == nil {
		p.failures = map[string][]time.Time{}
	}
	cut := time.Now().Add(-phoneLockout)
	kept := p.failures[ip][:0]
	for _, t := range p.failures[ip] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if fail {
		kept = append(kept, time.Now())
	}
	p.failures[ip] = kept
	return len(kept) >= maxPhoneFailures
}

// Handler is the phone app and its API. listenAddr is host:port.
func (p *Phone) Handler(b *Box, listenAddr string) http.Handler {
	listenHost, port, _ := net.SplitHostPort(listenAddr)
	static, _ := fs.Sub(phoneUI, "phoneui")
	files := http.FileServer(http.FS(static))

	api := http.NewServeMux()
	api.HandleFunc("GET /phone/v1/info", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"box": b.Name, "version": 2, "capabilities": phoneCapabilities})
	})
	api.HandleFunc("GET /phone/v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		all, err := b.Sessions.List(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// Each session with its worktree's display name, which the phone
		// shows in place of the worktree's own (worktreetitles.go).
		titles := b.Locations.TitlesByPath()
		type phoneSession struct {
			Session
			WorktreeTitle string `json:"worktree_title,omitempty"`
		}
		out := []phoneSession{}
		for _, s := range b.enrich(r.Context(), all) {
			out = append(out, phoneSession{Session: s, WorktreeTitle: titles[s.Dir]})
		}
		writeJSON(w, out)
	})
	api.HandleFunc("GET /phone/v1/sessions/{name}/screen", func(w http.ResponseWriter, r *http.Request) {
		history, _ := strconv.Atoi(r.URL.Query().Get("history"))
		text, err := b.Sessions.Screen(r.Context(), r.PathValue("name"), min(max(history, 0), 2000))
		if err != nil {
			writeError(w, statusFor(err), err.Error())
			return
		}
		writeJSON(w, map[string]string{"screen": text})
	})
	api.HandleFunc("POST /phone/v1/sessions/{name}/send", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Text  string `json:"text"`
			Enter *bool  `json:"enter"`
		}
		if err := decodeLimit(r, &req, maxPromptBody); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		name := r.PathValue("name")
		if err := b.before(r, "session.send", map[string]any{"name": name, "from": "phone"}); err != nil {
			writeError(w, statusFor(err), err.Error())
			return
		}
		if err := b.sendText(r.Context(), name, req.Text, req.Enter == nil || *req.Enter); err != nil {
			writeError(w, statusFor(err), err.Error())
			return
		}
		data := map[string]any{"name": name, "from": "phone"}
		if b.Turns != nil {
			// The phone may answer an agent's question: that is not a turn.
			if st, ok := b.Turns.State(name); ok && st.State == "waiting" && !st.SoftWait {
				data["answer"], data["turn"] = true, st.Turn
			}
		}
		b.Events.Publish(events.Event{Type: "session.sent", Box: b.Name, Origin: "phone", Data: data})
		if data["answer"] == nil && (req.Enter == nil || *req.Enter) {
			b.nameAfter(r.Context(), name, adapters.Title(req.Text))
		}
		writeJSON(w, map[string]bool{"sent": true})
	})
	api.HandleFunc("POST /phone/v1/sessions/{name}/keys", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Key string `json:"key"`
		}
		if err := decode(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		key, ok := phoneKeys[req.Key]
		if !ok {
			writeError(w, http.StatusBadRequest, "that key is not available from a phone")
			return
		}
		name := r.PathValue("name")
		if _, err := b.Sessions.Get(r.Context(), name); err != nil {
			writeError(w, statusFor(err), err.Error())
			return
		}
		// A key answers an agent as surely as typed text does, so the same
		// gate decides.
		if err := b.before(r, "session.send", map[string]any{"name": name, "from": "phone", "key": req.Key}); err != nil {
			writeError(w, statusFor(err), err.Error())
			return
		}
		if out, err := b.Sessions.tmux(r.Context(), "send-keys", "-t", "="+name+":", key); err != nil {
			err = tmuxSendError("send-keys", out, err)
			writeError(w, statusFor(err), err.Error())
			return
		}
		writeJSON(w, map[string]bool{"sent": true})
	})
	// The conversation, live events, notifications and stopping an agent:
	// the phone app's (phonev2.go).
	p.mountV2(api, b)

	// Runs, in the phone's "answer things" scope: see what runs and what
	// waits for you, decide a gate, cancel a run. Starting one is not here.
	api.HandleFunc("GET /phone/v1/runs", func(w http.ResponseWriter, r *http.Request) {
		if b.Runs == nil {
			writeJSON(w, []runs.Summary{})
			return
		}
		active := b.Runs.List(runs.Filter{Status: "active", Limit: 30})
		done := b.Runs.List(runs.Filter{Status: "done", Limit: 10})
		writeJSON(w, append(active, done...))
	})
	api.HandleFunc("GET /phone/v1/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if b.Runs == nil {
			writeError(w, http.StatusNotFound, "no runs on this box")
			return
		}
		run, err := b.Runs.Get(r.PathValue("id"))
		if err != nil {
			writeError(w, statusFor(runErr(err)), err.Error())
			return
		}
		// The phone shows a run's outline: steps' outputs, its variables,
		// parameters (prompts) and trigger stay on the box.
		run.Vars, run.Params, run.Trigger, run.Flow = nil, nil, nil, nil
		var strip func([]runs.StepRun)
		strip = func(steps []runs.StepRun) {
			for i := range steps {
				steps[i].Output = firstLineOf(steps[i].Output)
				strip(steps[i].Children)
			}
		}
		strip(run.Steps)
		writeJSON(w, run)
	})
	api.HandleFunc("POST /phone/v1/runs/{id}/gates/{step}/decide", func(w http.ResponseWriter, r *http.Request) {
		if b.Runs == nil {
			writeError(w, http.StatusNotFound, "no runs on this box")
			return
		}
		var req GateDecision
		if err := decode(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := b.decide(r, b.Runs, r.PathValue("id"), r.PathValue("step"), req, "phone", w); err != nil {
			writeError(w, statusFor(err), err.Error())
		}
	})
	api.HandleFunc("POST /phone/v1/runs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if b.Runs == nil {
			writeError(w, http.StatusNotFound, "no runs on this box")
			return
		}
		if err := b.cancelRun(w, r); err != nil {
			writeError(w, statusFor(err), err.Error())
		}
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		// The Host must name this box: a page elsewhere cannot rebind its own
		// name to the tailnet address and talk to it.
		host, hport, err := net.SplitHostPort(r.Host)
		if err != nil || hport != port || !tailnetHost(host, listenHost) {
			writeError(w, http.StatusForbidden, "unexpected host")
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/phone/v1/") {
			// The app itself holds no secrets; it is served to anyone who can
			// reach the address, and asks for the token.
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				writeError(w, http.StatusMethodNotAllowed, "method not allowed")
				return
			}
			h.Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' http: https:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'")
			files.ServeHTTP(w, r)
			return
		}
		h.Set("Cache-Control", "no-store")
		if o := r.Header.Get("Origin"); o != "" && phoneOrigin(o) {
			h.Set("Access-Control-Allow-Origin", o)
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE")
			h.Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if p.limited(ip, false) {
			writeError(w, http.StatusTooManyRequests, "too many wrong tokens; try again in a minute")
			return
		}
		want := p.load().Token
		got, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if want == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			p.limited(ip, true)
			writeError(w, http.StatusUnauthorized, "missing or wrong phone token; pair this phone again from Shipyard's settings")
			return
		}
		api.ServeHTTP(w, r)
	})
}

// phoneKeys are the keys a phone may press: answering an agent's question
// and interrupting it, nothing that could run a new command by itself.
var phoneKeys = map[string]string{
	"enter": "Enter", "escape": "Escape", "interrupt": "C-c", "up": "Up", "down": "Down", "tab": "Tab",
	"1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
	"y": "y", "n": "n",
}

// phoneNotice is what a phone is told about an event: never what the agent
// wrote, only who needs you and where.
type phoneNotice struct {
	// State is waiting or finished.
	State string
	Title string
	// Where is "location/worktree on box".
	Where   string
	Session string
	Run     string
}

// noticeStates are the events a phone hears of, and the state each is.
var noticeStates = map[string]string{"agent.waiting": "waiting", "agent.finished": "finished", "run.gate": "waiting"}

// notice is the notice an event makes, if it makes one.
func (p *Phone) notice(ctx context.Context, b *Box, e events.Event) (phoneNotice, bool) {
	state := noticeStates[e.Type]
	if state == "" {
		return phoneNotice{}, false
	}
	where := ""
	session := ""
	if path, _ := e.Data["path"].(string); path != "" {
		if loc, wt, ok := b.worktreeAt(ctx, path); ok {
			where = loc.Name + "/" + wt.Name
		}
		session = b.sessionIn(ctx, path)
	}
	if named, _ := e.Data["session"].(string); named != "" {
		session = named
	}
	if where == "" {
		where = "an agent"
	}
	agent, _ := e.Data["agent"].(string)
	title := strings.TrimSpace(agentLabel(agent) + " needs you")
	if state == "finished" {
		title = strings.TrimSpace(agentLabel(agent) + " finished")
	}
	run, _ := e.Data["run"].(string)
	if e.Type == "run.gate" {
		gate, _ := e.Data["gate_title"].(string)
		title = "Run needs you: " + gate
		session = ""
	}
	return phoneNotice{State: state, Title: title, Where: where + " on " + b.Name, Session: session, Run: run}, true
}

// wants says whether a phone asked to hear of state: waiting unless it
// said otherwise.
func wants(on []string, state string) bool {
	if len(on) == 0 {
		on = []string{"waiting"}
	}
	for _, s := range on {
		if s == state {
			return true
		}
	}
	return false
}

// notify tells ntfy and the registered phone apps of an agent that needs
// you, as each asked, all at once.
func (p *Phone) notify(ctx context.Context, b *Box, e events.Event) {
	state := noticeStates[e.Type]
	if state == "" {
		return
	}
	c := p.load()
	ntfy := c.Notify != nil && c.Notify.URL != "" && wants(c.Notify.On, state)
	var devices []PhonePush
	for _, d := range c.Push {
		if wants(d.On, state) {
			devices = append(devices, d)
		}
	}
	if !ntfy && len(devices) == 0 {
		return
	}
	n, ok := p.notice(ctx, b, e)
	if !ok {
		return
	}
	var wg sync.WaitGroup
	if ntfy {
		wg.Go(func() { p.deliverNtfy(ctx, b, n, c.Notify.URL) })
	}
	if len(devices) > 0 {
		wg.Go(func() { p.deliverPush(ctx, b, n, firstNonEmpty(c.Relay, DefaultPushRelay), devices) })
	}
	wg.Wait()
}

// deliverNtfy posts a notice to an ntfy topic.
func (p *Phone) deliverNtfy(ctx context.Context, b *Box, n phoneNotice, topic string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, topic, bytes.NewBufferString(n.Where))
	if err != nil {
		return
	}
	req.Header.Set("Title", n.Title)
	req.Header.Set("Tags", map[string]string{"waiting": "bell", "finished": "white_check_mark"}[n.State])
	if n.State == "waiting" {
		req.Header.Set("Priority", "high")
	}
	p.mu.Lock()
	url := p.url
	p.mu.Unlock()
	if url != "" && n.Session != "" {
		req.Header.Set("Click", url+"#s="+n.Session)
	} else if url != "" && n.Run != "" {
		req.Header.Set("Click", url+"#r="+n.Run)
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// Public addresses and the tailnet (a self-hosted ntfy usually lives
	// there); anything else on the box's own networks only if its owner
	// allows it in network.json.
	policy := b.outboundPolicy()
	policy.tailnet = true
	resp, err := policy.client(10 * time.Second).Do(req.WithContext(cctx))
	if err != nil {
		if p.Log != nil {
			p.Log.Printf("phone notify: %v", err)
		}
		return
	}
	resp.Body.Close()
}

func agentLabel(id string) string {
	for _, p := range builtinAgents {
		if p.ID == id {
			return p.Name
		}
	}
	if id == "" {
		return "An agent"
	}
	return id
}

// getPhone and putPhone are for paired laptops, over the authenticated box
// API: the token is never shown anywhere else.
func (b *Box) getPhone(w http.ResponseWriter, r *http.Request) error {
	if b.Phone == nil {
		return httpError{http.StatusNotImplemented, "this box cannot serve a phone"}
	}
	writeJSON(w, b.Phone.Status())
	return nil
}

func (b *Box) putPhone(w http.ResponseWriter, r *http.Request) error {
	if b.Phone == nil {
		return httpError{http.StatusNotImplemented, "this box cannot serve a phone"}
	}
	var req struct {
		Enabled *bool        `json:"enabled"`
		Rotate  bool         `json:"rotate"`
		Notify  *PhoneNotify `json:"notify"`
		// ClearNotify turns notifications off.
		ClearNotify bool `json:"clear_notify"`
		// RemovePush stops notifying one phone app, by its id.
		RemovePush string `json:"remove_push"`
		// Relay is the push relay's address; "" goes back to the default.
		Relay *string `json:"relay"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	if req.Notify != nil {
		if u, err := url.Parse(req.Notify.URL); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
			return badRequest("the notification URL must be http or https")
		}
		for _, s := range req.Notify.On {
			if s != "waiting" && s != "finished" {
				return badRequest("notify on waiting or finished")
			}
		}
	}
	if req.Relay != nil && *req.Relay != "" {
		if u, err := url.Parse(*req.Relay); err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return badRequest("the push relay must be an https address")
		}
	}
	if err := b.before(r, "phone.change", map[string]any{}); err != nil {
		return err
	}
	var removed []PhonePush
	c, err := b.Phone.update(func(c *PhoneConfig) error {
		if req.Enabled != nil {
			c.Enabled = *req.Enabled
		}
		if c.Enabled && c.Token == "" || req.Rotate {
			c.Token = newPhoneToken()
		}
		// A new code is what you make when a phone is lost, and off is off:
		// the phones' notifications stop with their access.
		if req.Rotate || !c.Enabled {
			removed, c.Push = c.Push, nil
		}
		if req.RemovePush != "" {
			c.Push = slices.DeleteFunc(c.Push, func(d PhonePush) bool {
				if d.ID == req.RemovePush {
					removed = append(removed, d)
					return true
				}
				return false
			})
		}
		if req.Notify != nil {
			c.Notify = req.Notify
		}
		if req.ClearNotify {
			c.Notify = nil
		}
		if req.Relay != nil {
			c.Relay = *req.Relay
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, d := range removed {
		b.publish(r, "phone.push.removed", map[string]any{"name": d.Name, "platform": d.Platform})
	}
	b.Phone.Apply(b)
	b.publish(r, "phone.changed", map[string]any{"enabled": c.Enabled})
	st := b.Phone.Status()
	if st.Error != "" {
		return errors.New("phone access could not start: " + st.Error)
	}
	writeJSON(w, st)
	return nil
}
