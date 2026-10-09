package agent

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/terminal"
	"github.com/cosscom/shipyard/internal/wire"
)

// DefaultUIPort is where the agent serves the desktop app, on loopback only.
const DefaultUIPort = 1378

// UITokenFile holds the secret the app presents, inside the state directory.
const UITokenFile = "ui-token"

// uiOrigins are the pages allowed to call the UI API from a browser engine:
// the Tauri webview on macOS and Windows, and Vite while developing.
var uiOrigins = map[string]bool{
	"tauri://localhost":       true,
	"http://tauri.localhost":  true,
	"https://tauri.localhost": true,
	"http://localhost:1420":   true,
}

// devOrigin is Vite on the ports the app's developers use side by side.
// The token, not the origin, is what keeps other pages out.
var devOrigin = regexp.MustCompile(`^http://localhost:14[23][0-9]$`)

// UIToken returns the app's token, creating it on first use.
func UIToken(dir string) (string, error) {
	p := filepath.Join(dir, UITokenFile)
	if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
		return strings.TrimSpace(string(b)), nil
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(buf)
	return tok, statefile.Write(p, []byte(tok+"\n"))
}

// startUI serves the app's API until ctx ends. A port someone else holds is
// logged rather than fatal: forwards and URLs matter more than the app.
func (a *Agent) startUI(ctx context.Context, inner http.Handler) {
	addr := a.cfg.UIAddr
	if addr == "off" {
		return
	}
	tok, err := UIToken(a.cfg.Dir)
	if err != nil {
		a.cfg.Log.Printf("app API off: %v", err)
		return
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		a.cfg.Log.Printf("app API off: %v", err)
		return
	}
	srv := &http.Server{Handler: a.ui(tok, ln.Addr().String(), inner), ReadHeaderTimeout: 10 * time.Second}
	context.AfterFunc(ctx, func() { srv.Close() })
	go srv.Serve(ln)
}

// ui is the app's API: the agent's own control routes, an event stream the
// browser can read, box APIs passed through, terminals over WebSocket, and
// the user's themes, templates and plugins.
func (a *Agent) ui(token, hostport string, inner http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/events", a.uiEvents)
	mux.HandleFunc("GET /v1/themes", a.uiList("themes"))
	mux.HandleFunc("GET /v1/templates", a.uiList("templates"))
	mux.HandleFunc("GET /v1/plugins", a.uiPlugins)
	mux.HandleFunc("GET /v1/plugins/{id}/{file...}", a.uiPluginFile)
	mux.HandleFunc("/v1/boxes/{box}/api/{path...}", a.uiBoxAPI)
	mux.HandleFunc("POST /v1/boxes/{box}/attach-local", a.uiAttachLocal)
	mux.HandleFunc("GET /v1/boxes/{box}/sessions/{name}/attach", a.uiAttach)
	a.manageRoutes(mux)
	a.guidedRoutes(mux)
	a.outdatedRoutes(mux)
	a.localBoxRoutes(mux)
	a.joinRoutes(mux)
	mux.HandleFunc("POST /v1/stop", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusForbidden, "the app cannot stop the agent")
	})
	mux.Handle("/", inner)

	_, port, _ := net.SplitHostPort(hostport)
	hosts := map[string]bool{"127.0.0.1:" + port: true, "localhost:" + port: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only loopback names reach the agent, so no website can rebind its
		// own name to 127.0.0.1 and talk to it.
		if !hosts[r.Host] {
			writeError(w, http.StatusForbidden, "unexpected host")
			return
		}
		if o := r.Header.Get("Origin"); uiOrigins[o] || devOrigin.MatchString(o) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", o)
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-Match, If-None-Match")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			// Every call carries the token, so every one is preflighted:
			// without this the webview keeps a preflight for 5s only, and
			// each poll costs two requests and two round trips. 600s is
			// the most WebKit keeps one for.
			h.Set("Access-Control-Max-Age", "600")
			h.Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		got, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		// A browser cannot set headers on a WebSocket, so the terminal's
		// upgrade alone may carry the token in its query. Everywhere else a
		// query token would end up in logs and history, so it is ignored.
		if got == "" && isWebSocketUpgrade(r) {
			got = r.URL.Query().Get("token")
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			writeError(w, http.StatusUnauthorized, "missing or wrong token")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// uiEvents streams events as server-sent events.
func (a *Agent) uiEvents(w http.ResponseWriter, r *http.Request) {
	ch, cancel := a.bus.Subscribe()
	defer cancel()
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	io.WriteString(w, ": berth\n\n")
	rc.Flush()
	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	for {
		var chunk []byte
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			b, err := json.Marshal(e)
			if err != nil {
				continue
			}
			chunk = append(append([]byte("data: "), b...), '\n', '\n')
		case <-keepalive.C:
			chunk = []byte(": keepalive\n\n")
		}
		if _, err := w.Write(chunk); err != nil || rc.Flush() != nil {
			return
		}
	}
}

// uiBoxAPI passes a request to a box's API and streams the answer back, so
// the app reaches every box through the one connection the agent keeps.
// boxBodyLimit is how large a request the app may send a box: 3 MB, above
// the 2 MB a box takes with a prompt (a task, a session, a send), so the
// box is the one to say a prompt is too long; and enough for a pasted file
// on an attachments route (20 MB as raw bytes, or as base64 in JSON from an
// older app).
func boxBodyLimit(target string) int64 {
	path, _, _ := strings.Cut(target, "?")
	if strings.HasSuffix(path, "/attachments") {
		return 28 << 20
	}
	// A File tab's save: up to 2 MB of text, JSON-escaped.
	if strings.HasSuffix(path, "/file") {
		return 9 << 20
	}
	return 3 << 20
}

// boxAPIPath is the box route after /v1/boxes/{box}/api/, still escaped as
// the app sent it: a turn ID's "#" (%23) or a name's "/" (%2F) stays part
// of its segment instead of ending the path.
func boxAPIPath(r *http.Request) string {
	raw := r.URL.EscapedPath()
	const pre = "/v1/boxes/"
	if strings.HasPrefix(raw, pre) {
		if i := strings.Index(raw[len(pre):], "/api/"); i >= 0 {
			return raw[len(pre)+i+len("/api/"):]
		}
	}
	return r.PathValue("path")
}

func (a *Agent) uiBoxAPI(w http.ResponseWriter, r *http.Request) {
	a.sync()
	c, ok := a.client(r.PathValue("box"))
	if !ok {
		writeCoded(w, http.StatusNotFound, "no paired box named "+r.PathValue("box"), "box_unknown")
		return
	}
	// A box the agent knows is away answers at once, rather than after a
	// dial timeout (15s, or longer on a link that drops packets): the app
	// shows it reconnecting instead of a spinner.
	if msg, retry, away := a.away(r.PathValue("box")); away {
		if retry > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(int(retry.Round(time.Second)/time.Second)))
		}
		writeCoded(w, http.StatusServiceUnavailable, msg, "box_unreachable")
		return
	}
	target := "/v1/" + boxAPIPath(r)
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	header := http.Header{box.OriginHeader: {"app"}}
	// A file's write names the version it replaces (box/worktreefiles.go).
	for _, k := range []string{"Content-Type", "If-Match", "If-None-Match"} {
		if v := r.Header.Get(k); v != "" {
			header.Set(k, v)
		}
	}
	var body io.Reader
	if r.ContentLength != 0 {
		body = http.MaxBytesReader(w, r.Body, boxBodyLimit(target))
	}
	a.relayBox(w, r, c, r.Method, target, body, header)
}

// relayBox sends one request to a box and streams its answer back.
func (a *Agent) relayBox(w http.ResponseWriter, r *http.Request, c *wire.Client, method, target string, body io.Reader, header http.Header) {
	// A box slow to answer may have gone: check it now rather than at the
	// next tick, so the app learns it is away in seconds, not half a minute.
	slow := time.AfterFunc(slowAnswer, a.checkSoon)
	resp, err := c.DoWithHeader(r.Context(), method, target, body, header)
	slow.Stop()
	if err != nil {
		a.checkSoon()
		// 503: the request never reached the box, so it is safe to queue
		// or retry. 502: it may have; the box could have acted on it.
		status := http.StatusBadGateway
		if wire.Unsent(err) {
			status = http.StatusServiceUnavailable
		}
		writeCoded(w, status, err.Error(), "box_unreachable")
		return
	}
	defer resp.Body.Close()
	// A route the box doesn't know is answered by Go's own mux in plain
	// text: the box runs an older berthd than the app expects.
	if (resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed) && strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") {
		writeCoded(w, resp.StatusCode, r.PathValue("box")+" runs an older berthd that doesn't have this yet", "box_outdated")
		return
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	rc := http.NewResponseController(w)
	buf := make([]byte, 32<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			rc.Flush()
		}
		if err != nil {
			return
		}
	}
}

// uiAttach bridges a WebSocket to a session's terminal on a box. Binary
// messages are keystrokes, text messages are resizes and the pace the app
// wants output at (termpace.go); the box's output comes back as binary
// messages. Closing either side detaches.
//
// When the route the terminal rides is declared down (boxroutes.go), the
// agent attaches again over the route now active, inside the same
// WebSocket: the box redraws the screen, and the keys that may not have
// reached it (attachkeys.go) go first. Only if no route answers does the
// WebSocket close, for the app to attach again when it can.
func (a *Agent) uiAttach(w http.ResponseWriter, r *http.Request) {
	a.sync()
	c, ok := a.client(r.PathValue("box"))
	if !ok {
		writeError(w, http.StatusNotFound, "no paired box named "+r.PathValue("box"))
		return
	}
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"localhost", "localhost:14[23][0-9]", "tauri.localhost"},
	})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	box, session := r.PathValue("box"), r.PathValue("name")
	// mu guards the stream keys go to, the journal of them, and the size
	// an attach asks for.
	var mu sync.Mutex
	size := [2]int{max(cols, 20), max(rows, 5)}
	open := func() (net.Conn, error) {
		mu.Lock()
		path := "/v1/sessions/" + session + "/attach?cols=" + strconv.Itoa(size[0]) + "&rows=" + strconv.Itoa(size[1])
		mu.Unlock()
		return c.OpenStream(ctx, path, "attach")
	}
	stream, err := open()
	if err != nil {
		ws.Close(websocket.StatusTryAgainLater, truncate(err.Error(), 120))
		return
	}
	defer func() { stream.Close() }()
	// What was typed and heard, for a route going down: keys an earlier
	// attach kept go first.
	keys := &keyJournal{}
	if held := a.held.take(box, session); len(held) > 0 {
		keys.typed(held)
		if err := terminal.WriteData(stream, held); err != nil {
			a.held.put(box, session, held)
			ws.Close(websocket.StatusTryAgainLater, "the box went away")
			return
		}
	}
	out := newPacedOutput()
	reading := make(chan struct{})
	go func() {
		defer close(reading)
		defer cancel()
		for {
			typ, msg, err := ws.Read(ctx)
			if err != nil {
				return
			}
			// A write to a stream that just ended fails; the output side
			// sees it end too and decides what comes next.
			if typ == websocket.MessageText {
				var m struct {
					Type       string `json:"type"`
					Cols, Rows int
					// pace: how long the app is happy to wait for output, in
					// ms, while the terminal is hidden (termpace.go).
					MS int `json:"ms"`
				}
				if json.Unmarshal(msg, &m) == nil {
					switch m.Type {
					case "resize":
						mu.Lock()
						size = [2]int{max(m.Cols, 20), max(m.Rows, 5)}
						to := stream
						mu.Unlock()
						terminal.WriteResize(to, m.Cols, m.Rows)
					case "pace":
						out.setPace(m.MS)
					}
				}
				continue
			}
			mu.Lock()
			if keys.typed(msg) {
				terminal.WriteData(stream, msg)
			}
			mu.Unlock()
		}
	}()
	send := func(b []byte) error { return ws.Write(ctx, websocket.MessageBinary, b) }
	for {
		mu.Lock()
		from, journal := stream, keys
		mu.Unlock()
		go out.read(ctx, heardReader{from, journal})
		err = out.write(ctx, send)
		if err == nil || ctx.Err() != nil {
			return
		}
		state, confirmed := c.RouteState(wire.StreamRoute(from))
		if state != wire.RouteDown {
			ws.Close(websocket.StatusNormalClosure, "session detached")
			return
		}
		// Its route went down: attach again over the one now active.
		journal.seal(confirmed)
		next, err := open()
		if err != nil {
			ws.Close(websocket.StatusTryAgainLater, "Shipyard is reconnecting")
			cancel()
			<-reading
			a.held.put(box, session, journal.unsent())
			return
		}
		mu.Lock()
		stream, keys = next, &keyJournal{}
		if unsent := journal.unsent(); len(unsent) > 0 {
			keys.typed(unsent)
			terminal.WriteData(next, unsent)
		}
		mu.Unlock()
		from.Close()
		out.resume()
	}
}

// heardReader notes each time the box writes to a terminal.
type heardReader struct {
	r    io.Reader
	keys *keyJournal
}

func (h heardReader) Read(b []byte) (int, error) {
	n, err := h.r.Read(b)
	if n > 0 {
		h.keys.output()
	}
	return n, err
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// uiList serves every JSON object in ~/.berth/<kind>/*.json, plus, for
// themes, those plugins ship. A broken file is skipped, not fatal.
func (a *Agent) uiList(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		files, _ := filepath.Glob(filepath.Join(a.cfg.UserDir, kind, "*.json"))
		if kind == "themes" {
			for _, p := range a.plugins() {
				if p.Enabled {
					for _, t := range p.Themes {
						files = append(files, filepath.Join(a.cfg.UserDir, "plugins", p.ID, filepath.Clean("/"+t)))
					}
				}
			}
		}
		out := []json.RawMessage{}
		for _, f := range files {
			b, err := os.ReadFile(f)
			var obj map[string]any
			if err != nil || json.Unmarshal(b, &obj) != nil {
				a.cfg.Log.Printf("skipping %s: not a JSON object", f)
				continue
			}
			if _, ok := obj["id"]; !ok {
				obj["id"] = strings.TrimSuffix(filepath.Base(f), ".json")
			}
			b, _ = json.Marshal(obj)
			out = append(out, b)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// PluginInfo describes an installed plugin to the app.
type PluginInfo struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Version     string   `json:"version,omitempty"`
	Description string   `json:"description,omitempty"`
	Main        string   `json:"main,omitempty"`
	Themes      []string `json:"themes,omitempty"`
	Hooks       int      `json:"hooks"`
	Enabled     bool     `json:"enabled"`
	// Allowed is the hash of the files the user allowed (hooks.PluginHash),
	// which the app checks against what it is about to import.
	Allowed string `json:"allowed,omitempty"`
	// Changed: the plugin was allowed, but has changed since, so it is off
	// until it is reviewed again.
	Changed bool `json:"changed,omitempty"`
	// Entry is the URL the app imports, when the plugin has a main module.
	Entry string `json:"entry,omitempty"`
	Error string `json:"error,omitempty"`
}

func (a *Agent) plugins() []PluginInfo {
	manifests, _ := filepath.Glob(filepath.Join(a.cfg.UserDir, "plugins", "*", hooks.PluginManifest))
	out := []PluginInfo{}
	for _, m := range manifests {
		dir := filepath.Dir(m)
		p := PluginInfo{ID: filepath.Base(dir)}
		var raw struct {
			PluginInfo
			Hooks []json.RawMessage `json:"hooks"`
		}
		if b, err := os.ReadFile(m); err != nil {
			p.Error = err.Error()
		} else if err := json.Unmarshal(b, &raw); err != nil {
			p.Error = hooks.PluginManifest + ": " + err.Error()
		} else {
			p.Name, p.Version, p.Description, p.Main, p.Themes = raw.Name, raw.Version, raw.Description, raw.Main, raw.Themes
			p.Hooks = len(raw.Hooks)
		}
		// The folder name is the ID, so it is always a safe path segment.
		if p.Name == "" {
			p.Name = p.ID
		}
		st := hooks.PluginStatus(dir)
		p.Enabled, p.Allowed, p.Changed = st.Enabled, st.Allowed, st.Changed
		if p.Main != "" {
			p.Entry = "/v1/plugins/" + p.ID + "/" + path.Clean(p.Main)
		}
		out = append(out, p)
	}
	return out
}

func (a *Agent) uiPlugins(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.plugins())
}

// uiPluginFile serves a file from inside a plugin's folder, never above it.
func (a *Agent) uiPluginFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || strings.ContainsAny(id, `/\`) || strings.HasPrefix(id, ".") {
		writeError(w, http.StatusNotFound, "no such plugin")
		return
	}
	root, err := os.OpenRoot(filepath.Join(a.cfg.UserDir, "plugins", id))
	if err != nil {
		writeError(w, http.StatusNotFound, "no such plugin")
		return
	}
	defer root.Close()
	name := path.Clean(r.PathValue("file"))
	f, err := root.Open(name)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) || err != nil {
		writeError(w, http.StatusNotFound, "no such file")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		writeError(w, http.StatusNotFound, "no such file")
		return
	}
	ct := mime.TypeByExtension(path.Ext(name))
	if path.Ext(name) == ".js" || path.Ext(name) == ".mjs" {
		ct = "text/javascript; charset=utf-8"
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func isWebSocketUpgrade(r *http.Request) bool {
	return r.Method == http.MethodGet &&
		strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		headerHasToken(r.Header.Get("Connection"), "upgrade")
}

func headerHasToken(v, token string) bool {
	for _, t := range strings.Split(v, ",") {
		if strings.EqualFold(strings.TrimSpace(t), token) {
			return true
		}
	}
	return false
}
