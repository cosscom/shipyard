package proxy

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// benchUpstream is a dev server on the "box" that answers every request
// with size bytes.
func benchUpstream(b *testing.B, size int) int {
	b.Helper()
	body := bytes.Repeat([]byte("x"), size)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Write(body)
	}))
	b.Cleanup(srv.Close)
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

// benchProxy is a proxy whose one box, devl, is this machine's loopback.
func benchProxy(b *testing.B) string {
	b.Helper()
	var d net.Dialer
	p := &Proxy{Dialer: func(box string) (DialFunc, bool) {
		if box != "devl" {
			return nil, false
		}
		return func(ctx context.Context, port int) (net.Conn, error) {
			return d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		}, true
	}}
	srv := httptest.NewServer(p)
	b.Cleanup(srv.Close)
	return srv.Listener.Addr().String()
}

func benchClient() *http.Client {
	return &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64, DisableCompression: true}}
}

// BenchmarkProxyGet relays GETs of a few sizes through the proxy to a dev
// server, as a page's assets are.
func BenchmarkProxyGet(b *testing.B) {
	for _, size := range []int{1 << 10, 64 << 10, 1 << 20} {
		b.Run(strconv.Itoa(size>>10)+"KB", func(b *testing.B) {
			port := benchUpstream(b, size)
			addr := benchProxy(b)
			c := benchClient()
			host := strconv.Itoa(port) + ".devl.localhost"
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					req, _ := http.NewRequest(http.MethodGet, "http://"+addr+"/asset.js", nil)
					req.Host = host
					resp, err := c.Do(req)
					if err != nil {
						b.Error(err)
						return
					}
					io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
				}
			})
		})
	}
}

// BenchmarkRequestLogAdd logs requests for one busy page host, past the
// per-host limit, as a dev server's live page does all day.
func BenchmarkRequestLogAdd(b *testing.B) {
	var l requestLog
	req := Request{Method: "GET", Host: "checkout.shop.devl.localhost", Path: "/assets/app.js", Status: 200, Type: "script", MIME: "text/javascript"}
	for range logLimit {
		l.add(req, req.Host, "")
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		l.add(req, req.Host, "shop.devl.localhost")
	}
}

// BenchmarkRequests reads a full host's log after the app's last seq, as
// the Network drawer polls it.
func BenchmarkRequests(b *testing.B) {
	p := &Proxy{}
	req := Request{Method: "GET", Host: "checkout.shop.devl.localhost", Path: "/assets/app.js", Status: 200}
	for range 3 * logLimit {
		p.requests.add(req, req.Host)
	}
	_, last := p.Requests(req.Host, 0)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		list, _ := p.Requests(req.Host, last-10)
		if len(list) != 10 {
			b.Fatalf("got %d", len(list))
		}
	}
}
