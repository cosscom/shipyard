package box

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/transcript"
)

// The Shipyard phone app's part of the phone API (version 2), beside the
// web app's: an agent's conversation, the box's events as they happen,
// notifications through the push relay, and stopping an agent. Each answer
// is built here field by field from what the phone may see, so a field
// added to a transcript item or an event reaches a phone only when someone
// adds it below too.

// DefaultPushRelay holds the notification service's keys (APNs, later FCM)
// and sends a phone what a box asks, without keeping anything (push/ in
// the repository).
const DefaultPushRelay = "https://push.berthd.app"

// phoneCapabilities are what this box's phone API offers past version 1.
var phoneCapabilities = []string{"transcript", "events", "push", "interrupt"}

// PhonePush is a phone app that asked for notifications.
type PhonePush struct {
	// ID is the app's install id: 32 random hex characters.
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
	Platform string `json:"platform"`
	// Key is what the relay gave the app: its sealed device token, which
	// only the relay can open. Laptops never see it.
	Key   string    `json:"key,omitempty"`
	On    []string  `json:"on,omitempty"`
	Added time.Time `json:"added"`
	// The last delivery: when one last went through, and what went wrong
	// with the last one that didn't.
	LastOK    time.Time `json:"last_ok,omitzero"`
	LastError string    `json:"last_error,omitempty"`
}

const (
	// maxPhoneStreams bounds the open event streams: a phone holds one per
	// box while its app is open.
	maxPhoneStreams = 16
	// maxPhoneReplay is the most past events a stream replays.
	maxPhoneReplay = 500
	// maxPushPhones is the most phone apps a box notifies; a new one past
	// it takes the oldest's place.
	maxPushPhones = 10
	// maxPhoneCommandText is the most of a command's output a phone reads.
	maxPhoneCommandText = 2 << 10
)

func (p *Phone) mountV2(api *http.ServeMux, b *Box) {
	api.HandleFunc("GET /phone/v1/sessions/{name}/transcript", func(w http.ResponseWriter, r *http.Request) {
		// The recent conversation only: no older pages, no tool's output.
		if r.URL.Query().Has("before") {
			writeError(w, http.StatusBadRequest, "older parts of a conversation aren't read on a phone")
			return
		}
		sess, all, err := b.Sessions.getWithAll(r.Context(), r.PathValue("name"))
		if err != nil {
			writeError(w, statusFor(err), err.Error())
			return
		}
		since, _ := strconv.Atoi(r.URL.Query().Get("since"))
		res, err := b.driverFor(sess).Conversation(r.Context(), sess, all, since, r.URL.Query().Get("gen"))
		if err != nil {
			writeError(w, statusFor(err), err.Error())
			return
		}
		writeJSON(w, phoneTranscript(res))
	})
	api.HandleFunc("GET /phone/v1/events", func(w http.ResponseWriter, r *http.Request) {
		p.streamEvents(w, r, b)
	})
	api.HandleFunc("POST /phone/v1/push", func(w http.ResponseWriter, r *http.Request) {
		if err := p.register(w, r, b); err != nil {
			writeError(w, statusFor(err), err.Error())
		}
	})
	api.HandleFunc("DELETE /phone/v1/push/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var gone *PhonePush
		_, err := p.update(func(c *PhoneConfig) error {
			c.Push = slices.DeleteFunc(c.Push, func(d PhonePush) bool {
				if d.ID == id {
					gone = &d
					return true
				}
				return false
			})
			return nil
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if gone != nil {
			b.Events.Publish(events.Event{Type: "phone.push.removed", Box: b.Name, Origin: "phone", Data: map[string]any{"name": gone.Name, "platform": gone.Platform}})
		}
		writeJSON(w, map[string]bool{"removed": gone != nil})
	})
	api.HandleFunc("POST /phone/v1/sessions/{name}/interrupt", func(w http.ResponseWriter, r *http.Request) {
		stopped, err := b.interrupt(r, r.PathValue("name"), "phone")
		if err != nil {
			writeError(w, statusFor(err), err.Error())
			return
		}
		writeJSON(w, map[string]bool{"sent": true, "stopped": stopped})
	})
}

// --- the conversation --------------------------------------------------------

// phoneTranscriptResult is transcript.Result as a phone reads it: the items
// and where to read on from, without the agent's mode, model and tasks, its
// published pages, or the record's name.
type phoneTranscriptResult struct {
	Source    string      `json:"source"`
	Items     []phoneItem `json:"items"`
	Next      int         `json:"next"`
	Truncated bool        `json:"truncated,omitempty"`
	Last      int64       `json:"last,omitempty"`
	Reason    string      `json:"reason,omitempty"`
	Gen       string      `json:"gen,omitempty"`
	Reset     bool        `json:"reset,omitempty"`
	Start     int64       `json:"start,omitempty"`
	// Record changes when the agent starts another conversation (/clear):
	// a hash of the record's name, never the name.
	Record string `json:"record,omitempty"`
}

// phoneItem is a transcript item as a phone reads it (the kinds and fields
// of app/src/lib/transcript.ts, less tool call ids, prompt ids and pages).
type phoneItem struct {
	Kind      string          `json:"kind"`
	ID        string          `json:"id"`
	Off       int64           `json:"off,omitempty"`
	MidTurn   bool            `json:"midTurn,omitempty"`
	Text      string          `json:"text,omitempty"`
	Verb      string          `json:"verb,omitempty"`
	Items     []phoneToolCall `json:"items,omitempty"`
	Done      bool            `json:"done,omitempty"`
	File      string          `json:"file,omitempty"`
	Added     int             `json:"added,omitempty"`
	Removed   int             `json:"removed,omitempty"`
	Names     []string        `json:"names,omitempty"`
	Notice    string          `json:"notice,omitempty"`
	Level     string          `json:"level,omitempty"`
	Resets    int64           `json:"resets,omitempty"`
	Command   string          `json:"command,omitempty"`
	Args      string          `json:"args,omitempty"`
	Markdown  bool            `json:"markdown,omitempty"`
	Error     bool            `json:"error,omitempty"`
	Questions []phoneQuestion `json:"questions,omitempty"`
	Answers   []string        `json:"answers,omitempty"`
	Report    *phoneReport    `json:"report,omitempty"`
	Msg       *phoneMessage   `json:"msg,omitempty"`
}

type phoneToolCall struct {
	Verb   string `json:"verb"`
	Target string `json:"target"`
	File   bool   `json:"file,omitempty"`
}

type phoneQuestion struct {
	Question string        `json:"question"`
	Header   string        `json:"header,omitempty"`
	Multi    bool          `json:"multi,omitempty"`
	Options  []phoneOption `json:"options"`
}

type phoneOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type phoneReport struct {
	Kind     string `json:"kind"`
	Session  string `json:"session,omitempty"`
	Run      string `json:"run,omitempty"`
	Title    string `json:"title,omitempty"`
	Worktree string `json:"worktree,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Status   string `json:"status"`
	Duration string `json:"duration,omitempty"`
	Files    int    `json:"files,omitempty"`
	Added    int    `json:"added,omitempty"`
	Removed  int    `json:"removed,omitempty"`
	Summary  string `json:"summary,omitempty"`
	Answer   string `json:"answer,omitempty"`
	Needs    string `json:"needs,omitempty"`
}

type phoneMessage struct {
	From     phoneSender `json:"from"`
	Intent   string      `json:"intent,omitempty"`
	Status   string      `json:"status,omitempty"`
	Title    string      `json:"title,omitempty"`
	Summary  string      `json:"summary,omitempty"`
	Body     string      `json:"body,omitempty"`
	Repeat   int         `json:"repeat,omitempty"`
	At       int64       `json:"at,omitempty"`
	Answered bool        `json:"answered,omitempty"`
}

type phoneSender struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// phoneItemKinds are the kinds a phone reads; an artifact (a page's link,
// a file on the box) is not one.
var phoneItemKinds = map[string]bool{
	"user": true, "text": true, "tools": true, "edit": true, "crew": true, "command": true, "notice": true,
	"question": true, "report": true, "agent-message": true, "ping": true,
}

func phoneTranscript(res transcript.Result) phoneTranscriptResult {
	out := phoneTranscriptResult{
		Source: res.Source, Items: []phoneItem{}, Next: res.Next, Truncated: res.Truncated, Last: res.Last,
		Gen: res.Gen, Reset: res.Reset, Start: res.Start,
	}
	if res.Source == "none" {
		// The box's reason names folders and files.
		out.Reason = "This agent's conversation can't be read here. Its screen shows where it is."
	}
	if res.File != "" {
		sum := sha256.Sum256([]byte(res.File))
		out.Record = hex.EncodeToString(sum[:8])
	}
	for _, it := range res.Items {
		if !phoneItemKinds[it.Kind] {
			continue
		}
		p := phoneItem{Kind: it.Kind, ID: it.ID, Off: it.Off, MidTurn: it.MidTurn}
		switch it.Kind {
		case "user", "text":
			p.Text = it.Text
		case "tools":
			p.Verb, p.Done = it.Verb, it.Done
			for _, c := range it.Items {
				p.Items = append(p.Items, phoneToolCall{Verb: c.Verb, Target: c.Target, File: c.File})
			}
		case "edit":
			p.File, p.Added, p.Removed = it.File, it.Added, it.Removed
		case "crew":
			p.Names = it.Names
		case "command":
			p.Command, p.Args, p.Markdown, p.Error = it.Command, it.Args, it.Markdown, it.Error
			p.Text = clipText(it.Text, maxPhoneCommandText)
		case "notice":
			p.Notice, p.Level, p.Resets, p.Text = it.Notice, it.Level, it.Resets, it.Text
		case "question":
			p.Done, p.Error, p.Answers = it.Done, it.Error, it.Answers
			for _, q := range it.Questions {
				pq := phoneQuestion{Question: q.Question, Header: q.Header, Multi: q.Multi, Options: []phoneOption{}}
				for _, o := range q.Options {
					pq.Options = append(pq.Options, phoneOption{Label: o.Label, Description: o.Description})
				}
				p.Questions = append(p.Questions, pq)
			}
		case "report":
			if r := it.Report; r != nil {
				p.Report = &phoneReport{
					Kind: r.Kind, Session: r.Session, Run: r.Run, Title: r.Title, Worktree: r.Worktree, Branch: r.Branch,
					Status: r.Status, Duration: r.Duration, Files: r.Files, Added: r.Added, Removed: r.Removed,
					Summary: r.Summary, Answer: r.Answer, Needs: r.Needs,
				}
			}
		case "agent-message", "ping":
			if m := it.Msg; m != nil {
				p.Msg = &phoneMessage{
					From: phoneSender{Name: m.From.Name, Kind: m.From.Kind}, Intent: m.Intent, Status: m.Status,
					Title: m.Title, Summary: m.Summary, Body: m.Body, Repeat: m.Repeat, At: m.At, Answered: m.Answered,
				}
			}
		}
		out.Items = append(out.Items, p)
	}
	return out
}

// clipText cuts s to at most n bytes, on a rune boundary.
func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "…"
}

// --- events ------------------------------------------------------------------

// sessionAt is the session working in a folder, as looked up at a time.
type sessionAt struct {
	name string
	at   time.Time
}

// sessionFor is the session working in dir, looked up at most every two
// seconds: every phone's stream asks for the same agent event at once.
func (p *Phone) sessionFor(ctx context.Context, b *Box, dir string) string {
	p.mu.Lock()
	if s, ok := p.where[dir]; ok && time.Since(s.at) < 2*time.Second {
		p.mu.Unlock()
		return s.name
	}
	p.mu.Unlock()
	name := b.sessionIn(ctx, dir)
	p.mu.Lock()
	if p.where == nil || len(p.where) > 256 {
		p.where = map[string]sessionAt{}
	}
	p.where[dir] = sessionAt{name, time.Now()}
	p.mu.Unlock()
	return name
}

// phoneEvent is an event as a phone hears it, if it hears it at all: that
// a session or a run changed, by name, never where (no paths) or what was
// said, and nothing about worktrees, hooks, secrets, logins or the rest.
func (p *Phone) phoneEvent(ctx context.Context, b *Box, e events.Event) (events.Event, bool) {
	keep := func(keys ...string) map[string]any {
		d := map[string]any{}
		for _, k := range keys {
			if v, ok := e.Data[k]; ok {
				switch v.(type) {
				case string, bool, float64, int, int64:
					d[k] = v
				}
			}
		}
		return d
	}
	var data map[string]any
	switch e.Type {
	case "agent.ready", "agent.started", "agent.waiting", "agent.finished", "agent.exited":
		data = keep("session", "agent", "reason", "status")
		if _, ok := data["session"]; !ok {
			if path, _ := e.Data["path"].(string); path != "" {
				if name := p.sessionFor(ctx, b, path); name != "" {
					data["session"] = name
				}
			}
		}
	case "session.started", "session.stopped", "session.renamed", "session.sent", "session.queued":
		data = keep("name")
	case events.TranscriptChanged:
		data = keep("session")
	case "run.created", "run.queued", "run.started", "run.resumed", "run.step", "run.gate", "run.gate_decided", "run.finished":
		data = keep("run", "status", "title", "step", "step_status", "gate_title", "approve")
	default:
		return events.Event{}, false
	}
	return events.Event{Seq: e.Seq, Type: e.Type, Time: e.Time, Box: b.Name, Data: data}, true
}

// streamEvents is GET /phone/v1/events?since=SEQ: the events a phone hears
// as NDJSON, as /v1/events sends them, after replaying up to
// maxPhoneReplay of those after SEQ. A new code or phone access turned off
// closes the listener, and every stream with it.
func (p *Phone) streamEvents(w http.ResponseWriter, r *http.Request, b *Box) {
	since := int64(-1)
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "since must be an event seq")
			return
		}
		since = max(n, b.Events.Head()-maxPhoneReplay)
	}
	p.mu.Lock()
	if p.streams >= maxPhoneStreams {
		p.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, "too many phones are following this box")
		return
	}
	p.streams++
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.streams--
		p.mu.Unlock()
	}()
	cur := b.Events.SubscribeFrom(since).Named("phone stream")
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	ch := make(chan events.Event)
	go func() {
		// The cursor is read and closed here alone: a cursor is not for two
		// goroutines at once.
		defer cur.Close()
		defer close(ch)
		for {
			e, err := cur.Next(ctx)
			if err != nil {
				return
			}
			pe, ok := p.phoneEvent(ctx, b, e)
			if !ok {
				continue
			}
			select {
			case ch <- pe:
			case <-ctx.Done():
				return
			}
		}
	}()
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	rc.Flush()
	enc := json.NewEncoder(w)
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-ch:
			if !ok || enc.Encode(e) != nil || rc.Flush() != nil {
				return
			}
		case <-keepalive.C:
			if _, err := w.Write([]byte("\n")); err != nil || rc.Flush() != nil {
				return
			}
		}
	}
}

// --- notifications -----------------------------------------------------------

var (
	pushIDRe  = regexp.MustCompile(`^[a-f0-9]{32}$`)
	pushKeyRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,512}$`)
)

// register is POST /phone/v1/push: a phone app asks to be notified. It
// gives the key the relay sealed its device token in, never the relay's
// address: only a laptop chooses where the box sends.
func (p *Phone) register(w http.ResponseWriter, r *http.Request, b *Box) error {
	var req struct {
		ID       string   `json:"id"`
		Name     string   `json:"name"`
		Platform string   `json:"platform"`
		Key      string   `json:"key"`
		On       []string `json:"on"`
	}
	if err := decodeLimit(r, &req, 4<<10); err != nil {
		return badRequest("%s", err.Error())
	}
	switch {
	case !pushIDRe.MatchString(req.ID):
		return badRequest("id must be 32 hex characters")
	case req.Platform != "ios" && req.Platform != "android":
		return badRequest("platform must be ios or android")
	case !pushKeyRe.MatchString(req.Key):
		return badRequest("that isn't a key from the push relay")
	case utf8.RuneCountInString(req.Name) > 40 || strings.IndexFunc(req.Name, func(c rune) bool { return !unicode.IsPrint(c) }) >= 0:
		return badRequest("name must be at most 40 printable characters")
	}
	for _, s := range req.On {
		if s != "waiting" && s != "finished" {
			return badRequest("notify on waiting or finished")
		}
	}
	if err := b.before(r, "phone.push", map[string]any{"id": req.ID, "name": req.Name, "platform": req.Platform, "from": "phone"}); err != nil {
		return err
	}
	_, err := p.update(func(c *PhoneConfig) error {
		if !c.Enabled {
			return errors.New("phone access is off")
		}
		d := PhonePush{ID: req.ID, Name: req.Name, Platform: req.Platform, Key: req.Key, On: req.On, Added: time.Now().UTC()}
		if i := slices.IndexFunc(c.Push, func(x PhonePush) bool { return x.ID == req.ID }); i >= 0 {
			// The same phone again (a new device token, other states): it
			// keeps its place.
			d.Added = c.Push[i].Added
			c.Push[i] = d
			return nil
		}
		if len(c.Push) >= maxPushPhones {
			oldest := 0
			for i, x := range c.Push {
				if x.Added.Before(c.Push[oldest].Added) {
					oldest = i
				}
			}
			c.Push = slices.Delete(c.Push, oldest, oldest+1)
		}
		c.Push = append(c.Push, d)
		return nil
	})
	if err != nil {
		return err
	}
	b.Events.Publish(events.Event{Type: "phone.push.added", Box: b.Name, Origin: "phone", Data: map[string]any{"name": req.Name, "platform": req.Platform}})
	writeJSON(w, map[string]bool{"registered": true})
	return nil
}

// relayNotice is what the box asks the relay to send: the notice, never
// what the agent wrote. The relay makes the notification from it itself.
type relayNotice struct {
	V        int    `json:"v"`
	Kind     string `json:"kind"`
	State    string `json:"state"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	Box      string `json:"box"`
	Session  string `json:"session,omitempty"`
	Run      string `json:"run,omitempty"`
	Collapse string `json:"collapse"`
}

// errPushGone is the relay saying the phone no longer takes notifications
// (the app was deleted, or its key is no longer good).
var errPushGone = errors.New("the phone no longer takes notifications")

// deliverPush asks the relay to notify each phone, all at once, then
// forgets the phones it says are gone and notes how each went.
func (p *Phone) deliverPush(ctx context.Context, b *Box, n phoneNotice, relay string, devices []PhonePush) {
	kind, collapse := "session", b.Name+"/"+n.Session
	if n.Run != "" && n.Session == "" {
		kind, collapse = "run", b.Name+"/run/"+n.Run
	}
	body, _ := json.Marshal(relayNotice{V: 1, Kind: kind, State: n.State, Title: n.Title, Body: n.Where, Box: b.Name, Session: n.Session, Run: n.Run, Collapse: collapse})
	results := make([]error, len(devices))
	var wg sync.WaitGroup
	for i, d := range devices {
		wg.Go(func() {
			url := strings.TrimRight(relay, "/") + "/v1/send"
			results[i] = p.sendRelay(ctx, b, url, d.Key, body)
			if se := (relayError{}); errors.As(results[i], &se) && se.status >= 500 {
				// Once more, a moment later, for a relay that was busy.
				select {
				case <-ctx.Done():
				case <-time.After(2 * time.Second):
					results[i] = p.sendRelay(ctx, b, url, d.Key, body)
				}
			}
		})
	}
	wg.Wait()
	var gone []PhonePush
	p.update(func(c *PhoneConfig) error {
		for i, d := range devices {
			j := slices.IndexFunc(c.Push, func(x PhonePush) bool { return x.ID == d.ID && x.Key == d.Key })
			if j < 0 {
				continue
			}
			switch err := results[i]; {
			case errors.Is(err, errPushGone):
				gone = append(gone, c.Push[j])
				c.Push = slices.Delete(c.Push, j, j+1)
			case err != nil:
				c.Push[j].LastError = err.Error()
			default:
				c.Push[j].LastOK, c.Push[j].LastError = time.Now().UTC(), ""
			}
		}
		return nil
	})
	for i, err := range results {
		if err != nil && !errors.Is(err, errPushGone) && p.Log != nil {
			p.Log.Printf("phone push to %q: %v", devices[i].Name, err)
		}
	}
	for _, d := range gone {
		b.Events.Publish(events.Event{Type: "phone.push.removed", Box: b.Name, Origin: "berth", Data: map[string]any{"name": d.Name, "platform": d.Platform, "reason": "gone"}})
	}
}

// relayError is the relay refusing a notice.
type relayError struct {
	status int
	msg    string
}

func (e relayError) Error() string {
	if e.msg == "" {
		return fmt.Sprintf("relay answered %d", e.status)
	}
	return fmt.Sprintf("relay answered %d: %s", e.status, e.msg)
}

// sendRelay posts one notice for one phone, the phone's key as the bearer.
func (p *Phone) sendRelay(ctx context.Context, b *Box, url, key string, body []byte) error {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	// Public addresses only, unless the box's owner allowed more
	// (network.json): the relay is a public service.
	resp, err := b.outboundPolicy().client(10 * time.Second).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusGone:
		return errPushGone
	case resp.StatusCode >= 300:
		var e struct {
			Error string `json:"error"`
		}
		json.NewDecoder(io.LimitReader(resp.Body, 4<<10)).Decode(&e)
		return relayError{resp.StatusCode, clipText(e.Error, 200)}
	}
	return nil
}
