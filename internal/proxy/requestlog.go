package proxy

import (
	"bufio"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// The app's Browser tab has a Network drawer: the requests its page made,
// with their status, type, time and size. Every request a worktree's page
// makes goes through this proxy, so the proxy keeps a short log of them, per
// page host, which the app reads through the laptop agent's API
// (GET /v1/proxy/requests?host=…). A request is logged under its own host
// and, when its Referer is another host (a page on one worktree name
// calling an API on another), under that page's host too.
//
// The log is small and in memory: the last logLimit requests for each of the
// last logHosts hosts. Nothing about a request's content is kept, except the
// start of a failed response's body when it is text (an error message, which
// is what an agent sent the failure needs).

const (
	logLimit = 200 // requests kept per host
	logHosts = 32  // hosts kept, the least recently used dropped first
	pathCap  = 2048
	bodyCap  = 1024
)

// Request is one request the proxy relayed (or refused), once it is done.
type Request struct {
	Seq    int64  `json:"seq"`
	Start  int64  `json:"start"` // Unix milliseconds
	Method string `json:"method"`
	Host   string `json:"host"`
	Path   string `json:"path"` // with its query
	Status int    `json:"status"`
	// Type is what asked for it, from Sec-Fetch-Dest (document, script,
	// style, image, font, fetch, websocket…), else from the response's
	// Content-Type.
	Type string `json:"type"`
	MIME string `json:"mime,omitempty"`
	Ms   int64  `json:"ms"`
	Size int64  `json:"size"` // bytes sent to the page
	// Error is why the proxy answered itself ("devl could not reach port
	// 3000"), or "canceled" when the page gave up on it.
	Error string `json:"error,omitempty"`
	// Body is the start of a failed response's text (4xx and 5xx, JSON or
	// plain text only).
	Body string `json:"body,omitempty"`
}

type requestLog struct {
	mu    sync.Mutex
	seq   int64
	hosts map[string]*hostLog
}

type hostLog struct {
	// list holds the host's requests, oldest first: the last logLimit of
	// them are its log (recent). It grows to twice that before the old half
	// is dropped, in place, so logging a request costs no copy of the log.
	list []Request
	used time.Time
}

// recent is the host's log: its last logLimit requests, oldest first.
func (hl *hostLog) recent() []Request {
	if n := len(hl.list); n > logLimit {
		return hl.list[n-logLimit:]
	}
	return hl.list
}

func (l *requestLog) add(req Request, hosts ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seq++
	req.Seq = l.seq
	if l.hosts == nil {
		l.hosts = map[string]*hostLog{}
	}
	now := time.Now()
	for i, h := range hosts {
		if h == "" || slices.Contains(hosts[:i], h) {
			continue
		}
		hl := l.hosts[h]
		if hl == nil {
			if len(l.hosts) >= logHosts {
				l.evictLocked()
			}
			hl = &hostLog{}
			l.hosts[h] = hl
		}
		hl.used = now
		switch n := len(hl.list); {
		case n == 2*logLimit:
			copy(hl.list, hl.list[logLimit:])
			clear(hl.list[logLimit:])
			hl.list = hl.list[:logLimit]
		case n == cap(hl.list):
			// Grown by hand, to never more than the 2*logLimit it needs.
			hl.list = append(make([]Request, 0, min(max(2*n, 16), 2*logLimit)), hl.list...)
		}
		hl.list = append(hl.list, req)
	}
}

func (l *requestLog) evictLocked() {
	var oldest string
	var at time.Time
	for h, hl := range l.hosts {
		if oldest == "" || hl.used.Before(at) {
			oldest, at = h, hl.used
		}
	}
	delete(l.hosts, oldest)
}

// Requests returns what the proxy logged for a page host (a hostname, such
// as checkout.shop.devl.localhost) after seq, oldest first, and the latest
// seq overall, for the next call's after.
func (p *Proxy) Requests(host string, after int64) ([]Request, int64) {
	l := &p.requests
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []Request{}
	if hl := l.hosts[hostOnly(host)]; hl != nil {
		for _, r := range hl.recent() {
			if r.Seq > after {
				out = append(out, r)
			}
		}
	}
	return out, l.seq
}

// logged wraps a response writer to log the request once it is done.
type logged struct {
	http.ResponseWriter
	p     *Proxy
	r     *http.Request
	start time.Time
	page  string // the Referer's host, when it is another

	status int
	size   int64
	body   []byte
	note   string
	done   bool
}

func (p *Proxy) logRequest(w http.ResponseWriter, r *http.Request) *logged {
	lw := &logged{ResponseWriter: w, p: p, r: r, start: time.Now()}
	if ref, err := url.Parse(r.Header.Get("Referer")); err == nil && ref.Host != "" {
		if h := hostOnly(ref.Host); h != hostOnly(r.Host) && strings.HasSuffix(h, ".localhost") {
			lw.page = h
		}
	}
	return lw
}

func (lw *logged) WriteHeader(code int) {
	// 1xx answers (103 Early Hints) come before the real one.
	if lw.status == 0 && code >= 200 {
		lw.status = code
	}
	lw.ResponseWriter.WriteHeader(code)
}

func (lw *logged) Write(b []byte) (int, error) {
	if lw.status == 0 {
		lw.status = http.StatusOK
	}
	n, err := lw.ResponseWriter.Write(b)
	lw.size += int64(n)
	if lw.status >= 400 && len(lw.body) < bodyCap && textual(lw.Header().Get("Content-Type")) {
		lw.body = append(lw.body, b[:min(n, bodyCap-len(lw.body))]...)
	}
	return n, err
}

// Unwrap lets http.ResponseController reach the connection's own writer,
// to flush a streamed response.
func (lw *logged) Unwrap() http.ResponseWriter { return lw.ResponseWriter }

// Hijack hands a WebSocket's connection over (a dev server's live reload):
// the request is logged then, as switching protocols, rather than when the
// socket closes.
func (lw *logged) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, brw, err := http.NewResponseController(lw.ResponseWriter).Hijack()
	if err == nil {
		if lw.status == 0 {
			lw.status = http.StatusSwitchingProtocols
		}
		lw.finish()
	}
	return conn, brw, err
}

// finish logs the request, once.
func (lw *logged) finish() {
	if lw.done {
		return
	}
	lw.done = true
	r := lw.r
	path := r.URL.RequestURI()
	stripFlags(&path)
	if len(path) > pathCap {
		path = path[:pathCap] + "…"
	}
	mime := lw.Header().Get("Content-Type")
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = mime[:i]
	}
	mime = strings.TrimSpace(strings.ToLower(mime))
	req := Request{
		Start:  lw.start.UnixMilli(),
		Method: r.Method,
		Host:   hostOnly(r.Host),
		Path:   path,
		Status: lw.status,
		Type:   requestType(r, mime),
		MIME:   mime,
		Ms:     time.Since(lw.start).Milliseconds(),
		Size:   lw.size,
		Error:  lw.note,
		Body:   strings.ToValidUTF8(string(lw.body), ""),
	}
	if lw.status < 400 {
		req.Body = ""
	}
	// The page gave up on it (navigated away, aborted a fetch): not a
	// failure, and any answer the proxy wrote itself never reached it.
	if r.Context().Err() != nil && lw.status != http.StatusSwitchingProtocols {
		if lw.note != "" {
			req.Status = 0
		}
		req.Error, req.Body = "canceled", ""
	}
	lw.p.requests.add(req, req.Host, lw.page)
}

// noteFailure records why the proxy answered a request itself, when w is a
// logged request's writer.
func noteFailure(w http.ResponseWriter, why string) {
	if lw, ok := w.(*logged); ok && lw.note == "" {
		lw.note = why
	}
}

// stripFlags takes Shipyard's own query flags off a logged path: the page
// never sees them either.
func stripFlags(path *string) {
	if !strings.Contains(*path, "__berth_") {
		return
	}
	u, err := url.ParseRequestURI(*path)
	if err != nil {
		return
	}
	stripPreviewParam(u)
	stripDevtoolsParam(u)
	*path = u.RequestURI()
}

// requestType names what a request was for, as the Network drawer shows it.
func requestType(r *http.Request, mime string) string {
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return "websocket"
	}
	switch d := r.Header.Get("Sec-Fetch-Dest"); d {
	case "document", "iframe", "frame":
		return "document"
	case "empty":
		if strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
			return "eventsource"
		}
		return "fetch"
	case "":
	default:
		return d
	}
	switch {
	case mime == "text/html":
		return "document"
	case strings.Contains(mime, "javascript") || strings.Contains(mime, "ecmascript"):
		return "script"
	case mime == "text/css":
		return "style"
	case strings.HasPrefix(mime, "image/"):
		return "image"
	case strings.HasPrefix(mime, "font/") || strings.Contains(mime, "font"):
		return "font"
	case strings.Contains(mime, "json") || mime == "text/plain":
		return "fetch"
	case mime == "text/event-stream":
		return "eventsource"
	}
	return "other"
}

// textual is a body worth keeping the start of: JSON or plain text, which
// is how APIs say what went wrong.
func textual(contentType string) bool {
	ct := strings.ToLower(contentType)
	return strings.Contains(ct, "json") || strings.HasPrefix(ct, "text/plain")
}
