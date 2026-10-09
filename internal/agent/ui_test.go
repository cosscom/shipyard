package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/terminal"
)

// uiCall makes a request to the agent's app API with the laptop's token.
func uiCall(t *testing.T, a *runningAgent, method, path, token string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, "http://"+a.ui+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

func uiToken(t *testing.T, a *runningAgent) string {
	t.Helper()
	var tok string
	eventually(t, "ui token", func() bool {
		b, err := os.ReadFile(filepath.Join(a.dir, UITokenFile))
		tok = strings.TrimSpace(string(b))
		return err == nil && tok != ""
	})
	return tok
}

func TestTheAppAPINeedsTheTokenAndALoopbackHost(t *testing.T) {
	b := newBox(t)
	a := startAgent(t, b.pairLaptop())
	tok := uiToken(t, a)
	eventually(t, "ui up", func() bool {
		resp, err := http.Get("http://" + a.ui + "/v1/status")
		if err == nil {
			resp.Body.Close()
		}
		return err == nil
	})

	if resp, _ := uiCall(t, a, "GET", "/v1/status", ""); resp.StatusCode != 401 {
		t.Fatalf("no token: %d, want 401", resp.StatusCode)
	}
	if resp, _ := uiCall(t, a, "GET", "/v1/status", "wrong"); resp.StatusCode != 401 {
		t.Fatalf("wrong token: %d, want 401", resp.StatusCode)
	}
	// The token in a query string is for the terminal's WebSocket only
	// (security audit L-6).
	if resp, _ := uiCall(t, a, "GET", "/v1/status?token="+tok, ""); resp.StatusCode != 401 {
		t.Fatalf("query token on a plain route: %d, want 401", resp.StatusCode)
	}
	req, _ := http.NewRequest("GET", "http://"+a.ui+"/v1/status", nil)
	req.Host = "evil.example:1378"
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("rebound host: %d, want 403", resp.StatusCode)
	}
	resp, body := uiCall(t, a, "GET", "/v1/status", tok)
	if resp.StatusCode != 200 || !strings.Contains(body, `"devbox"`) {
		t.Fatalf("status: %d %s", resp.StatusCode, body)
	}
	if resp, _ := uiCall(t, a, "POST", "/v1/stop", tok); resp.StatusCode != 403 {
		t.Fatalf("the app stopped the agent: %d", resp.StatusCode)
	}
}

func TestTheAppReachesBoxAPIsAndTerminalsThroughTheAgent(t *testing.T) {
	b := newBox(t)
	b.services = []box.Service{{Port: 3000}}
	resized := make(chan [2]int, 1)
	b.server.Handle("POST /v1/sessions/{name}/attach", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		rc.EnableFullDuplex()
		w.WriteHeader(http.StatusOK)
		rc.Flush()
		w.Write([]byte("welcome " + r.PathValue("name") + "\r\n"))
		rc.Flush()
		terminal.ReadFrames(r.Body,
			func(p []byte) error { w.Write(p); return rc.Flush() },
			func(c, rr int) { resized <- [2]int{c, rr} })
	}))
	a := startAgent(t, b.pairLaptop())
	tok := uiToken(t, a)
	eventually(t, "box online", func() bool { return stateOf(t, a) == StateOnline })

	resp, body := uiCall(t, a, "GET", "/v1/boxes/devbox/api/services", tok)
	if resp.StatusCode != 200 || !strings.Contains(body, `"port":3000`) {
		t.Fatalf("passthrough: %d %s", resp.StatusCode, body)
	}
	// A turn ID's "#" reaches the box as part of the path, not a fragment.
	b.server.Handle("GET /v1/turns/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"` + r.PathValue("id") + `"}`))
	}))
	if resp, body := uiCall(t, a, "GET", "/v1/boxes/devbox/api/turns/fix%232", tok); resp.StatusCode != 200 || !strings.Contains(body, `"id":"fix#2"`) {
		t.Fatalf("turn with #: %d %s", resp.StatusCode, body)
	}
	// A File tab's save names the version it replaces: the agent passes
	// If-Match on, and the box's 412 (with the file now) comes back.
	b.server.Handle("PUT /v1/locations/{name}/worktrees/{worktree}/file", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPreconditionFailed)
		w.Write([]byte(`{"code":"file_changed","if_match":"` + r.Header.Get("If-Match") + `","if_none":"` + r.Header.Get("If-None-Match") + `"}`))
	}))
	req, _ := http.NewRequest("PUT", "http://"+a.ui+"/v1/boxes/devbox/api/locations/shop/worktrees/fix/file?path=a.ts", strings.NewReader(`{"content":"x"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", "sha256-abc")
	req.Header.Set("If-None-Match", "*")
	fresp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	fbody, _ := io.ReadAll(fresp.Body)
	fresp.Body.Close()
	if fresp.StatusCode != 412 || !strings.Contains(string(fbody), `"if_match":"sha256-abc"`) || !strings.Contains(string(fbody), `"if_none":"*"`) {
		t.Fatalf("file save: %d %s", fresp.StatusCode, fbody)
	}
	if resp, _ := uiCall(t, a, "GET", "/v1/boxes/nobox/api/services", tok); resp.StatusCode != 404 {
		t.Fatalf("unknown box: %d, want 404", resp.StatusCode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws://"+a.ui+"/v1/boxes/devbox/sessions/fix/attach?cols=80&rows=24&token="+tok, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	var screen strings.Builder
	readUntil := func(want string) {
		t.Helper()
		for !strings.Contains(screen.String(), want) {
			_, msg, err := ws.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %q, screen %q: %v", want, screen.String(), err)
			}
			screen.Write(msg)
		}
	}
	readUntil("welcome fix")
	ws.Write(ctx, websocket.MessageBinary, []byte("typed-in-the-app"))
	readUntil("typed-in-the-app")
	ws.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":132,"rows":43}`))
	select {
	case got := <-resized:
		if got != [2]int{132, 43} {
			t.Fatalf("resize = %v", got)
		}
	case <-ctx.Done():
		t.Fatal("the resize never reached the box")
	}
}

func TestTheAppReadsThemesTemplatesAndPluginsButNothingOutsideThem(t *testing.T) {
	b := newBox(t)
	a := startAgent(t, b.pairLaptop())
	tok := uiToken(t, a)
	user := filepath.Join(a.dir, "user")
	write := func(rel, content string) {
		p := filepath.Join(user, rel)
		os.MkdirAll(filepath.Dir(p), 0o700)
		os.WriteFile(p, []byte(content), 0o600)
	}
	write("themes/ocean.json", `{"name":"Ocean","appearance":"dark"}`)
	write("themes/broken.json", `{not json`)
	write("templates/bugfix.json", `{"id":"bugfix","agent":"claude","prompt":"Fix {{issue}}"}`)
	write("plugins/hello/berth-plugin.json", `{"name":"Hello","version":"1.0.0","main":"dist/index.js","themes":["themes/sun.json"],"hooks":[{"on":"agent.finished","run":"true"}]}`)
	write("plugins/hello/dist/index.js", `export default function activate() {}`)
	write("plugins/hello/themes/sun.json", `{"id":"sun","name":"Sun","appearance":"light"}`)
	write("secret.txt", "do not serve")
	if h, err := hooks.PluginHash(filepath.Join(user, "plugins", "hello")); err != nil {
		t.Fatal(err)
	} else if err := hooks.AllowPlugin(filepath.Join(user, "plugins", "hello"), h); err != nil {
		t.Fatal(err)
	}
	eventually(t, "ui up", func() bool {
		resp, err := http.Get("http://" + a.ui + "/v1/status")
		if err == nil {
			resp.Body.Close()
		}
		return err == nil
	})

	_, body := uiCall(t, a, "GET", "/v1/themes", tok)
	var themes []map[string]any
	json.Unmarshal([]byte(body), &themes)
	ids := map[string]bool{}
	for _, th := range themes {
		ids[th["id"].(string)] = true
	}
	if len(themes) != 2 || !ids["ocean"] || !ids["sun"] {
		t.Fatalf("themes = %s", body)
	}
	if _, body := uiCall(t, a, "GET", "/v1/templates", tok); !strings.Contains(body, `"bugfix"`) {
		t.Fatalf("templates = %s", body)
	}
	_, body = uiCall(t, a, "GET", "/v1/plugins", tok)
	var plugins []PluginInfo
	json.Unmarshal([]byte(body), &plugins)
	if len(plugins) != 1 || plugins[0].Entry != "/v1/plugins/hello/dist/index.js" || plugins[0].Hooks != 1 || !plugins[0].Enabled || plugins[0].Allowed == "" {
		t.Fatalf("plugins = %s", body)
	}
	resp, body := uiCall(t, a, "GET", plugins[0].Entry, tok)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/javascript") || !strings.Contains(body, "activate") {
		t.Fatalf("entry: %d %s %s", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	for _, escape := range []string{"/v1/plugins/hello/../../secret.txt", "/v1/plugins/hello/%2e%2e/%2e%2e/secret.txt", "/v1/plugins/..%2fsecret.txt/x"} {
		if resp, body := uiCall(t, a, "GET", escape, tok); resp.StatusCode == 200 || strings.Contains(body, "do not serve") {
			t.Fatalf("%s escaped the plugin folder: %d %s", escape, resp.StatusCode, body)
		}
	}
}

func TestTheAppHearsEventsAsServerSentEvents(t *testing.T) {
	b := newBox(t)
	a := startAgent(t, b.pairLaptop())
	tok := uiToken(t, a)
	eventually(t, "box online", func() bool { return stateOf(t, a) == StateOnline })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://"+a.ui+"/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	lines := make(chan string, 64)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	for {
		b.bus.Publish(events.Event{Type: "agent.waiting", Data: map[string]any{"path": "/w/fix"}})
		select {
		case l := <-lines:
			if data, ok := strings.CutPrefix(l, "data: "); ok {
				var e Event
				if json.Unmarshal([]byte(data), &e) != nil || e.Type != "agent.waiting" || e.Box != "devbox" {
					t.Fatalf("event %s", data)
				}
				return
			}
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("no event arrived")
		}
	}
}

// The app's every call carries its token, so the webview asks before each
// one (a CORS preflight). It may keep that answer for ten minutes, so a
// poll is one request rather than two.
func TestTheAppsPreflightIsKeptForTenMinutes(t *testing.T) {
	h := (&Agent{}).ui("token", "127.0.0.1:1378", http.NotFoundHandler())
	req := httptest.NewRequest("OPTIONS", "http://127.0.0.1:1378/v1/boxes/devl/api/sessions", nil)
	req.Host = "127.0.0.1:1378"
	req.Header.Set("Origin", "tauri://localhost")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "authorization")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "tauri://localhost" {
		t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
	}
	if got := rec.Header().Get("Access-Control-Max-Age"); got != "600" {
		t.Fatalf("Access-Control-Max-Age = %q, want 600", got)
	}
}
