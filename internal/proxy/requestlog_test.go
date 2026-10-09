package proxy

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// apiServer stands in for a dev server with a page, a script, an API that
// fails, and one that is slow to be given up on.
func apiServer(t *testing.T) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			io.WriteString(w, "<!doctype html><title>shop</title>")
		case "/app.js":
			w.Header().Set("Content-Type", "text/javascript")
			io.WriteString(w, "console.log(1)")
		case "/api/checkout":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, `{"error":"payment provider timed out"}`+strings.Repeat(" ", 2000))
		case "/broken.html":
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, "<h1>not here</h1>")
		}
	}))
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

func TestRequestLogKeepsAPagesRequests(t *testing.T) {
	port := apiServer(t)
	host := strconv.Itoa(port) + ".devl.localhost:1377"
	p := newProxy()

	get(t, p, host, "/", http.Header{"Sec-Fetch-Dest": {"document"}})
	get(t, p, host, "/app.js?v=1&__berth_devtools=1", http.Header{"Sec-Fetch-Dest": {"script"}})
	get(t, p, host, "/api/checkout", http.Header{"Sec-Fetch-Dest": {"empty"}})
	get(t, p, host, "/broken.html", nil)

	list, last := p.Requests(strconv.Itoa(port)+".devl.localhost", 0)
	if len(list) != 4 || last != 4 {
		t.Fatalf("logged %d (last %d): %+v", len(list), last, list)
	}
	doc, js, api, broken := list[0], list[1], list[2], list[3]
	if doc.Method != "GET" || doc.Path != "/" || doc.Status != 200 || doc.Type != "document" || doc.MIME != "text/html" || doc.Size == 0 || doc.Host != strconv.Itoa(port)+".devl.localhost" {
		t.Errorf("page: %+v", doc)
	}
	// Shipyard's own flags are not the page's.
	if js.Path != "/app.js?v=1" || js.Type != "script" {
		t.Errorf("script: %+v", js)
	}
	// A failed API call keeps the start of what it said, as text.
	if api.Status != 500 || api.Type != "fetch" || !strings.HasPrefix(api.Body, `{"error":"payment provider timed out"}`) || len(api.Body) != bodyCap {
		t.Errorf("api: status %d type %q body %d %q", api.Status, api.Type, len(api.Body), api.Body[:min(60, len(api.Body))])
	}
	// An HTML error page's body is not kept; its type comes from its
	// Content-Type when the browser didn't say.
	if broken.Status != 404 || broken.Body != "" || broken.Type != "document" {
		t.Errorf("broken: %+v", broken)
	}
	if doc.Start == 0 || doc.Seq != 1 || broken.Seq != 4 {
		t.Errorf("seq and start: %+v %+v", doc, broken)
	}

	// After a seq: only what is newer.
	list, _ = p.Requests(strconv.Itoa(port)+".devl.localhost:1377", 2)
	if len(list) != 2 || list[0].Path != "/api/checkout" {
		t.Errorf("after 2: %+v", list)
	}
	if list, _ := p.Requests("other.localhost", 0); len(list) != 0 || list == nil {
		t.Errorf("another host: %#v", list)
	}
}

func TestRequestLogFilesACallUnderThePageThatMadeIt(t *testing.T) {
	port := apiServer(t)
	api := strconv.Itoa(port) + ".devl.localhost:1377"
	p := newProxy()
	get(t, p, api, "/api/checkout", http.Header{"Referer": {"http://checkout.shop.devl.localhost:1377/cart"}})
	get(t, p, api, "/app.js", http.Header{"Referer": {"https://example.com/"}})
	if list, _ := p.Requests("checkout.shop.devl.localhost", 0); len(list) != 1 || list[0].Host != strconv.Itoa(port)+".devl.localhost" || list[0].Status != 500 {
		t.Errorf("page's log: %+v", list)
	}
	if list, _ := p.Requests(api, 0); len(list) != 2 {
		t.Errorf("api's own log: %+v", list)
	}
	if list, _ := p.Requests("example.com", 0); len(list) != 0 {
		t.Errorf("a site that isn't the proxy's: %+v", list)
	}
}

func TestRequestLogSaysWhyTheProxyAnsweredItself(t *testing.T) {
	p := newProxy()
	p.Worktree = func([]string) (string, int, bool) { return "", 0, false }
	get(t, p, "checkout.shop.devl.localhost:1377", "/", nil)
	// A port nothing listens on.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	get(t, p, strconv.Itoa(dead)+".devl.localhost:1377", "/x", nil)

	list, _ := p.Requests("checkout.shop.devl.localhost", 0)
	if len(list) != 1 || list[0].Status != 404 || list[0].Error != "Nothing is running in checkout.shop.devl yet" {
		t.Errorf("nothing running: %+v", list)
	}
	list, _ = p.Requests(strconv.Itoa(dead)+".devl.localhost", 0)
	if len(list) != 1 || list[0].Status != 502 || list[0].Error != "devl could not reach port "+strconv.Itoa(dead) {
		t.Errorf("unreachable: %+v", list)
	}
}

func TestRequestLogMarksACanceledRequest(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	p := newProxy()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	host := strconv.Itoa(dead) + ".devl.localhost:1377"
	req := httptest.NewRequest(http.MethodGet, "http://"+host+"/slow", nil).WithContext(ctx)
	req.Host = host
	p.ServeHTTP(httptest.NewRecorder(), req)
	list, _ := p.Requests(host, 0)
	if len(list) != 1 || list[0].Error != "canceled" || list[0].Status != 0 {
		t.Errorf("canceled: %+v", list)
	}
}

func TestRequestLogKeepsTheLatestAcrossManyTrims(t *testing.T) {
	p := &Proxy{}
	const total = 5*logLimit + 7
	for i := range total {
		p.requests.add(Request{Path: "/" + strconv.Itoa(i)}, "a.localhost")
		if hl := p.requests.hosts["a.localhost"]; cap(hl.list) > 2*logLimit {
			t.Fatalf("log grew to %d", cap(hl.list))
		}
	}
	list, last := p.Requests("a.localhost", 0)
	if len(list) != logLimit || last != total {
		t.Fatalf("got %d requests, last %d", len(list), last)
	}
	for i, r := range list {
		if want := "/" + strconv.Itoa(total-logLimit+i); r.Path != want {
			t.Fatalf("request %d is %q, want %q", i, r.Path, want)
		}
	}
	if list, _ := p.Requests("a.localhost", total-3); len(list) != 3 || list[2].Path != "/"+strconv.Itoa(total-1) {
		t.Fatalf("after: %+v", list)
	}
}

func TestRequestLogIsBounded(t *testing.T) {
	var l requestLog
	for i := range logLimit + 50 {
		l.add(Request{Path: "/" + strconv.Itoa(i)}, "a.localhost")
	}
	if got := len(l.hosts["a.localhost"].recent()); got != logLimit {
		t.Fatalf("kept %d", got)
	}
	if first := l.hosts["a.localhost"].recent()[0].Path; first != "/50" {
		t.Errorf("oldest kept %q", first)
	}
	for i := range logHosts + 5 {
		l.add(Request{}, "h"+strconv.Itoa(i)+".localhost")
	}
	if len(l.hosts) != logHosts {
		t.Errorf("kept %d hosts", len(l.hosts))
	}
	if l.hosts["a.localhost"] != nil {
		t.Error("the least recently used host stayed")
	}
}

func TestRequestLogLogsAWebSocketWhenItUpgrades(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		rw.Flush()
		io.Copy(conn, rw)
	}))
	defer upstream.Close()
	port := upstream.Listener.Addr().(*net.TCPAddr).Port
	p := newProxy()
	front := httptest.NewServer(p)
	defer front.Close()

	conn, err := net.Dial("tcp", front.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	host := strconv.Itoa(port) + ".devl.localhost"
	io.WriteString(conn, "GET /hmr HTTP/1.1\r\nHost: "+host+"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil || resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade: %v %v", resp, err)
	}
	// Logged while the socket is still open.
	list, _ := p.Requests(host, 0)
	if len(list) != 1 || list[0].Status != 101 || list[0].Type != "websocket" || list[0].Error != "" {
		t.Errorf("websocket: %+v", list)
	}
}
