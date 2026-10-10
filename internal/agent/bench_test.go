package agent

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/identity"
	"github.com/cosscom/shipyard/internal/pairing"
	"github.com/cosscom/shipyard/internal/trust"
	"github.com/cosscom/shipyard/internal/wire"
)

// pairAs pairs the laptop in dir with b under name, so one laptop can hold
// several boxes.
func (b *testBox) pairAs(t testing.TB, dir, name string) {
	t.Helper()
	id, err := identity.LoadOrCreate(filepath.Join(dir, "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	code, err := b.server.Pending.Issue(time.Minute, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	tok := pairing.Token{Address: b.address, Fingerprint: b.server.Identity.Fingerprint(), Code: code}
	if _, err := wire.Pair(context.Background(), id, tok, "laptop"); err != nil {
		t.Fatal(err)
	}
	peer := trust.Peer{Name: name, Address: b.address, Fingerprint: tok.Fingerprint, PairedAt: time.Now()}
	if err := trust.NewStore(filepath.Join(dir, "boxes.json")).Add(peer); err != nil {
		t.Fatal(err)
	}
}

func benchDevServer(b *testing.B) int {
	b.Helper()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	})}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	go srv.Serve(ln)
	b.Cleanup(func() { srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

// BenchmarkProxyHosts relays small GETs through a running agent's proxy to
// a dev server on a box, for each form of address a page uses. A second
// box, without the worktree, is paired too, and a few routes are saved,
// as on a laptop in use. services/op is how often the boxes were asked
// for their services.
func BenchmarkProxyHosts(b *testing.B) {
	port := benchDevServer(b)
	one := newBox(b)
	one.services = []box.Service{{Location: "shop", Worktree: "checkout", Port: port}, {Location: "shop", Worktree: "shop", Port: port, Main: true}}
	two := newBox(b)
	two.services = []box.Service{{Location: "other", Worktree: "other", Port: port + 1}}
	dir := b.TempDir()
	one.pairAs(b, dir, "devbox")
	two.pairAs(b, dir, "spare")
	a := startAgentConfig(b, dir, &fakeNetworks{}, func(c *Config) { c.HealthInterval = time.Hour })
	eventually(b, "boxes online", func() bool {
		s, err := a.client.Status(context.Background())
		if err != nil || len(s.Boxes) != 2 {
			return false
		}
		return s.Boxes[0].State == StateOnline && s.Boxes[1].State == StateOnline
	})
	for _, r := range []Route{
		{Pattern: "*.cal.test.localhost", Box: "devbox", Port: port},
		{Pattern: "*.docs.test.localhost", Box: "devbox", Port: port},
		{Pattern: "admin.test.localhost", Box: "spare", Port: port},
	} {
		if err := a.client.Call(context.Background(), "POST", "/v1/routes", r, nil); err != nil {
			b.Fatal(err)
		}
	}
	c := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64}}
	for _, form := range []struct{ name, host string }{
		{"port.box", strconv.Itoa(port) + ".devbox.localhost"},
		{"worktree.location.box", "checkout.shop.devbox.localhost"},
		{"worktree.location", "checkout.shop.localhost"},
	} {
		host := form.host
		b.Run(form.name, func(b *testing.B) {
			before := one.servicesCalls.Load() + two.servicesCalls.Load()
			b.ReportAllocs()
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					req, _ := http.NewRequest(http.MethodGet, "http://"+a.proxy+"/app.js", nil)
					req.Host = host
					resp, err := c.Do(req)
					if err != nil {
						b.Error(err)
						return
					}
					io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
					if resp.StatusCode != http.StatusOK {
						b.Errorf("%s: %d", host, resp.StatusCode)
						return
					}
				}
			})
			b.ReportMetric(float64(one.servicesCalls.Load()+two.servicesCalls.Load()-before)/float64(b.N), "services/op")
		})
	}
}

// BenchmarkRouteLookup resolves a request host against the saved routes,
// which the proxy does first for every request it relays.
func BenchmarkRouteLookup(b *testing.B) {
	a := &Agent{routes: newRouteStore(filepath.Join(b.TempDir(), "routes.json"))}
	all := []Route{
		{Pattern: "*.cal.test.localhost", Box: "devbox", Port: 3000},
		{Pattern: "*.docs.test.localhost", Box: "devbox", Port: 3001},
		{Pattern: "admin.test.localhost", Box: "spare", Port: 3002},
	}
	if err := a.routes.update(func([]Route) ([]Route, error) { return all, nil }); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, _, ok := a.route("checkout.shop.devbox.localhost"); ok {
			b.Fatal("matched")
		}
	}
}

// BenchmarkInstalledKits asks every box for its kits, as the app's Kits
// view does, with boxes that each take 50ms to answer.
func BenchmarkInstalledKits(b *testing.B) {
	const n, delay = 4, 50 * time.Millisecond
	dir := b.TempDir()
	for i := range n {
		tb := newBoxWith(b, func(s *wire.Server) {
			s.Handle("GET /v1/kits", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				time.Sleep(delay)
				json.NewEncoder(w).Encode([]box.InstalledKitAt{{Location: "shop", Kit: box.InstalledKit{ID: "acme"}}})
			}))
		})
		tb.pairAs(b, dir, "box"+strconv.Itoa(i))
	}
	a := startAgentConfig(b, dir, &fakeNetworks{}, func(c *Config) { c.HealthInterval = time.Hour })
	eventually(b, "boxes online", func() bool {
		s, err := a.client.Status(context.Background())
		if err != nil || len(s.Boxes) != n {
			return false
		}
		for _, bs := range s.Boxes {
			if bs.State != StateOnline {
				return false
			}
		}
		return true
	})
	b.ResetTimer()
	for range b.N {
		var out []InstalledKitOn
		if err := a.client.Call(context.Background(), "GET", "/v1/kits/installed", nil, &out); err != nil {
			b.Fatal(err)
		}
		if len(out) != n {
			b.Fatalf("got %d kits", len(out))
		}
	}
	b.ReportMetric(float64(b.Elapsed().Milliseconds())/float64(b.N), "ms/op")
}

// BenchmarkStatus is GET /v1/status, which the app reads on every box
// event and on its backstop poll.
func BenchmarkStatus(b *testing.B) {
	one := newBox(b)
	dir := one.pairLaptop()
	a := startAgentConfig(b, dir, &fakeNetworks{}, func(c *Config) { c.HealthInterval = time.Hour })
	eventually(b, "box online", func() bool { return stateOf(b, a) == StateOnline })
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, err := a.client.Status(context.Background()); err != nil {
			b.Fatal(err)
		}
	}
}
