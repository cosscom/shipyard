package box

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/transcript"
)

func TestThePhoneReadsAConversationWithoutItsPrivateParts(t *testing.T) {
	res := transcript.Result{
		Source: "claude", Next: 9, Gen: "g1", Reset: true, Start: 120, Last: 1700000000000, Truncated: true,
		File:      "/home/dev/.claude/projects/-home-dev-acme/0b1d.jsonl",
		Crew:      []transcript.CrewMember{{ID: "c1", Name: "Tally", Doing: "reading /home/dev/acme/secret.txt"}},
		Signals:   &transcript.Signals{},
		Artifacts: []transcript.Artifact{{URL: "https://claude.ai/artifact/xyz"}},
		Items: []transcript.Item{
			{Kind: "user", ID: "u1", Text: "Fix the acme checkout", UUID: "uuid-1", Parent: "uuid-0", Off: 10, MidTurn: true},
			{Kind: "text", ID: "t1", Text: "On it."},
			{Kind: "tools", ID: "g1", Verb: "Ran", Done: true, Items: []transcript.ToolCall{{Verb: "Run", Target: "pnpm test", ID: "toolu_secret", At: 5}}},
			{Kind: "edit", ID: "e1", File: "src/checkout.ts", Added: 3, Removed: 1, Tool: "toolu_edit"},
			{Kind: "command", ID: "c1", Command: "!", Args: "cat .env", Text: strings.Repeat("x", 5000)},
			{Kind: "artifact", ID: "a1", URL: "https://claude.ai/artifact/xyz", Local: "/home/dev/acme/report.html", Text: "Report"},
			{Kind: "question", ID: "q1", Questions: []transcript.Question{{Question: "Ship it?", Options: []transcript.Option{{Label: "Yes"}}, ID: "codex-q"}}, Answers: []string{"Yes"}, Done: true},
			{Kind: "agent-message", ID: "m1", Msg: &transcript.Message{From: transcript.Sender{ID: "s1", Name: "Helper", Kind: "helper", Helper: "c1", Color: "red"}, Body: "Done", Saved: "/tmp/report.md", Task: "task-1"}},
			{Kind: "report", ID: "r1", Report: &transcript.Report{Kind: "task", Status: "finished", Template: "fix", Title: "Fix checkout"}},
		},
	}
	raw, _ := json.Marshal(phoneTranscript(res))
	body := string(raw)
	for _, leak := range []string{"uuid-1", "uuid-0", "toolu_", "/home/dev", "claude.ai", "codex-q", "/tmp/report.md", "task-1", "\"helper\":\"c1\"", "red", "Tally", "\"template\"", "0b1d", "signals", "artifacts", "crew"} {
		if strings.Contains(body, leak) {
			t.Errorf("the phone's conversation has %q: %s", leak, body)
		}
	}
	var got phoneTranscriptResult
	json.Unmarshal(raw, &got)
	if len(got.Items) != 8 || got.Items[0].Text != "Fix the acme checkout" || !got.Items[0].MidTurn || got.Items[0].Off != 10 {
		t.Fatalf("items: %+v", got.Items)
	}
	if got.Next != 9 || got.Gen != "g1" || !got.Reset || got.Start != 120 || got.Record == "" {
		t.Fatalf("where to read on from: %+v", got)
	}
	if cmd := got.Items[4]; len(cmd.Text) > maxPhoneCommandText+len("…") || cmd.Args != "cat .env" {
		t.Fatalf("a command's output is %d bytes", len(cmd.Text))
	}
	if q := got.Items[5]; q.Kind != "question" || q.Questions[0].Options[0].Label != "Yes" || q.Answers[0] != "Yes" {
		t.Fatalf("question: %+v", q)
	}
	if m := got.Items[6].Msg; m == nil || m.From.Name != "Helper" || m.Body != "Done" {
		t.Fatalf("message: %+v", got.Items[6])
	}

	// A session with nothing to read says why without its folders.
	none := phoneTranscript(transcript.Result{Source: "none", Reason: "No claude conversation for /home/dev/acme since …"})
	if strings.Contains(none.Reason, "/home") || none.Items == nil {
		t.Fatalf("none: %+v", none)
	}
}

func TestThePhoneReadsASessionsConversation(t *testing.T) {
	var box *Box
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nexec sleep 600\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	c, _ := servedBox(t, func(b *Box) { box = b })
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "shop", "path": gitRepo(t)}, nil)
	call(t, c, "POST", "/v1/locations/shop/worktrees", "", WorktreeRequest{Name: "fix"}, nil)
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", SessionRequest{Location: "shop/fix", Command: "claude"}, &sess); status != 200 {
		t.Fatalf("session: %d", status)
	}
	proj := transcript.ClaudeDir(sess.Dir)
	os.MkdirAll(proj, 0o755)
	at := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	line, _ := json.Marshal(map[string]any{"type": "user", "timestamp": at, "uuid": "uuid-secret", "message": map[string]any{"role": "user", "content": "Fix the flaky acme test"}})
	os.WriteFile(filepath.Join(proj, "conv.jsonl"), append(line, '\n'), 0o600)

	p := &Phone{Path: filepath.Join(t.TempDir(), "phone.json")}
	p.save(PhoneConfig{Enabled: true, Token: "right-token"})
	h := p.Handler(box, phoneAddr)
	path := "/phone/v1/sessions/" + url.PathEscape(sess.Name) + "/transcript?since=0"
	w := phoneReq(t, h, "GET", path, phoneAddr, "right-token", "")
	var got phoneTranscriptResult
	json.Unmarshal(w.Body.Bytes(), &got)
	if w.Code != 200 || len(got.Items) != 1 || got.Items[0].Text != "Fix the flaky acme test" || strings.Contains(w.Body.String(), "uuid-secret") {
		t.Fatalf("transcript: %d %s", w.Code, w.Body)
	}
	if w := phoneReq(t, h, "GET", path, phoneAddr, "", ""); w.Code != 401 {
		t.Fatalf("without the token: %d", w.Code)
	}
	if w := phoneReq(t, h, "GET", path, "evil.example:1379", "right-token", ""); w.Code != 403 {
		t.Fatalf("another host: %d", w.Code)
	}
	if w := phoneReq(t, h, "GET", "/phone/v1/sessions/"+url.PathEscape(sess.Name)+"/transcript?before=10", phoneAddr, "right-token", ""); w.Code != 400 {
		t.Fatalf("an older page: %d", w.Code)
	}
}

func TestThePhonesNewRoutesStayInsideItsAPI(t *testing.T) {
	_, _, h := phoneBox(t)
	for _, path := range []string{"/phone/v1/sessions/x/transcript/tool/toolu_1", "/phone/v1/conversations", "/v1/events", "/phone/v1/push", "/v1/phone"} {
		if w := phoneReq(t, h, "GET", path, phoneAddr, "right-token", ""); w.Code < 400 {
			t.Errorf("GET %s answered %d", path, w.Code)
		}
	}
}

// phoneStream opens GET /phone/v1/events on a real listener, as the app
// does, and returns its lines.
func phoneStream(t *testing.T, h http.Handler, query string) (lines <-chan events.Event, status int, stop func()) {
	t.Helper()
	srv := httptest.NewServer(h)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/phone/v1/events"+query, nil)
	req.Host = phoneAddr
	req.Header.Set("Authorization", "Bearer right-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		srv.Close()
		t.Fatal(err)
	}
	ch := make(chan events.Event, 64)
	go func() {
		defer close(ch)
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			var e events.Event
			if json.Unmarshal(sc.Bytes(), &e) == nil {
				ch <- e
			}
		}
	}()
	return ch, resp.StatusCode, func() { cancel(); resp.Body.Close(); srv.Close() }
}

func nextEvent(t *testing.T, ch <-chan events.Event) events.Event {
	t.Helper()
	select {
	case e, ok := <-ch:
		if !ok {
			t.Fatal("the stream ended")
		}
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
	}
	return events.Event{}
}

func TestThePhoneEventStreamCarriesOnlyItsOwnEvents(t *testing.T) {
	b, _, h := phoneBox(t)
	ch, status, stop := phoneStream(t, h, "")
	defer stop()
	if status != 200 {
		t.Fatalf("stream: %d", status)
	}
	time.Sleep(100 * time.Millisecond)
	for _, e := range []events.Event{
		{Type: "worktree.login", Data: map[string]any{"email": "dev@acme.test", "path": "/home/dev/acme"}},
		{Type: "team.step", Data: map[string]any{"code": "ABCD-1234"}},
		{Type: "secret.failed", Data: map[string]any{"ref": "op://acme/key"}},
		{Type: "notify", Data: map[string]any{"title": "x", "body": "the agent's words"}},
		{Type: "agent.waiting", Data: map[string]any{"path": "/home/dev/acme", "session": "acme-fix", "agent": "claude", "reason": "permission", "tool_use_id": "toolu_1", "nested": map[string]any{"a": 1}}},
		{Type: events.TranscriptChanged, Data: map[string]any{"session": "acme-fix", "path": "/home/dev/acme"}},
		{Type: "session.sent", Data: map[string]any{"name": "acme-fix", "from": "laptop", "idem_key": "k"}},
		{Type: "run.gate", Data: map[string]any{"run": "r_1", "status": "waiting", "gate_title": "Ship it?", "path": "/home/dev/acme", "flow": "release"}},
	} {
		b.Events.Publish(e)
	}
	var got []events.Event
	for range 4 {
		got = append(got, nextEvent(t, ch))
	}
	raw, _ := json.Marshal(got)
	for _, leak := range []string{"email", "ABCD", "op://", "the agent's words", "/home/dev", "toolu_", "nested", "idem_key", "laptop", "release"} {
		if strings.Contains(string(raw), leak) {
			t.Errorf("the phone heard %q: %s", leak, raw)
		}
	}
	want := []string{"agent.waiting", "transcript.changed", "session.sent", "run.gate"}
	for i, e := range got {
		if e.Type != want[i] || e.Box != "devbox" || e.Origin != "" {
			t.Fatalf("event %d: %+v", i, e)
		}
	}
	if got[0].Data["session"] != "acme-fix" || got[0].Data["reason"] != "permission" || got[3].Data["gate_title"] != "Ship it?" {
		t.Fatalf("data: %s", raw)
	}
}

func TestThePhoneEventStreamReplaysAFewFromSince(t *testing.T) {
	j, err := events.OpenJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	b, _, h := phoneBox(t)
	b.Events = &events.Bus{Journal: j}
	for range maxPhoneReplay + 100 {
		b.Events.Publish(events.Event{Type: "session.renamed", Data: map[string]any{"name": "acme"}})
	}
	ch, _, stop := phoneStream(t, h, "?since=1")
	defer stop()
	if first := nextEvent(t, ch); first.Seq != b.Events.Head()-maxPhoneReplay+1 {
		t.Fatalf("replayed from %d, head %d", first.Seq, b.Events.Head())
	}
	ch2, _, stop2 := phoneStream(t, h, fmtSince(b.Events.Head()-2))
	defer stop2()
	if e := nextEvent(t, ch2); e.Seq != b.Events.Head()-1 {
		t.Fatalf("since head-2 began at %d", e.Seq)
	}
	if w := phoneReq(t, h, "GET", "/phone/v1/events?since=nope", phoneAddr, "right-token", ""); w.Code != 400 {
		t.Fatalf("a bad since: %d", w.Code)
	}
}

func fmtSince(n int64) string { b, _ := json.Marshal(n); return "?since=" + string(b) }

func TestPhoneStreamsAreCapped(t *testing.T) {
	_, _, h := phoneBox(t)
	var stops []func()
	defer func() {
		for _, s := range stops {
			s()
		}
	}()
	for range maxPhoneStreams {
		_, status, stop := phoneStream(t, h, "")
		stops = append(stops, stop)
		if status != 200 {
			t.Fatalf("stream: %d", status)
		}
	}
	_, status, stop := phoneStream(t, h, "")
	stop()
	if status != http.StatusTooManyRequests {
		t.Fatalf("one stream too many answered %d", status)
	}
	stops[0]()
	stops = stops[1:]
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, status, stop := phoneStream(t, h, "")
		stops = append(stops, stop)
		if status == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("a closed stream's place was never freed: %d", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestANewPhoneCodeEndsOpenStreams(t *testing.T) {
	dir := t.TempDir()
	c, _ := servedBox(t, func(b *Box) {
		b.Phone = &Phone{Path: filepath.Join(dir, "phone.json"), Addr: func() (string, error) { return "127.0.0.1", nil }, Port: freeTCPPort(t)}
	})
	var st PhoneStatus
	call(t, c, "PUT", "/v1/phone", "", map[string]any{"enabled": true}, &st)
	req, _ := http.NewRequest("GET", st.URL+"phone/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+st.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("stream: %v %v", err, resp)
	}
	done := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, resp.Body); done <- err }()
	call(t, c, "PUT", "/v1/phone", "", map[string]any{"rotate": true}, &st)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a stream on the old code is still open")
	}
}

const pushID = "0123456789abcdef0123456789abcdef"

func TestAPhoneRegistersForPushAndForgetsIt(t *testing.T) {
	dir := t.TempDir()
	var box *Box
	c, bus := servedBox(t, func(b *Box) {
		box = b
		b.Phone = &Phone{Path: filepath.Join(dir, "phone.json"), Addr: func() (string, error) { return "127.0.0.1", nil }, Port: freeTCPPort(t)}
	})
	var st PhoneStatus
	call(t, c, "PUT", "/v1/phone", "", map[string]any{"enabled": true}, &st)
	h := box.Phone.Handler(box, phoneAddr)
	added, stop := bus.Subscribe()
	defer stop()
	reg := func(id string, extra string) int {
		return phoneReq(t, h, "POST", "/phone/v1/push", phoneAddr, st.Token, `{"id":"`+id+`","name":"Acme iPhone","platform":"ios","key":"v1.k1.c2VhbGVk"`+extra+`}`).Code
	}
	if code := reg(pushID, ""); code != 200 {
		t.Fatalf("register: %d", code)
	}
	waitForEvent(t, added, "phone.push.added")
	call(t, c, "GET", "/v1/phone", "", nil, &st)
	if len(st.Push) != 1 || st.Push[0].Name != "Acme iPhone" || st.Push[0].Key != "" {
		t.Fatalf("a laptop sees %+v", st.Push)
	}
	if box.Phone.load().Push[0].Key != "v1.k1.c2VhbGVk" {
		t.Fatal("the key was not kept")
	}
	// The same phone again keeps one place.
	reg(pushID, `,"on":["waiting","finished"]`)
	if c := box.Phone.load(); len(c.Push) != 1 || len(c.Push[0].On) != 2 {
		t.Fatalf("registered twice: %+v", c.Push)
	}
	for _, bad := range []string{
		`{"id":"short","platform":"ios","key":"k"}`,
		`{"id":"` + pushID + `","platform":"windows","key":"k"}`,
		`{"id":"` + pushID + `","platform":"ios","key":"has spaces"}`,
		`{"id":"` + pushID + `","platform":"ios","key":"k","name":"` + strings.Repeat("n", 41) + `"}`,
		`{"id":"` + pushID + `","platform":"ios","key":"k","on":["always"]}`,
	} {
		if w := phoneReq(t, h, "POST", "/phone/v1/push", phoneAddr, st.Token, bad); w.Code != 400 {
			t.Errorf("%s: %d", bad, w.Code)
		}
	}
	// Only a laptop says where the box sends: a relay from the phone is
	// ignored.
	phoneReq(t, h, "POST", "/phone/v1/push", phoneAddr, st.Token, `{"id":"`+pushID+`","platform":"ios","key":"k","relay":"https://evil.example"}`)
	if c := box.Phone.load(); c.Relay != "" {
		t.Fatalf("the phone chose the relay: %q", c.Relay)
	}
	if w := phoneReq(t, h, "DELETE", "/phone/v1/push/"+pushID, phoneAddr, st.Token, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "true") {
		t.Fatalf("forget: %d %s", w.Code, w.Body)
	}
	if len(box.Phone.load().Push) != 0 {
		t.Fatal("still registered")
	}
	// A new code forgets every phone's notifications.
	reg(pushID, "")
	st = PhoneStatus{}
	if status := call(t, c, "PUT", "/v1/phone", "", map[string]any{"rotate": true}, &st); status != 200 {
		t.Fatalf("rotate: %d", status)
	}
	if len(st.Push) != 0 {
		t.Fatalf("after a new code: %+v", st.Push)
	}
	// And a laptop removes one by its id (the same handler: it reads the
	// token afresh).
	reg(pushID, "")
	if c := box.Phone.load(); len(c.Push) != 1 {
		t.Fatalf("registered after a new code: %+v", c.Push)
	}
	st = PhoneStatus{}
	call(t, c, "PUT", "/v1/phone", "", map[string]any{"remove_push": pushID}, &st)
	if len(st.Push) != 0 || len(box.Phone.load().Push) != 0 {
		t.Fatalf("after removing: %+v", st.Push)
	}
	if status := call(t, c, "PUT", "/v1/phone", "", map[string]any{"relay": "http://relay.example"}, nil); status != 400 {
		t.Fatalf("an http relay: %d", status)
	}
}

func TestPhonesPastTheLimitTakeTheOldestsPlace(t *testing.T) {
	_, p, h := phoneBox(t)
	for i := range maxPushPhones + 1 {
		id := strings.Repeat(string("0123456789abcdef"[i%16]), 31) + string("0123456789abcdef"[i/16])
		if w := phoneReq(t, h, "POST", "/phone/v1/push", phoneAddr, "right-token", `{"id":"`+id+`","platform":"ios","key":"k"}`); w.Code != 200 {
			t.Fatalf("register %d: %d %s", i, w.Code, w.Body)
		}
		time.Sleep(2 * time.Millisecond)
	}
	c := p.load()
	if len(c.Push) != maxPushPhones || c.Push[0].ID == strings.Repeat("0", 32) {
		t.Fatalf("%d phones, first %s", len(c.Push), c.Push[0].ID)
	}
}

func TestAPhoneRegistrationGoesThroughItsGate(t *testing.T) {
	b, _, h := phoneBox(t)
	cfg := filepath.Join(t.TempDir(), "hooks.json")
	os.WriteFile(cfg, []byte(`{"hooks":[{"on":"before:phone.push","run":"echo no phones here; exit 1"}]}`), 0o600)
	b.Hooks = &hooks.Runner{Path: cfg}
	w := phoneReq(t, h, "POST", "/phone/v1/push", phoneAddr, "right-token", `{"id":"`+pushID+`","platform":"ios","key":"k"}`)
	if w.Code != 403 || !strings.Contains(w.Body.String(), "no phones here") {
		t.Fatalf("register: %d %s", w.Code, w.Body)
	}
}

func waitForEvent(t *testing.T, ch <-chan events.Event, typ string) events.Event {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-ch:
			if e.Type == typ {
				return e
			}
		case <-deadline:
			t.Fatalf("no %s", typ)
		}
	}
}

// relayStub is a push relay that records what it is sent and answers code.
type relayStub struct {
	mu    sync.Mutex
	auth  []string
	sent  []relayNotice
	code  int
	calls int
}

func (s *relayStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	var n relayNotice
	json.NewDecoder(r.Body).Decode(&n)
	if r.URL.Path == "/v1/send" {
		s.auth = append(s.auth, r.Header.Get("Authorization"))
		s.sent = append(s.sent, n)
	}
	if s.code != 0 {
		w.WriteHeader(s.code)
		w.Write([]byte(`{"error":"gone"}`))
	}
}

func (s *relayStub) seen() ([]string, []relayNotice, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.auth...), append([]relayNotice(nil), s.sent...), s.calls
}

func TestAnAgentThatNeedsYouIsPushedThroughTheRelayAndNtfy(t *testing.T) {
	relay := &relayStub{}
	rs := httptest.NewServer(relay)
	defer rs.Close()
	ntfyHit := make(chan string, 4)
	ntfy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		ntfyHit <- string(b)
	}))
	defer ntfy.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b, p, _ := phoneBox(t)
	b.Flows = &Flows{AllowOutbound: []string{"127.0.0.1"}}
	p.save(PhoneConfig{Enabled: false, Token: "t", Relay: rs.URL, Notify: &PhoneNotify{URL: ntfy.URL + "/berth-topic"}, Push: []PhonePush{
		{ID: pushID, Platform: "ios", Key: "key-one", Name: "Acme iPhone"},
		{ID: strings.Repeat("f", 32), Platform: "ios", Key: "key-two", On: []string{"finished"}},
	}})
	repo := gitRepo(t)
	b.Locations.Add(ctx, "acme", repo)
	wt, _ := b.Locations.CreateWorktree(ctx, "acme", "checkout", "", "")
	go p.Run(ctx, b)
	time.Sleep(100 * time.Millisecond)
	b.Events.Publish(events.Event{Type: "agent.waiting", Data: map[string]any{"path": wt.Path, "agent": "claude", "text": "the agent's own words"}})
	select {
	case body := <-ntfyHit:
		if body != "acme/checkout on devbox" {
			t.Fatalf("ntfy got %q", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ntfy heard nothing")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		auth, sent, _ := relay.seen()
		if len(sent) == 1 {
			n := sent[0]
			if auth[0] != "Bearer key-one" || n.V != 1 || n.Kind != "session" || n.State != "waiting" || n.Title != "Claude Code needs you" || n.Body != "acme/checkout on devbox" || n.Box != "devbox" {
				t.Fatalf("the relay got %v %+v", auth, n)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the relay got %d notices", len(sent))
		}
		time.Sleep(20 * time.Millisecond)
	}
	// It went through, and the phone that only wanted "finished" heard
	// nothing.
	deadline = time.Now().Add(5 * time.Second)
	for p.load().Push[0].LastOK.IsZero() {
		if time.Now().After(deadline) {
			t.Fatalf("not noted: %+v", p.load().Push[0])
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, sent, _ := relay.seen(); len(sent) != 1 {
		t.Fatalf("%d notices", len(sent))
	}
}

func TestARelayThatSaysGoneForgetsThePhone(t *testing.T) {
	relay := &relayStub{code: http.StatusGone}
	rs := httptest.NewServer(relay)
	defer rs.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b, p, _ := phoneBox(t)
	b.Flows = &Flows{AllowOutbound: []string{"127.0.0.1"}}
	p.save(PhoneConfig{Enabled: false, Token: "t", Relay: rs.URL, Push: []PhonePush{{ID: pushID, Platform: "ios", Key: "old-key"}}})
	removed, stop := b.Events.Subscribe()
	defer stop()
	go p.Run(ctx, b)
	time.Sleep(100 * time.Millisecond)
	b.Events.Publish(events.Event{Type: "agent.waiting", Data: map[string]any{"session": "acme", "agent": "claude"}})
	e := waitForEvent(t, removed, "phone.push.removed")
	if e.Data["reason"] != "gone" || len(p.load().Push) != 0 {
		t.Fatalf("%+v %+v", e, p.load().Push)
	}
}

func TestARelayThatFailsIsTriedOnceMoreAndNoted(t *testing.T) {
	relay := &relayStub{code: http.StatusBadGateway}
	rs := httptest.NewServer(relay)
	defer rs.Close()
	b, p, _ := phoneBox(t)
	b.Flows = &Flows{AllowOutbound: []string{"127.0.0.1"}}
	p.save(PhoneConfig{Enabled: false, Token: "t", Relay: rs.URL, Push: []PhonePush{{ID: pushID, Platform: "ios", Key: "k"}}})
	p.notify(context.Background(), b, events.Event{Type: "agent.waiting", Data: map[string]any{"session": "acme"}})
	if _, _, calls := relay.seen(); calls != 2 {
		t.Fatalf("the relay was asked %d times", calls)
	}
	if d := p.load().Push[0]; !strings.Contains(d.LastError, "502") || !d.LastOK.IsZero() {
		t.Fatalf("noted %+v", d)
	}
}

func TestRelayPushesRefuseTheBoxsOwnLoopback(t *testing.T) {
	relay := &relayStub{}
	rs := httptest.NewServer(relay)
	defer rs.Close()
	b, p, _ := phoneBox(t)
	p.save(PhoneConfig{Enabled: false, Token: "t", Relay: rs.URL, Push: []PhonePush{{ID: pushID, Platform: "ios", Key: "k"}}})
	p.notify(context.Background(), b, events.Event{Type: "agent.waiting", Data: map[string]any{"session": "acme"}})
	if _, _, calls := relay.seen(); calls != 0 {
		t.Fatal("a push reached a loopback address nobody allowed")
	}
	if d := p.load().Push[0]; d.LastError == "" {
		t.Fatalf("the refusal was not noted: %+v", d)
	}
}

func TestThePhoneStopsAnAgentThroughTheSendGate(t *testing.T) {
	b, _, h := phoneBox(t)
	if _, err := b.Sessions.Create(context.Background(), "agent", "", t.TempDir(), "cat", nil); err != nil {
		t.Fatal(err)
	}
	if w := phoneReq(t, h, "POST", "/phone/v1/sessions/agent/interrupt", phoneAddr, "right-token", ""); w.Code != 200 {
		t.Fatalf("interrupt: %d %s", w.Code, w.Body)
	}
	cfg := filepath.Join(t.TempDir(), "hooks.json")
	os.WriteFile(cfg, []byte(`{"hooks":[{"on":"before:session.send","run":"test \"$BERTH_FROM\" = phone && { echo not from a phone; exit 1; }; exit 0"}]}`), 0o600)
	b.Hooks = &hooks.Runner{Path: cfg}
	w := phoneReq(t, h, "POST", "/phone/v1/sessions/agent/interrupt", phoneAddr, "right-token", "")
	if w.Code != 403 || !strings.Contains(w.Body.String(), "not from a phone") {
		t.Fatalf("gated interrupt: %d %s", w.Code, w.Body)
	}
	if w := phoneReq(t, h, "POST", "/phone/v1/sessions/nobody/interrupt", phoneAddr, "right-token", ""); w.Code != 404 {
		t.Fatalf("no such session: %d", w.Code)
	}
}

func TestPhoneInfoSaysWhatTheBoxOffers(t *testing.T) {
	_, _, h := phoneBox(t)
	var info struct {
		Box          string   `json:"box"`
		Version      int      `json:"version"`
		Capabilities []string `json:"capabilities"`
	}
	w := phoneReq(t, h, "GET", "/phone/v1/info", phoneAddr, "right-token", "")
	json.Unmarshal(w.Body.Bytes(), &info)
	if info.Box != "devbox" || info.Version != 2 || strings.Join(info.Capabilities, ",") != "transcript,events,push,interrupt" {
		t.Fatalf("info: %s", w.Body)
	}
}
