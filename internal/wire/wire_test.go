package wire

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/identity"
	"github.com/cosscom/shipyard/internal/pairing"
	"github.com/cosscom/shipyard/internal/trust"
)

type box struct {
	server   *Server
	address  string
	dir      string
	accepted *atomic.Int32
}

// countingListener records how many TCP connections the box accepts, to prove
// that streams share one connection.
type countingListener struct {
	net.Listener
	n *atomic.Int32
}

func (l countingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.n.Add(1)
	}
	return c, err
}

func startBox(t testing.TB) *box { return startBoxWith(t, nil) }

func startBoxWith(t testing.TB, configure func(*Server)) *box {
	t.Helper()
	dir := t.TempDir()
	id, err := identity.LoadOrCreate(filepath.Join(dir, "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		Identity: id,
		Clients:  trust.NewStore(filepath.Join(dir, "clients.json")),
		Pending:  pairing.NewPending(filepath.Join(dir, "pairing.json")),
		Name:     "dev-test",
	}
	if configure != nil {
		configure(s)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	accepted := new(atomic.Int32)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, countingListener{ln, accepted}) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Serve: %v", err)
		}
	})
	return &box{server: s, address: ln.Addr().String(), dir: dir, accepted: accepted}
}

func (b *box) issue(t testing.TB) pairing.Token {
	t.Helper()
	code, err := b.server.Pending.Issue(10*time.Minute, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return pairing.Token{Address: b.address, Fingerprint: b.server.Identity.Fingerprint(), Code: code}
}

func (b *box) peer() trust.Peer {
	return trust.Peer{Name: "dev-test", Address: b.address, Fingerprint: b.server.Identity.Fingerprint()}
}

func laptop(t testing.TB) *identity.Identity {
	t.Helper()
	id, err := identity.LoadOrCreate(filepath.Join(t.TempDir(), "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// paired returns a client for a laptop that has completed pairing with b.
func paired(t testing.TB, b *box) *Client {
	t.Helper()
	me := laptop(t)
	if _, err := Pair(context.Background(), me, b.issue(t), "alex-mbp"); err != nil {
		t.Fatal(err)
	}
	c := NewClient(me, b.peer())
	t.Cleanup(c.Reset)
	return c
}

func TestPairThenPing(t *testing.T) {
	b := startBox(t)
	me := laptop(t)
	c := NewClient(me, b.peer())
	defer c.Reset()
	if _, err := c.Ping(context.Background()); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("unpaired ping: %v, want ErrUntrusted", err)
	}
	name, err := Pair(context.Background(), me, b.issue(t), "alex-mbp")
	if err != nil {
		t.Fatal(err)
	}
	if name != "dev-test" {
		t.Fatalf("box reported name %q", name)
	}
	client, ok, err := b.server.Clients.Trusted(me.Fingerprint())
	if err != nil || !ok || client.Name != "alex-mbp" {
		t.Fatalf("box did not pin the laptop: %+v %v %v", client, ok, err)
	}
	if got, err := c.Ping(context.Background()); err != nil || got != "dev-test" {
		t.Fatalf("paired ping = %q, %v", got, err)
	}
}

func TestAWrongCodeIsRejectedAndLeavesTheRealCodeUsable(t *testing.T) {
	b := startBox(t)
	tok := b.issue(t)
	forged := tok
	forged.Code[0] ^= 1
	attacker := laptop(t)
	if _, err := Pair(context.Background(), attacker, forged, "attacker"); err == nil {
		t.Fatal("a wrong code paired")
	}
	if _, ok, _ := b.server.Clients.Trusted(attacker.Fingerprint()); ok {
		t.Fatal("a rejected laptop was pinned")
	}
	if _, err := Pair(context.Background(), laptop(t), tok, "alex-mbp"); err != nil {
		t.Fatalf("a failed guess burned the real code: %v", err)
	}
}

func TestACodeCannotBeUsedTwice(t *testing.T) {
	b := startBox(t)
	tok := b.issue(t)
	if _, err := Pair(context.Background(), laptop(t), tok, "first"); err != nil {
		t.Fatal(err)
	}
	second := laptop(t)
	if _, err := Pair(context.Background(), second, tok, "second"); err == nil {
		t.Fatal("a used code paired a second laptop")
	}
	if _, ok, _ := b.server.Clients.Trusted(second.Fingerprint()); ok {
		t.Fatal("the second laptop was pinned")
	}
}

func TestAnExpiredCodeIsRejected(t *testing.T) {
	b := startBox(t)
	tok := b.issue(t)
	b.server.Now = func() time.Time { return time.Now().Add(11 * time.Minute) }
	if _, err := Pair(context.Background(), laptop(t), tok, "late"); err == nil {
		t.Fatal("an expired code paired")
	}
}

func TestLaptopRefusesABoxPresentingAnotherKey(t *testing.T) {
	real := startBox(t)
	impostor := startBox(t)
	tok := real.issue(t)
	tok.Address = impostor.address
	_, err := Pair(context.Background(), laptop(t), tok, "alex-mbp")
	if err == nil || !strings.Contains(err.Error(), "does not match its pairing") {
		t.Fatalf("pairing with an impostor: %v", err)
	}
	tok.Address = real.address
	if _, err := Pair(context.Background(), laptop(t), tok, "alex-mbp"); err != nil {
		t.Fatalf("the code was spent on the impostor: %v", err)
	}
	// An established client refuses an impostor too.
	me := laptop(t)
	if _, err := Pair(context.Background(), me, real.issue(t), "x"); err != nil {
		t.Fatal(err)
	}
	peer := real.peer()
	peer.Address = impostor.address
	c := NewClient(me, peer)
	defer c.Reset()
	if _, err := c.Ping(context.Background()); err == nil || !strings.Contains(err.Error(), "does not match its pairing") {
		t.Fatalf("client pinged an impostor: %v", err)
	}
}

func exporterOf(t *testing.T, conn *tls.Conn) []byte {
	t.Helper()
	cs := conn.ConnectionState()
	exporter, err := cs.ExportKeyingMaterial(pairing.ExporterLabel, nil, pairing.ExporterSize)
	if err != nil {
		t.Fatal(err)
	}
	return exporter
}

// rawPair sends an arbitrary proof as id, for building attacks the real
// client would never produce.
func rawPair(t *testing.T, id *identity.Identity, b *box, proof func(exporter []byte) []byte) (int, errorResponse) {
	t.Helper()
	cfg := clientConfig(id, b.server.Identity.Fingerprint())
	cfg.NextProtos = []string{"http/1.1"}
	conn, err := dialTLS(context.Background(), cfg, b.address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	body, _ := json.Marshal(pairRequest{Name: "raw", Proof: proof(exporterOf(t, conn))})
	resp, err := exchange(context.Background(), conn, b.address, "/v1/pair", body)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var e errorResponse
	json.NewDecoder(resp.Body).Decode(&e)
	return resp.StatusCode, e
}

func TestAProofReplayedOnAnotherConnectionIsRejected(t *testing.T) {
	b := startBox(t)
	tok := b.issue(t)
	me := laptop(t)
	cfg := clientConfig(me, tok.Fingerprint)
	cfg.NextProtos = []string{"http/1.1"}
	conn, err := dialTLS(context.Background(), cfg, b.address)
	if err != nil {
		t.Fatal(err)
	}
	captured := pairing.Proof(tok.Code, exporterOf(t, conn), me.Fingerprint())
	conn.Close()
	if status, _ := rawPair(t, me, b, func([]byte) []byte { return captured }); status == http.StatusOK {
		t.Fatal("a proof from another session was accepted")
	}
}

func TestAProofForAnotherKeyIsRejected(t *testing.T) {
	b := startBox(t)
	tok := b.issue(t)
	victim := laptop(t)
	attacker := laptop(t)
	status, _ := rawPair(t, attacker, b, func(exporter []byte) []byte {
		return pairing.Proof(tok.Code, exporter, victim.Fingerprint())
	})
	if status == http.StatusOK {
		t.Fatal("a proof naming another key pinned the presenting key")
	}
	if _, ok, _ := b.server.Clients.Trusted(attacker.Fingerprint()); ok {
		t.Fatal("attacker was pinned")
	}
}

func TestRejectionsDoNotRevealWhy(t *testing.T) {
	b := startBox(t)
	used := b.issue(t)
	if _, err := Pair(context.Background(), laptop(t), used, "first"); err != nil {
		t.Fatal(err)
	}
	var wrong pairing.Code
	for name, proof := range map[string]func([]byte) []byte{
		"used code": func(e []byte) []byte { return pairing.Proof(used.Code, e, identity.Fingerprint{}) },
		"unknown":   func(e []byte) []byte { return pairing.Proof(wrong, e, identity.Fingerprint{}) },
		"no proof":  func([]byte) []byte { return nil },
	} {
		status, e := rawPair(t, laptop(t), b, proof)
		if status != http.StatusForbidden || e.Error != errPairingRejected {
			t.Fatalf("%s: got %d %+v, want the generic rejection", name, status, e)
		}
	}
}

func TestPairingAttemptsAreRateLimited(t *testing.T) {
	b := startBox(t)
	var limited bool
	for range 15 {
		status, _ := rawPair(t, laptop(t), b, func([]byte) []byte { return nil })
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("15 rapid pairing attempts were never rate limited")
	}
	b.server.pairLimit = newPairLimiter()
	c := paired(t, b)
	b.server.pairLimit = &pairLimiter{perIP: map[string]*limiter{}, global: newLimiter(0, 0), maxPeers: 1}
	if _, err := c.Ping(context.Background()); err != nil {
		t.Fatalf("an exhausted pairing limit blocked a paired laptop: %v", err)
	}
}

// One source's failures must not lock out another, and successful pairings
// are not charged (security audit L-7).
func TestPairingLimitIsPerSourceAndChargesOnlyFailures(t *testing.T) {
	now := time.Now()
	p := newPairLimiter()
	for range 10 {
		if !p.allow("100.64.0.9", now) {
			t.Fatal("limited before the burst was spent")
		}
	}
	if p.allow("100.64.0.9", now) {
		t.Fatal("a noisy source was never limited")
	}
	if !p.allow("100.64.0.2", now) {
		t.Fatal("one source's failures locked out another")
	}
	// Successes are refunded: any number of them never runs a source dry.
	for range 50 {
		if !p.allow("100.64.0.3", now) {
			t.Fatal("successful pairings were charged")
		}
		p.refund("100.64.0.3")
	}
	// The global backstop still bounds many sources together.
	limited := false
	for i := range 200 {
		if !p.allow(fmt.Sprintf("10.0.%d.%d", i/250, i%250), now) {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("no global backstop")
	}
}

// Ten bogus attempts from one peer must not stop the owner pairing with a
// real code (the audit's PoC TestPairingLockout).
func TestBogusAttemptsDoNotLockOutTheOwner(t *testing.T) {
	b := startBox(t)
	for range 10 {
		rawPair(t, laptop(t), b, func([]byte) []byte { return nil })
	}
	// Both come from 127.0.0.1 here, so give the owner its own source the
	// way a second machine would have.
	b.server.pairLimit.mu.Lock()
	delete(b.server.pairLimit.perIP, "127.0.0.1")
	b.server.pairLimit.mu.Unlock()
	if _, err := Pair(context.Background(), laptop(t), b.issue(t), "owner"); err != nil {
		t.Fatalf("owner pairing after bogus attempts: %v", err)
	}
}

// A failed attempt with no code pending must not rewrite pairing.json.
func TestFailedPairingWithNothingPendingWritesNothing(t *testing.T) {
	b := startBox(t)
	rawPair(t, laptop(t), b, func([]byte) []byte { return nil })
	if _, err := os.Stat(filepath.Join(b.dir, "pairing.json")); !os.IsNotExist(err) {
		t.Fatalf("pairing.json written for a stranger: %v", err)
	}
}

// Revoking a laptop ends the streams it already has open (security audit
// L-2; the audit's PoC TestRevokeKeepsOpenStreams).
func TestRevokeClosesOpenStreams(t *testing.T) {
	// The daemon looks on its own, and berthd revoke tells it at once.
	t.Run("noticed", func(t *testing.T) {
		testRevokeClosesOpenStreams(t, 50*time.Millisecond, false)
	})
	t.Run("told", func(t *testing.T) {
		testRevokeClosesOpenStreams(t, time.Hour, true)
	})
}

func testRevokeClosesOpenStreams(t *testing.T, every time.Duration, tell bool) {
	b := startBoxWith(t, func(s *Server) { s.RevokeCheck = every })
	c := paired(t, b)
	port, _ := startEcho(t)
	conn, err := c.DialPort(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.Write([]byte("hi\n"))
	buf := make([]byte, 3)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if _, err := b.server.Clients.Remove("alex-mbp"); err != nil {
		t.Fatal(err)
	}
	if tell {
		b.server.ClientsChanged()
	}
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	conn.Write([]byte("still here\n"))
	got, err := io.ReadAll(conn)
	if err == nil && strings.Contains(string(got), "still here") {
		t.Fatalf("revoked laptop's stream still echoes: %q", got)
	}
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("revoked laptop's stream was left open")
	}
}

func TestRevokedLaptopCanNoLongerPing(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	if _, err := b.server.Clients.Remove("alex-mbp"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Ping(context.Background()); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("revoked laptop ping: %v", err)
	}
}

func TestAnUnreadableTrustStoreAuthorizesNobody(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	if err := os.WriteFile(filepath.Join(b.dir, "clients.json"), []byte("{corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Ping(context.Background()); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("a corrupt trust store still authorized a laptop: %v", err)
	}
}

func TestOversizedPairingBodyIsRejectedAndTheServerKeepsServing(t *testing.T) {
	b := startBox(t)
	me := laptop(t)
	cfg := clientConfig(me, b.server.Identity.Fingerprint())
	cfg.NextProtos = []string{"http/1.1"}
	conn, err := dialTLS(context.Background(), cfg, b.address)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := exchange(context.Background(), conn, b.address, "/v1/pair", bytes.Repeat([]byte("a"), maxPairBody*4))
	if err == nil {
		if resp.StatusCode == http.StatusOK {
			t.Fatal("an oversized pairing request succeeded")
		}
		resp.Body.Close()
	}
	conn.Close()
	if _, err := Pair(context.Background(), me, b.issue(t), "alex-mbp"); err != nil {
		t.Fatalf("server stopped serving after an oversized request: %v", err)
	}
}

func TestAClientWithoutACertificateGetsNoReply(t *testing.T) {
	b := startBox(t)
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13}}
	defer transport.CloseIdleConnections()
	resp, err := (&http.Client{Transport: transport, Timeout: 5 * time.Second}).Get("https://" + b.address + "/v1/ping")
	if err == nil {
		resp.Body.Close()
		t.Fatalf("a certificate-less client got %s", resp.Status)
	}
}

// startEcho runs a TCP server on the loopback that echoes each connection
// until its client half-closes, and counts connections that have finished.
func startEcho(t *testing.T) (port int, closed *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	closed = new(atomic.Int32)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer closed.Add(1)
				defer c.Close()
				io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, closed
}

func TestStreamEchoesAndHalfCloses(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	port, _ := startEcho(t)
	conn, err := c.DialPort(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hello box")); err != nil {
		t.Fatal(err)
	}
	// Half-closing must reach the upstream as EOF, and the echo must still
	// arrive afterwards.
	if err := conn.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(conn)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello box" {
		t.Fatalf("echo = %q", got)
	}
}

func TestLargeTransferArrivesIntact(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	port, _ := startEcho(t)
	conn, err := c.DialPort(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	payload := make([]byte, 8<<20)
	rand.Read(payload)
	go func() {
		conn.Write(payload)
		conn.(interface{ CloseWrite() error }).CloseWrite()
	}()
	h := sha256.New()
	n, err := io.Copy(h, conn)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(payload)
	if n != int64(len(payload)) || !bytes.Equal(h.Sum(nil), want[:]) {
		t.Fatalf("received %d bytes with a different hash; want %d intact", n, len(payload))
	}
}

func TestConcurrentStreamsShareOneConnection(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	port, _ := startEcho(t)
	if _, err := c.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := b.accepted.Load()
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := c.DialPort(context.Background(), port)
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			msg := bytes.Repeat([]byte{byte('a' + i)}, 1000)
			conn.Write(msg)
			buf := make([]byte, len(msg))
			if _, err := io.ReadFull(conn, buf); err != nil || !bytes.Equal(buf, msg) {
				t.Errorf("stream %d: echo mismatch (%v)", i, err)
			}
		}()
	}
	wg.Wait()
	if extra := b.accepted.Load() - before; extra != 0 {
		t.Fatalf("20 streams opened %d extra TCP connections; want them multiplexed on one", extra)
	}
}

func TestClosingAStreamReleasesTheUpstreamConnection(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	port, closed := startEcho(t)
	conn, err := c.DialPort(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	conn.Write([]byte("x"))
	io.ReadFull(conn, make([]byte, 1))
	conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	for closed.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("closing the stream left the box's upstream connection open")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestClosingAStreamReleasesASilentUpstream(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	// This upstream never reads, writes, or closes, so nothing but the
	// stream reset can end the box's side of the connection.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	held := make(chan net.Conn, 1)
	go func() {
		if conn, err := ln.Accept(); err == nil {
			held <- conn
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		select {
		case conn := <-held:
			conn.Close()
		default:
		}
	})
	conn, err := c.DialPort(context.Background(), ln.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatal(err)
	}
	if b.server.ActiveStreams() != 1 {
		t.Fatalf("active streams = %d, want 1", b.server.ActiveStreams())
	}
	conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	for b.server.ActiveStreams() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("closing the stream left the box holding a silent upstream open")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDialPortReportsAClosedPortAndInvalidPorts(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	free := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	if _, err := c.DialPort(context.Background(), free); err == nil || !strings.Contains(err.Error(), "nothing is listening") {
		t.Fatalf("dial to a closed port: %v", err)
	}
	for _, port := range []int{0, -1, 70000} {
		if _, err := c.DialPort(context.Background(), port); err == nil {
			t.Fatalf("dial to invalid port %d succeeded", port)
		}
	}
}

func TestAnUnpairedLaptopCannotOpenStreams(t *testing.T) {
	b := startBox(t)
	port, _ := startEcho(t)
	c := NewClient(laptop(t), b.peer())
	defer c.Reset()
	if _, err := c.DialPort(context.Background(), port); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("unpaired stream: %v", err)
	}
}

func TestHandleRoutesRequireAPairedLaptopAndSeeWhoItIs(t *testing.T) {
	b := startBox(t)
	b.server.Handle("GET /v1/whoami", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, nameResponse{Name: PeerFrom(r.Context()).Name})
	}))
	stranger := NewClient(laptop(t), b.peer())
	defer stranger.Reset()
	if _, err := stranger.Do(context.Background(), http.MethodGet, "/v1/whoami", nil); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("unpaired laptop reached a mounted route: %v", err)
	}
	c := paired(t, b)
	resp, err := c.Do(context.Background(), http.MethodGet, "/v1/whoami", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out nameResponse
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Name != "alex-mbp" {
		t.Fatalf("route saw peer %q, want alex-mbp", out.Name)
	}
}

func TestResetMovesNewStreamsToAFreshConnectionWithoutBreakingOpenOnes(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)
	port, _ := startEcho(t)
	open, err := c.DialPort(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer open.Close()
	before := b.accepted.Load()
	c.Reset()
	fresh, err := c.DialPort(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if b.accepted.Load() != before+1 {
		t.Fatalf("after Reset, a new stream reused the old connection (accepted %d → %d)", before, b.accepted.Load())
	}
	for name, conn := range map[string]net.Conn{"stream opened before Reset": open, "stream opened after Reset": fresh} {
		conn.Write([]byte("ok"))
		buf := make([]byte, 2)
		if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "ok" {
			t.Fatalf("%s stopped working: %q %v", name, buf, err)
		}
	}
}

func TestServeLocalOffersMountedRoutesButNotStreamsOrPairing(t *testing.T) {
	b := startBox(t)
	b.server.Handle("GET /v1/whoami", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, nameResponse{Name: PeerFrom(r.Context()).Name})
	}))
	dir, err := os.MkdirTemp("/tmp", "cpw")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "d.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go b.server.ServeLocal(ctx, ln)
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	resp, err := client.Get("http://box/v1/whoami")
	if err != nil {
		t.Fatal(err)
	}
	var out nameResponse
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out.Name != "local" {
		t.Fatalf("local caller seen as %q", out.Name)
	}
	b.server.Handle("GET /v1/islocal", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, IsLocal(r.Context()))
	}))
	if resp, err := client.Get("http://box/v1/islocal"); err != nil {
		t.Fatal(err)
	} else {
		var local bool
		json.NewDecoder(resp.Body).Decode(&local)
		resp.Body.Close()
		if !local {
			t.Fatal("the box's own socket is not IsLocal")
		}
	}
	for _, path := range []string{"/v1/tcp?port=1", "/v1/pair"} {
		resp, err := client.Post("http://box"+path, "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s over the local socket: %s, want 404", path, resp.Status)
		}
	}
}

func TestClientsAndPairingUseTheGivenDialer(t *testing.T) {
	b := startBox(t)
	var dials atomic.Int32
	via := func(ctx context.Context, network, addr string) (net.Conn, error) {
		dials.Add(1)
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
	me := laptop(t)
	if _, err := PairVia(context.Background(), me, b.issue(t), "alex-mbp", via); err != nil {
		t.Fatal(err)
	}
	if dials.Load() != 1 {
		t.Fatalf("pairing dialed %d times through the given dialer, want 1", dials.Load())
	}
	c := NewClientVia(me, b.peer(), via)
	defer c.Reset()
	if _, err := c.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	if dials.Load() != 2 {
		t.Fatalf("client dialed %d times through the given dialer, want 2", dials.Load())
	}
}

func TestUnsentTellsAClosedBoxFromADroppedRequest(t *testing.T) {
	b := startBox(t)
	c := paired(t, b)

	// Nothing listens at the address: the request never left.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := ln.Addr().String()
	ln.Close()
	peer := b.peer()
	peer.Address = closed
	gone := NewClient(laptop(t), peer)
	defer gone.Reset()
	_, err = gone.Do(context.Background(), http.MethodGet, "/v1/ping", nil)
	if err == nil || !Unsent(err) {
		t.Fatalf("dialing a closed port: err %v, Unsent %v; want an unsent error", err, Unsent(err))
	}

	// The box takes the request, then the connection drops: it may have acted.
	b.server.Handle("POST /v1/drop", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		conn, _, err := http.NewResponseController(w).Hijack()
		if err == nil {
			conn.Close()
			return
		}
		panic(http.ErrAbortHandler)
	}))
	_, err = c.Do(context.Background(), http.MethodPost, "/v1/drop", strings.NewReader("hello"))
	if err == nil || Unsent(err) {
		t.Fatalf("a request dropped after it arrived: err %v, Unsent %v; want a sent (uncertain) error", err, Unsent(err))
	}

	if Unsent(nil) || Unsent(ErrUntrusted) {
		t.Fatal("nil and ErrUntrusted are not unsent")
	}
}

// A laptop that asks to pair as "local" is renamed, and is never IsLocal
// (security audit I-5).
func TestALaptopCannotPairAsLocal(t *testing.T) {
	b := startBox(t)
	b.server.Handle("GET /v1/whoami", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"name": PeerFrom(r.Context()).Name, "local": IsLocal(r.Context())})
	}))
	me := laptop(t)
	if _, err := Pair(context.Background(), me, b.issue(t), "local"); err != nil {
		t.Fatal(err)
	}
	c := NewClient(me, b.peer())
	defer c.Reset()
	resp, err := c.Do(context.Background(), http.MethodGet, "/v1/whoami", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Name  string
		Local bool
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Name == "local" || out.Local {
		t.Fatalf("remote laptop seen as %+v", out)
	}
}
