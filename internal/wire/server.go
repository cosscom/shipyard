package wire

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cosscom/shipyard/internal/copybuf"
	"github.com/cosscom/shipyard/internal/identity"
	"github.com/cosscom/shipyard/internal/pairing"
	"github.com/cosscom/shipyard/internal/trust"
)

// Rejections are deliberately uninformative: the caller learns that it was
// refused, never whether a code existed, expired, or was already used.
const (
	errPairingRejected = "pairing rejected"
	errUnauthorized    = "unauthorized"
	errTooManyPairings = "too many pairing attempts; try again in a minute"
)

const (
	maxPairBody = 16 << 10
	// headerTimeout also bounds the TLS handshake, so a connection cannot hold
	// server resources indefinitely before authenticating.
	headerTimeout   = 10 * time.Second
	upstreamTimeout = 5 * time.Second
)

type Server struct {
	Identity *identity.Identity
	Clients  *trust.Store
	Pending  *pairing.Pending
	Name     string
	Log      *log.Logger
	Now      func() time.Time

	// RevokeCheck is how often open connections are checked against the
	// trust store, so a revoked laptop loses what it already holds.
	RevokeCheck time.Duration

	// OnPaired, when set, is told about each laptop that pairs, so the box
	// can announce it.
	OnPaired func(trust.Peer)

	once      sync.Once
	mux       *http.ServeMux
	local     *http.ServeMux
	pairLimit *pairLimiter
	streams   atomic.Int64
	// stopping is set once Serve's context ends: a ping then answers that
	// the box is going, rather than looking like a link that dropped.
	stopping atomic.Bool
	open     openConns
	recheck  chan struct{}
}

// ActiveStreams reports how many port streams are open right now.
func (s *Server) ActiveStreams() int64 { return s.streams.Load() }

func (s *Server) init() {
	s.once.Do(func() {
		s.pairLimit = newPairLimiter()
		s.recheck = make(chan struct{}, 1)
		s.mux = http.NewServeMux()
		s.local = http.NewServeMux()
		s.mux.HandleFunc("POST /v1/pair", s.handlePair)
		s.mux.Handle("GET /v1/ping", s.authenticated(http.HandlerFunc(s.handlePing)))
		s.mux.Handle("POST /v1/tcp", s.authenticated(http.HandlerFunc(s.handleTCP)))
		// berthd revoke, on the box itself, says when it removed a laptop so
		// that laptop's open connections close at once.
		s.local.HandleFunc("POST /v1/clients/changed", func(w http.ResponseWriter, r *http.Request) {
			s.ClientsChanged()
			w.WriteHeader(http.StatusOK)
		})
	})
}

// Handle mounts a handler that only paired laptops, and the box's own user
// through ServeLocal, can reach. The caller is available through PeerFrom.
func (s *Server) Handle(pattern string, h http.Handler) {
	s.init()
	s.mux.Handle(pattern, s.authenticated(h))
	s.local.Handle(pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(context.WithValue(r.Context(), peerKey{}, LocalPeer), localKey{}, true)
		h.ServeHTTP(w, r.WithContext(ctx))
	}))
}

// LocalPeer is the caller on the box's own Unix socket. Its name is reserved:
// a laptop asking to pair as "local" is named something else.
var LocalPeer = trust.Peer{Name: "local"}

type localKey struct{}

// IsLocal reports whether a request came over the box's own Unix socket
// rather than from a paired laptop. Use it, not the peer's name, to decide
// what only the box itself may do.
func IsLocal(ctx context.Context) bool {
	v, _ := ctx.Value(localKey{}).(bool)
	return v
}

// ServeLocal serves the Handle'd routes on ln, a Unix socket that only the
// box's user can open. Tools running on the box (Orca and Herdr hooks, the
// berthd CLI) use it; file permissions are its authorization.
func (s *Server) ServeLocal(ctx context.Context, ln net.Listener) error {
	s.init()
	srv := &http.Server{Handler: s.local, ReadHeaderTimeout: headerTimeout}
	stop := context.AfterFunc(ctx, func() { srv.Close() })
	defer stop()
	err := srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) && ctx.Err() != nil {
		return nil
	}
	return err
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) logf(format string, args ...any) {
	if s.Log != nil {
		s.Log.Printf(format, args...)
	}
}

// Serve accepts connections on ln until ctx is cancelled.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	s.init()
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetHTTP2(true)
	srv := &http.Server{
		Handler:           s.mux,
		TLSConfig:         serverConfig(s.Identity),
		Protocols:         protocols,
		ReadHeaderTimeout: headerTimeout,
		MaxHeaderBytes:    16 << 10,
		IdleTimeout:       10 * time.Minute,
		HTTP2:             &http.HTTP2Config{SendPingTimeout: 30 * time.Second, PingTimeout: 15 * time.Second},
		// An exposed port attracts scanners; their failed handshakes are noise.
		ErrorLog: log.New(io.Discard, "", 0),
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			return context.WithValue(ctx, connKey{}, c)
		},
	}
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		defer close(stopped)
		// Say so before going: Shutdown stops listening and sends each
		// laptop's connection a GOAWAY, so a laptop knows the box is
		// stopping rather than that its link went quiet. Then close
		// whatever is still open (event streams, terminals).
		s.stopping.Store(true)
		grace, cancel := context.WithTimeout(context.Background(), stopGrace)
		defer cancel()
		srv.Shutdown(grace)
		srv.Close()
	})
	defer stop()
	watchCtx, endWatch := context.WithCancel(ctx)
	defer endWatch()
	go s.watchRevocations(watchCtx)
	err := srv.ServeTLS(ln, "", "")
	if errors.Is(err, http.ErrServerClosed) && ctx.Err() != nil {
		if !stop() {
			<-stopped
		}
		return nil
	}
	return err
}

type peerKey struct{}

// PeerFrom returns the paired laptop making a request to a Handle'd route.
func PeerFrom(ctx context.Context) trust.Peer {
	p, _ := ctx.Value(peerKey{}).(trust.Peer)
	return p
}

func (s *Server) authenticated(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fp, ok := clientFingerprint(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, errUnauthorized)
			return
		}
		peer, ok := s.authorize(fp)
		if !ok {
			writeError(w, http.StatusUnauthorized, errUnauthorized)
			return
		}
		// Long-lived requests (shells, port streams, event streams) are
		// remembered under the key that opened them, so revoking that key
		// ends them too.
		ctx, cancel := context.WithCancel(context.WithValue(r.Context(), peerKey{}, peer))
		defer cancel()
		conn, _ := r.Context().Value(connKey{}).(net.Conn)
		done := s.open.add(fp, conn, cancel)
		defer done()
		h.ServeHTTP(w, r.WithContext(ctx))
	})
}

func clientFingerprint(r *http.Request) (identity.Fingerprint, bool) {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		return identity.Fingerprint{}, false
	}
	return identity.FingerprintOf(r.TLS.PeerCertificates[0]), true
}

// authorize fails closed: a trust store that cannot be read authorizes nobody.
func (s *Server) authorize(peer identity.Fingerprint) (trust.Peer, bool) {
	p, ok, err := s.Clients.Trusted(peer)
	if err != nil {
		s.logf("trust store unreadable, refusing %s: %v", peer.Short(), err)
		return trust.Peer{}, false
	}
	return p, ok
}

type pairRequest struct {
	Name  string `json:"name"`
	Proof []byte `json:"proof"`
}

type nameResponse struct {
	Name string `json:"name"`
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	// Each source gets its own budget, and only failures spend it, so a
	// stranger hammering the port cannot lock the owner out of pairing.
	src := remoteIP(r)
	if !s.pairLimit.allow(src, s.now()) {
		writeError(w, http.StatusTooManyRequests, errTooManyPairings)
		return
	}
	succeeded := false
	defer func() {
		if succeeded {
			s.pairLimit.refund(src)
		}
	}()
	peer, ok := clientFingerprint(r)
	if !ok {
		writeError(w, http.StatusForbidden, errPairingRejected)
		return
	}
	var req pairRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPairBody)).Decode(&req); err != nil {
		writeError(w, http.StatusForbidden, errPairingRejected)
		return
	}
	exporter, err := r.TLS.ExportKeyingMaterial(pairing.ExporterLabel, nil, pairing.ExporterSize)
	if err != nil {
		writeError(w, http.StatusForbidden, errPairingRejected)
		return
	}
	matched, err := s.Pending.Consume(s.now(), func(code pairing.Code) bool {
		return hmac.Equal(req.Proof, pairing.Proof(code, exporter, peer))
	})
	if err != nil {
		s.logf("pairing store error: %v", err)
	}
	if err != nil || !matched {
		s.logf("pairing rejected for %s", peer.Short())
		writeError(w, http.StatusForbidden, errPairingRejected)
		return
	}
	name := req.Name
	if !trust.ValidName(name) || strings.EqualFold(name, LocalPeer.Name) {
		name = "client"
	}
	name, err = s.Clients.AddWithFreeName(trust.Peer{Name: name, Fingerprint: peer, PairedAt: s.now().UTC()})
	if err != nil {
		s.logf("pairing succeeded but pinning %s failed: %v", peer.Short(), err)
		writeError(w, http.StatusForbidden, errPairingRejected)
		return
	}
	s.logf("paired client %q (%s)", name, peer.Short())
	succeeded = true
	if s.OnPaired != nil {
		s.OnPaired(trust.Peer{Name: name, Fingerprint: peer, PairedAt: s.now().UTC()})
	}
	writeJSON(w, http.StatusOK, nameResponse{Name: s.Name})
}

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	if s.stopping.Load() {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: ErrStopping.Error(), Code: codeStopping})
		return
	}
	writeJSON(w, http.StatusOK, nameResponse{Name: s.Name})
}

// handleTCP bridges one stream to a port on the box's own loopback. Only
// loopback is reachable: a paired laptop gets the box's services, not a route
// into whatever network the box sits on.
func (s *Server) handleTCP(w http.ResponseWriter, r *http.Request) {
	port, err := strconv.Atoi(r.URL.Query().Get("port"))
	if err != nil || port < 1 || port > 65535 {
		writeError(w, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}
	upstream, err := dialLoopback(r.Context(), port)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("nothing is listening on port %d on this box", port))
		return
	}
	defer upstream.Close()
	s.streams.Add(1)
	defer s.streams.Add(-1)
	// A reset stream must also release the upstream connection, even while
	// the upstream is silent and nothing is being copied.
	stop := context.AfterFunc(r.Context(), func() { upstream.Close() })
	defer stop()

	rc := http.NewResponseController(w)
	rc.EnableFullDuplex()
	w.WriteHeader(http.StatusOK)
	if err := rc.Flush(); err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		copybuf.Copy(upstream, r.Body)
		if tc, ok := upstream.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}()
	copybuf.Copy(flushWriter{w: w, rc: rc}, upstream)
	upstream.Close()
	r.Body.Close()
	<-done
}

func dialLoopback(ctx context.Context, port int) (net.Conn, error) {
	d := net.Dialer{Timeout: upstreamTimeout}
	var firstErr error
	for _, host := range []string{"127.0.0.1", "::1"} {
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err == nil {
			return conn, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

// flushWriter pushes each chunk to the laptop as soon as it arrives, so
// interactive protocols are not held back by response buffering.
type flushWriter struct {
	w  http.ResponseWriter
	rc *http.ResponseController
}

func (f flushWriter) Write(b []byte) (int, error) {
	n, err := f.w.Write(b)
	if err == nil {
		err = f.rc.Flush()
	}
	return n, err
}

type errorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

// codeStopping marks a ping answered by a box on its way down.
const codeStopping = "box_stopping"

// stopGrace is how long a stopping box waits for its laptops to take its
// GOAWAY before it closes their connections.
const stopGrace = 250 * time.Millisecond

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}
