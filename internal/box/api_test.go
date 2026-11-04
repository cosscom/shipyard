package box

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/identity"
	"github.com/cosscom/shipyard/internal/pairing"
	"github.com/cosscom/shipyard/internal/terminal"
	"github.com/cosscom/shipyard/internal/trust"
	"github.com/cosscom/shipyard/internal/wire"
)

// servedBox runs berthd's server with the box routes mounted and returns a
// client for a laptop paired with it.
func servedBox(t *testing.T, opts ...func(*Box)) (*wire.Client, *events.Bus) {
	t.Helper()
	dir := t.TempDir()
	id, err := identity.LoadOrCreate(filepath.Join(dir, "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	srv := &wire.Server{
		Identity: id,
		Clients:  trust.NewStore(filepath.Join(dir, "clients.json")),
		Pending:  pairing.NewPending(filepath.Join(dir, "pairing.json")),
		Name:     "devbox",
	}
	sessions := testSessions(t)
	bus := &events.Bus{Sequence: true}
	units := &Units{Dir: filepath.Join(dir, "units")}
	units.svc, _ = fakeService() // never install a real unit from a test
	bx := &Box{Name: "devbox", Locations: NewLocations(filepath.Join(dir, "locations.json")), Sessions: sessions, Shares: &Shares{}, Units: units, Events: bus}
	for _, opt := range opts {
		opt(bx)
	}
	bx.Mount(srv)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go srv.Serve(ctx, ln)

	me, err := identity.LoadOrCreate(filepath.Join(t.TempDir(), "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	code, _ := srv.Pending.Issue(time.Minute, time.Now())
	tok := pairing.Token{Address: ln.Addr().String(), Fingerprint: id.Fingerprint(), Code: code}
	if _, err := wire.Pair(context.Background(), me, tok, "laptop"); err != nil {
		t.Fatal(err)
	}
	c := wire.NewClient(me, trust.Peer{Name: "devbox", Address: tok.Address, Fingerprint: tok.Fingerprint})
	t.Cleanup(c.Reset)
	return c, bus
}

func call(t *testing.T, c *wire.Client, method, path, origin string, in, out any) int {
	t.Helper()
	var body io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		body = bytes.NewReader(b)
	}
	ctx := context.Background()
	req := func() (*http.Response, error) {
		if origin == "" {
			return c.Do(ctx, method, path, body)
		}
		return c.DoWithHeader(ctx, method, path, body, http.Header{OriginHeader: {origin}})
	}
	resp, err := req()
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

func TestLocationsWorktreesSessionsAndAttachOverTheWire(t *testing.T) {
	c, bus := servedBox(t)
	seen, stop := bus.Subscribe()
	defer stop()
	repo := gitRepo(t)

	var loc Location
	if status := call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "cal", "path": repo}, &loc); status != 200 || !loc.Repo {
		t.Fatalf("add location: %d %+v", status, loc)
	}
	var wt Worktree
	if status := call(t, c, "POST", "/v1/locations/cal/worktrees", "orca", WorktreeRequest{Name: "billing"}, &wt); status != 200 || wt.Name != "billing" {
		t.Fatalf("add worktree: %d %+v", status, wt)
	}
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "cal/billing", "command": "cat"}, &sess); status != 200 {
		t.Fatalf("add session: %d", status)
	}
	if sess.Location != "cal/billing" || !strings.HasPrefix(sess.Name, "cal-billing-cat-") {
		t.Fatalf("session = %+v", sess)
	}

	// Attach, type, see the echo, detach.
	conn, err := c.OpenStream(context.Background(), "/v1/sessions/"+sess.Name+"/attach?cols=100&rows=30", "attach")
	if err != nil {
		t.Fatal(err)
	}
	var screen syncBuffer
	done := make(chan struct{})
	go func() { io.Copy(&screen, conn); close(done) }()
	time.Sleep(300 * time.Millisecond)
	terminal.WriteResize(conn, 120, 40)
	terminal.WriteData(conn, []byte("hello-over-the-wire\r"))
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(screen.String(), "hello-over-the-wire") {
		if time.Now().After(deadline) {
			t.Fatalf("keystrokes never came back; screen %q", screen.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	conn.Close()
	<-done

	var all []Session
	call(t, c, "GET", "/v1/sessions", "", nil, &all)
	if len(all) != 1 || all[0].Exited {
		t.Fatalf("detaching ended the session: %+v", all)
	}
	if status := call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil); status != 200 {
		t.Fatalf("kill session: %d", status)
	}

	want := map[string]string{"location.added": "berth", "worktree.created": "orca", "session.started": "berth", "session.stopped": "berth"}
	deadline = time.Now().Add(3 * time.Second)
	for len(want) > 0 && time.Now().Before(deadline) {
		select {
		case e := <-seen:
			if origin, ok := want[e.Type]; ok {
				if e.Origin != origin || e.Box != "devbox" {
					t.Errorf("%s: origin %q box %q, want origin %q", e.Type, e.Origin, e.Box, origin)
				}
				delete(want, e.Type)
			}
		case <-time.After(100 * time.Millisecond):
		}
	}
	if len(want) > 0 {
		t.Fatalf("events never published: %v", want)
	}
}

func TestErrorsMapToStatuses(t *testing.T) {
	c, _ := servedBox(t)
	for _, tc := range []struct {
		method, path string
		body         any
		want         int
	}{
		{"DELETE", "/v1/locations/nope", nil, 404},
		{"POST", "/v1/sessions", map[string]string{"location": "nope"}, 404},
		{"DELETE", "/v1/shares/nope", nil, 404},
		{"POST", "/v1/events", map[string]string{"type": "Not An Event"}, 400},
		{"POST", "/v1/locations", "not an object", 400},
	} {
		if got := call(t, c, tc.method, tc.path, "", tc.body, nil); got != tc.want {
			t.Errorf("%s %s = %d, want %d", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestUnitRoutesInstallListAndRemove(t *testing.T) {
	wc, _ := servedBox(t)
	c := NewClient(wc)
	ctx := context.Background()

	got, err := c.AddUnit(ctx, UnitRequest{Name: "berth-probe", Program: "/bin/sh", Args: []string{"-c", "true"}})
	if err != nil || got.Name != "berth-probe" {
		t.Fatalf("AddUnit() = %+v, %v", got, err)
	}
	all, err := c.Units(ctx)
	if err != nil || len(all) != 1 {
		t.Fatalf("Units() = %+v, %v; want one unit", all, err)
	}
	if _, err := c.RemoveUnit(ctx, "berth-probe"); err != nil {
		t.Fatalf("RemoveUnit() = %v", err)
	}
}

func TestUnitRoutesReportAMissingUnitAsNotFound(t *testing.T) {
	wc, _ := servedBox(t)
	if _, err := NewClient(wc).Unit(context.Background(), "berth-missing"); err == nil {
		t.Fatal("Unit() on a missing unit succeeded; want an error")
	}
}

func TestUnitLogRoundTripsArbitraryBytes(t *testing.T) {
	wc, _ := servedBox(t)
	c := NewClient(wc)
	ctx := context.Background()
	unit, err := c.AddUnit(ctx, UnitRequest{Name: "berth-probe", Program: "/bin/sh", Args: []string{"-c", "true"}})
	if err != nil {
		t.Fatal(err)
	}
	// Invalid UTF-8, an embedded NUL, and a newline: a string would mangle
	// the first, truncate at the second, and a naive line reader would split
	// on the third.
	want := []byte("before\xff\xfe\x00after\ncredential=s3cr3t")
	if err := os.WriteFile(unit.LogPath, want, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := c.UnitLog(ctx, "berth-probe", 1<<20)
	if err != nil {
		t.Fatalf("UnitLog() = %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("UnitLog() = %q, want %q", got, want)
	}
}

func TestEmittedEventsReachTheStream(t *testing.T) {
	c, _ := servedBox(t)
	resp, err := c.Do(context.Background(), "GET", "/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	lines := make(chan string, 8)
	go func() {
		s := bufio.NewScanner(resp.Body)
		for s.Scan() {
			lines <- s.Text()
		}
	}()
	time.Sleep(100 * time.Millisecond)
	if status := call(t, c, "POST", "/v1/events", "cursor", map[string]any{"type": "agent.finished", "data": map[string]any{"path": "/w"}}, nil); status != 200 {
		t.Fatalf("emit: %d", status)
	}
	select {
	case line := <-lines:
		var e events.Event
		json.Unmarshal([]byte(line), &e)
		if e.Type != "agent.finished" || e.Origin != "cursor" || e.Data["path"] != "/w" {
			t.Fatalf("streamed event = %+v", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("emitted event never reached the stream")
	}
}

func TestEmptyListsAreArraysNotNull(t *testing.T) {
	rec := httptest.NewRecorder()
	var none []Service
	writeJSON(rec, none)
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Fatalf("empty list = %s", got)
	}
}

func TestArchivingAnswersInJSONAndRemovalStopsTheWorktreesSessions(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	c, bus := servedBox(t)
	seen, stop := bus.Subscribe()
	defer stop()
	repo := gitRepo(t)
	if status := call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "cal", "path": repo}, nil); status != 200 {
		t.Fatalf("add location: %d", status)
	}
	for _, name := range []string{"billing", "keep"} {
		if status := call(t, c, "POST", "/v1/locations/cal/worktrees", "", WorktreeRequest{Name: name}, nil); status != 200 {
			t.Fatalf("add worktree %s: %d", name, status)
		}
	}
	var in, other Session
	call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "cal/billing", "command": "cat"}, &in)
	call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "cal/keep", "command": "cat"}, &other)
	if status := call(t, c, "PUT", "/v1/locations/cal/scripts", "", map[string]string{"archive": "true"}, nil); status != 200 {
		t.Fatalf("set scripts: %d", status)
	}

	resp, err := c.Do(context.Background(), "DELETE", "/v1/locations/cal/worktrees/billing", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]string
	json.NewDecoder(resp.Body).Decode(&body)
	// A 202 is still JSON: the app reads "archive" to know it is not gone yet.
	if resp.StatusCode != 202 || resp.Header.Get("Content-Type") != "application/json" || body["archive"] != "true" {
		t.Fatalf("archive answered %d %q %v", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	waitFor(t, seen, "worktree.removed")
	var all []Session
	call(t, c, "GET", "/v1/sessions", "", nil, &all)
	names := map[string]bool{}
	for _, s := range all {
		names[s.Name] = true
	}
	if names[in.Name] || !names[other.Name] {
		t.Fatalf("after removing billing, sessions = %v; want %s gone and %s kept", names, in.Name, other.Name)
	}
}

// Asked twice while its archive script runs, a worktree is archived once:
// the second ask is answered 202 too, and joins the first.
func TestAWorktreeOnItsWayOutIsNotArchivedTwice(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	c, bus := servedBox(t)
	seen, stop := bus.Subscribe()
	defer stop()
	repo := gitRepo(t)
	count := filepath.Join(t.TempDir(), "archived")
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "cal", "path": repo}, nil)
	call(t, c, "POST", "/v1/locations/cal/worktrees", "", WorktreeRequest{Name: "billing"}, nil)
	call(t, c, "PUT", "/v1/locations/cal/scripts", "", map[string]string{"archive": "echo run >> " + shellQuote(count) + "; sleep 1"}, nil)
	for i := range 2 {
		var body map[string]string
		if status := call(t, c, "DELETE", "/v1/locations/cal/worktrees/billing", "", nil, &body); status != 202 {
			t.Fatalf("ask %d answered %d %v", i+1, status, body)
		}
		if i == 0 {
			// The second ask comes while the first's script runs.
			waitFor(t, seen, "worktree.archive.started")
		}
	}
	waitFor(t, seen, "worktree.removed")
	time.Sleep(200 * time.Millisecond)
	if b, _ := os.ReadFile(count); strings.Count(string(b), "\n") != 1 {
		t.Fatalf("the archive script ran %d times", strings.Count(string(b), "\n"))
	}
}

// A worktree that gained uncommitted work while its archive script runs is
// refused when asked again, in git's words, rather than answered 202 for
// an archive that git will then refuse.
func TestAWorktreeAskedAgainIsCheckedForWorkFirst(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	c, bus := servedBox(t)
	seen, stop := bus.Subscribe()
	defer stop()
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "cal", "path": repo}, nil)
	var wt Worktree
	call(t, c, "POST", "/v1/locations/cal/worktrees", "", WorktreeRequest{Name: "billing"}, &wt)
	call(t, c, "PUT", "/v1/locations/cal/scripts", "", map[string]string{"archive": "sleep 1"}, nil)
	if status := call(t, c, "DELETE", "/v1/locations/cal/worktrees/billing", "", nil, nil); status != 202 {
		t.Fatalf("first ask answered %d", status)
	}
	waitFor(t, seen, "worktree.archive.started")
	os.WriteFile(filepath.Join(wt.Path, "notes.txt"), []byte("wip"), 0o600)
	var body map[string]string
	if status := call(t, c, "DELETE", "/v1/locations/cal/worktrees/billing", "", nil, &body); status == 202 || !strings.Contains(body["error"], "modified or untracked") {
		t.Fatalf("asked again with uncommitted work: %d %v", status, body)
	}
}

func TestHomeSessionStartsInTheUsersHomeAndNowhereElse(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	c, _ := servedBox(t)

	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"home": true, "command": "cat"}, &sess); status != 200 {
		t.Fatalf("add home session: %d", status)
	}
	if sess.Dir != home || sess.Location != "" || !strings.HasPrefix(sess.Name, "home-cat-") {
		t.Fatalf("session = %+v, want one in %s with no location", sess, home)
	}
	if sess.Agent != "" {
		t.Fatalf("a home shell is no agent: %+v", sess)
	}
	defer call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil)

	// Home is the only folder it takes: no location beside it, no agent,
	// and the box's own info says it can.
	for _, body := range []map[string]any{
		{"home": true, "location": "cal"},
		{"home": true, "agent": "claude"},
		{"home": true, "prompt": "do it"},
	} {
		var e struct{ Error string }
		if status := call(t, c, "POST", "/v1/sessions", "", body, &e); status != 400 {
			t.Errorf("%v = %d (%s), want 400", body, status, e.Error)
		}
	}
	bx := &Box{Events: &events.Bus{}}
	if caps := strings.Join(bx.Capabilities(), " "); !strings.Contains(caps, "session.home") {
		t.Errorf("capabilities %q lack session.home", caps)
	}
}
