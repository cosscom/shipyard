package proxy

import (
	"context"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/http/httputil"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/copybuf"
)

// DialFunc opens a stream to a port on a box.
type DialFunc func(ctx context.Context, port int) (net.Conn, error)

type Proxy struct {
	// Dialer returns the stream dialer for a paired box.
	Dialer func(box string) (DialFunc, bool)
	// Service resolves a named service on a box to a port. Optional.
	Service func(box, name string) (int, bool)
	// Index serves plain http://localhost:<port>/. Optional.
	Index http.Handler
	// Route matches hosts the user pointed at a box port as a whole, such as
	// every *.personal.shop.localhost at a worktree router. Those requests keep
	// their Host header, because the router on the box routes by it. Optional.
	Route func(host string) (box string, port int, ok bool)
	// Worktree resolves "<worktree>.<location>[.<box>].localhost" to the
	// worktree's dev server. Optional.
	Worktree func(labels []string) (box string, port int, ok bool)
	// BoxAlias maps a box's own name to the name this laptop paired it as.
	// A box writes URLs with its own name (BERTH_URL, an app's configured
	// origin), which on a laptop that calls it something else would lead
	// nowhere. Optional.
	BoxAlias func(name string) (paired string, ok bool)
	// Artifact fetches an artifact's page from a box, for its own origin
	// art-<id>.<box>.localhost (artifact.go). Optional: without it those
	// hosts answer 404.
	Artifact ArtifactFunc
	// Login runs a worktree's login script for the login route
	// (login.go). Optional: without it the route answers 404, and it is
	// never forwarded either way.
	Login LoginFunc
	// LibFetch fetches a pinned library for artifact pages; nil uses the
	// network (tests set it).
	LibFetch func(ctx context.Context, url string) ([]byte, error)

	libs       libCache
	mu         sync.Mutex
	transports map[string]*http.Transport
	preview    previewState
	requests   requestLog
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// An artifact's own origin: answered here, never forwarded, never
	// logged with a worktree's pages (artifact.go).
	if box, id, ok := p.artTarget(r.Host); ok {
		p.serveArtifact(w, r, box, id)
		return
	}
	// Every request is logged for the Browser tab's Network drawer
	// (requestlog.go).
	lw := p.logRequest(w, r)
	defer lw.finish()
	// The login route is the proxy's own on every host: answered here,
	// never passed to a dev server or a router (login.go).
	if isLoginRoute(r) {
		p.serveLogin(lw, r)
		return
	}
	p.serve(lw, r)
}

func (p *Proxy) serve(w http.ResponseWriter, r *http.Request) {
	if p.Route != nil {
		if box, port, ok := p.Route(hostOnly(r.Host)); ok {
			p.passThrough(w, r, box, port)
			return
		}
	}
	box, port, status, why := p.resolve(r.Host)
	if status != 0 {
		if status == http.StatusNotFound && IsIndexHost(r.Host) && p.Index != nil {
			p.Index.ServeHTTP(w, r)
			return
		}
		detail := "Use http://PORT.BOX.localhost or http://WORKTREE.LOCATION.BOX.localhost"
		if why == "" {
			why = "Shipyard doesn't know this address"
		} else if nothing, ok := strings.CutPrefix(why, nothingRunning); ok {
			why = "Nothing is running in " + nothing + " yet"
			detail = "Start its dev server in the worktree's terminal (npm start, npm run dev…) on $BERTH_PORT: berth sets PORT to it there, and a server started in the worktree's folder shows up here within seconds. Any other port on the box is http://PORT.BOX.localhost."
		}
		page(w, status, why, detail)
		return
	}
	target := Target{Box: box}
	publicHost := r.Host
	jarHost := hostOnly(r.Host)
	// A Preview tab's frame (preview.go): its page gets the preview script,
	// and its requests the cookies a frame is not sent.
	preview := p.preview.kind(r, jarHost)
	// A Browser tab frame's page that asked for the console script
	// (devtools.go).
	devtools := preview == "" && devtoolsPage(r)
	rp := &httputil.ReverseProxy{
		Transport:  p.transport(target.Box),
		BufferPool: copybuf.Pool{},
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetXForwarded()
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = "localhost:" + strconv.Itoa(port)
			pr.Out.Host = pr.Out.URL.Host
			for _, h := range []string{"Origin", "Referer"} {
				if v := pr.Out.Header.Get(h); v != "" {
					pr.Out.Header.Set(h, toUpstream(v, publicHost, port))
				}
			}
			pr.Out.Header.Del(PreviewHeader)
			if preview != "" {
				p.preview.lend(jarHost, pr.Out)
			}
			if preview == "page" {
				stripPreviewParam(pr.Out.URL)
				// The page itself, whole and plain, for the script to go in:
				// not compressed, and not a 304 for a copy cached without it.
				pr.Out.Header.Set("Accept-Encoding", "identity")
				pr.Out.Header.Del("If-None-Match")
				pr.Out.Header.Del("If-Modified-Since")
			}
			if devtools {
				devtoolsRequest(pr.Out)
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			if loc := resp.Header.Get("Location"); loc != "" {
				resp.Header.Set("Location", toPublic(loc, publicHost, port, target.Box))
			}
			p.preview.remember(jarHost, resp)
			if preview == "page" {
				framable(resp.Header)
				if r.Method == http.MethodGet && isHTML(resp) {
					injectPreview(resp)
				}
			}
			if devtools {
				devtoolsResponse(resp)
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			page(w, http.StatusBadGateway, fmt.Sprintf("%s could not reach port %d", target.Box, port), err.Error())
		},
	}
	rp.ServeHTTP(w, r)
}

// passThrough relays a request to a box port unchanged: Host, cookies,
// redirects, and upgrades pass through, for a router on the box to handle.
func (p *Proxy) passThrough(w http.ResponseWriter, r *http.Request, box string, port int) {
	if _, ok := p.Dialer(box); !ok {
		page(w, http.StatusBadGateway, "No paired box named "+box, "This host is routed to "+box+", which this laptop is not paired with.")
		return
	}
	rp := &httputil.ReverseProxy{
		Transport:  p.transport(box),
		BufferPool: copybuf.Pool{},
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetXForwarded()
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = "localhost:" + strconv.Itoa(port)
			pr.Out.Host = pr.In.Host
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			page(w, http.StatusBadGateway, fmt.Sprintf("%s could not reach port %d", box, port), err.Error())
		},
	}
	rp.ServeHTTP(w, r)
}

// nothingRunning starts the reason for a worktree name with no server yet.
const nothingRunning = "No running server for "

// transport keeps one connection pool per box. Each pooled connection is a
// stream to the box, dialed through whatever client the box has right now.
// resolve turns a request host into a box port: PORT.BOX or SERVICE.BOX
// first, then worktree names. A non-zero status explains a refusal.
func (p *Proxy) resolve(host string) (box string, port int, status int, why string) {
	labels, ok := localhostLabels(host)
	if !ok {
		return "", 0, http.StatusNotFound, ""
	}
	labels = p.pairedLabels(labels)
	if len(labels) == 2 {
		if _, known := p.Dialer(labels[1]); known {
			t := Target{Box: labels[1], Label: labels[0]}
			if port, ok := t.Port(); ok {
				return t.Box, port, 0, ""
			}
			if p.Service != nil {
				if port, ok := p.Service(t.Box, t.Label); ok {
					return t.Box, port, 0, ""
				}
			}
			if p.Worktree == nil {
				return "", 0, http.StatusNotFound, "No service named " + t.Label + " on " + t.Box
			}
		}
	}
	if p.Worktree != nil && len(labels) >= 2 {
		if box, port, ok := p.Worktree(labels); ok {
			return box, port, 0, ""
		}
		return "", 0, http.StatusNotFound, nothingRunning + strings.Join(labels, ".")
	}
	if len(labels) == 2 {
		return "", 0, http.StatusBadGateway, "No paired box named " + labels[1]
	}
	return "", 0, http.StatusNotFound, ""
}

// pairedLabels names the box in a host's labels as this laptop paired it,
// when the host used the box's own name instead.
func (p *Proxy) pairedLabels(labels []string) []string {
	n := len(labels)
	if p.BoxAlias == nil || n < 2 || n > 3 {
		return labels
	}
	if _, known := p.Dialer(labels[n-1]); known {
		return labels
	}
	paired, ok := p.BoxAlias(labels[n-1])
	if !ok {
		return labels
	}
	out := append([]string(nil), labels...)
	out[n-1] = paired
	return out
}

func (p *Proxy) transport(box string) *http.Transport {
	p.mu.Lock()
	defer p.mu.Unlock()
	if t := p.transports[box]; t != nil {
		return t
	}
	if p.transports == nil {
		p.transports = map[string]*http.Transport{}
	}
	t := &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			_, portStr, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			port, err := strconv.Atoi(portStr)
			if err != nil {
				return nil, err
			}
			dial, ok := p.Dialer(box)
			if !ok {
				return nil, fmt.Errorf("no paired box named %s", box)
			}
			return dial(ctx, port)
		},
		IdleConnTimeout:     30 * time.Second,
		MaxIdleConnsPerHost: 16,
	}
	p.transports[box] = t
	return t
}

// ResetBox drops pooled streams to box, which may be dead after it reconnects.
func (p *Proxy) ResetBox(box string) {
	p.mu.Lock()
	t := p.transports[box]
	p.mu.Unlock()
	if t != nil {
		t.CloseIdleConnections()
	}
}

// PageStyle is the stylesheet of the small pages the laptop agent serves
// itself: its errors and its index. They often show inside the app's browser
// tab, so they follow the system's light or dark appearance like the app.
const PageStyle = `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><style>` +
	`:root{--bg:#fff;--fg:#1c1c1f;--muted:#6e6e76;--line:#e4e4e8;--code:#f4f4f6}` +
	`@media (prefers-color-scheme:dark){:root{--bg:#1c1d20;--fg:#ececee;--muted:#8d8e96;--line:#303136;--code:#26272b}}` +
	`html{background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,sans-serif}` +
	`body{max-width:36rem;margin:0 auto;padding:16vh 1.5rem 3rem}` +
	`h1{font-size:17px;font-weight:600;margin:0 0 .5rem}h2{font-size:15px;font-weight:600;margin:2rem 0 .25rem}` +
	`p,li{color:var(--muted);margin:.35rem 0}a{color:var(--fg)}small{color:var(--muted);font-weight:400}` +
	`code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);background:var(--code);border:1px solid var(--line);border-radius:5px;padding:.05rem .3rem;overflow-wrap:anywhere}` +
	`footer{margin-top:2.5rem;padding-top:.75rem;border-top:1px solid var(--line);color:var(--muted);font-size:12px}</style>`

func page(w http.ResponseWriter, status int, title, detail string) {
	noteFailure(w, title)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><html lang="en"><meta charset="utf-8"><title>%s</title>%s<body><h1>%s</h1><p>%s</p><footer>%d %s · Shipyard</footer>`,
		html.EscapeString(title), PageStyle, html.EscapeString(title), html.EscapeString(detail), status, html.EscapeString(http.StatusText(status)))
}
