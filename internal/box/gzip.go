package box

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"
)

// A box's JSON answers cross the link to the laptop, often a tailnet or an
// SSH tunnel: a long conversation's first read or a box with hundreds of
// worktrees is tens or hundreds of KB that gzip cuts by about ten times.
// Go's HTTP client asks for gzip on its own and unpacks it on its own, so
// the laptop agent, the CLI and the phone's browser all get the same JSON
// as before; anything that doesn't ask gets it plain.
//
// Only a whole 200 answer of application/json of at least gzipMin bytes is
// packed. Streams (events, NDJSON, terminals), files, images and errors
// pass through as they are, and an answer flushed before gzipMin goes out
// plain from there on, so a long poll or a stream is never held back.

const gzipMin = 1024

var gzipPool = sync.Pool{New: func() any {
	w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
	return w
}}

// acceptsGzip says whether the request asks for gzip (and not with q=0).
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(name), "gzip") {
			q := strings.ReplaceAll(strings.TrimSpace(params), " ", "")
			return q != "q=0" && q != "q=0.0" && q != "q=0.00" && q != "q=0.000"
		}
	}
	return false
}

// gzipJSON packs h's large JSON answers for clients that ask for gzip.
func gzipJSON(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !acceptsGzip(r) || r.Header.Get("Upgrade") != "" {
			h.ServeHTTP(w, r)
			return
		}
		g := &gzipWriter{w: w}
		defer g.finish()
		h.ServeHTTP(g, r)
	})
}

type gzipMode int

const (
	gzDeciding gzipMode = iota // holding the first bytes of a JSON answer
	gzPlain                    // passing everything through
	gzPacking                  // writing through gzip
)

type gzipWriter struct {
	w      http.ResponseWriter
	status int
	header bool // WriteHeader has been called (by the handler or a Write)
	mode   gzipMode
	buf    []byte
	gz     *gzip.Writer
}

func (g *gzipWriter) Header() http.Header { return g.w.Header() }

// Unwrap lets http.ResponseController reach the connection (full duplex,
// deadlines, hijacking) behind the wrapper.
func (g *gzipWriter) Unwrap() http.ResponseWriter { return g.w }

func (g *gzipWriter) WriteHeader(status int) {
	if g.header {
		return
	}
	g.header = true
	g.status = status
	h := g.w.Header()
	ct := h.Get("Content-Type")
	if status != http.StatusOK || h.Get("Content-Encoding") != "" || !strings.HasPrefix(ct, "application/json") {
		g.mode = gzPlain
		g.w.WriteHeader(status)
	}
}

func (g *gzipWriter) Write(p []byte) (int, error) {
	if !g.header {
		g.WriteHeader(http.StatusOK)
	}
	switch g.mode {
	case gzPlain:
		return g.w.Write(p)
	case gzPacking:
		return g.gz.Write(p)
	}
	g.buf = append(g.buf, p...)
	if len(g.buf) < gzipMin {
		return len(p), nil
	}
	h := g.w.Header()
	h.Set("Content-Encoding", "gzip")
	h.Add("Vary", "Accept-Encoding")
	h.Del("Content-Length")
	g.w.WriteHeader(g.status)
	g.gz = gzipPool.Get().(*gzip.Writer)
	g.gz.Reset(g.w)
	g.mode = gzPacking
	buf := g.buf
	g.buf = nil
	if _, err := g.gz.Write(buf); err != nil {
		return 0, err
	}
	return len(p), nil
}

// plain sends what is held as it is, and everything after it too.
func (g *gzipWriter) plain() error {
	g.mode = gzPlain
	g.w.WriteHeader(g.status)
	if len(g.buf) == 0 {
		return nil
	}
	buf := g.buf
	g.buf = nil
	_, err := g.w.Write(buf)
	return err
}

// Flush sends what is written so far: a handler that flushes is streaming,
// so one that does before gzipMin goes out plain.
func (g *gzipWriter) Flush() {
	_ = g.FlushError()
}

func (g *gzipWriter) FlushError() error {
	if !g.header {
		g.WriteHeader(http.StatusOK)
	}
	switch g.mode {
	case gzDeciding:
		if err := g.plain(); err != nil {
			return err
		}
	case gzPacking:
		if err := g.gz.Flush(); err != nil {
			return err
		}
	}
	return http.NewResponseController(g.w).Flush()
}

func (g *gzipWriter) finish() {
	switch g.mode {
	case gzDeciding:
		if g.header {
			_ = g.plain()
		}
	case gzPacking:
		_ = g.gz.Close()
		g.gz.Reset(io.Discard)
		gzipPool.Put(g.gz)
		g.gz = nil
	}
}
