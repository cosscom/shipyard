package box

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/transcript"
)

// The Codex driver: `codex app-server` (JSON-RPC over stdio) hosted by
// `berthd agent-host`, as the Claude driver hosts `claude -p`. berthd opens
// its thread (initialize, then thread/start, or thread/resume to carry one
// on), sends each prompt as turn/start with the session's mode, model and
// effort, and answers what Codex asks: commands and file changes to
// approve, and its questions. Everything else it asks gets an error, so a
// turn never waits on something nobody will answer.

// DriverCodex is a structured Codex session.
const DriverCodex = "codex"

// codexModes are the modes a structured Codex session offers, each an
// approval policy and a sandbox for its turns.
var codexModes = []string{"default", "untrusted", "readOnly", "bypassPermissions"}

func codexPolicy(mode string) (approval string, sandbox map[string]any) {
	workspace := map[string]any{"type": "workspaceWrite", "writableRoots": []string{}, "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false}
	switch mode {
	case "untrusted":
		return "untrusted", workspace
	case "readOnly":
		return "on-request", map[string]any{"type": "readOnly", "networkAccess": false}
	case "bypassPermissions":
		return "never", map[string]any{"type": "dangerFullAccess"}
	}
	return "on-request", workspace
}

// threadSandbox is a mode's sandbox as thread/start names it.
func threadSandbox(mode string) string {
	switch mode {
	case "readOnly":
		return "read-only"
	case "bypassPermissions":
		return "danger-full-access"
	}
	return "workspace-write"
}

// launchCodexIn is what starts the preset's Codex as an app server under
// an agent host, keeping its log in dir and listening on sock.
func (b *Box) launchCodexIn(p AgentPreset, mode, dir, sock string) (structuredLaunch, error) {
	if p.ID != "codex" {
		return structuredLaunch{}, badRequest("the codex driver runs Codex; %s runs in its terminal", p.Name)
	}
	known := mode == ""
	for _, m := range codexModes {
		known = known || m == mode
	}
	if !known {
		return structuredLaunch{}, badRequest("unknown permission mode %q", mode)
	}
	host, err := b.agentHostCommand()
	if err != nil {
		return structuredLaunch{}, err
	}
	words := make([]string, 0, len(host)+6)
	for _, w := range host {
		words = append(words, shellQuote(w))
	}
	words = append(words, "--dir", shellQuote(dir), "--socket", shellQuote(sock), "--", p.Command, "app-server")
	return structuredLaunch{
		mode: mode, agent: "codex",
		command: strings.Join(words, " "),
		env:     []string{"BERTH_DRIVER=structured"},
		labels:  map[string]string{labelDriver: DriverCodex, labelConv: dir, labelSock: sock, labelBypass: "0"},
	}, nil
}

// codexRequest is something Codex asks berthd: an approval, a question.
type codexRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func (r codexRequest) key() string { return string(r.ID) }

// codexConv is what berthd knows of one structured Codex session.
type codexConv struct {
	b    *Box
	name string
	cwd  string
	conv string
	sock string
	log  string

	mu          sync.Mutex
	threadID    string
	turnID      string
	mode        string
	model       string
	effort      string
	busy        bool
	since       time.Time
	draft       strings.Builder
	pending     []codexRequest
	replies     map[string]chan json.RawMessage
	sent        map[string]string // our request ids → their methods
	next        int
	lastSeq     int64
	exited      bool
	initialized bool
	changed     chan struct{}
	following   bool
	caught      chan struct{}
	caughtOnce  sync.Once
	queue       []func()
	kick        chan struct{}
	gone        bool
}

type codexDriver struct {
	b     *Box
	mu    sync.Mutex
	convs map[string]*codexConv
}

func (b *Box) codex() *codexDriver {
	b.codexOnce.Do(func() { b.codexDrv = &codexDriver{b: b, convs: map[string]*codexConv{}} })
	return b.codexDrv
}

func (d *codexDriver) Kind() string { return DriverCodex }

func (d *codexDriver) forget(name string) {
	d.mu.Lock()
	c := d.convs[name]
	delete(d.convs, name)
	d.mu.Unlock()
	if c != nil {
		c.mu.Lock()
		if !c.gone {
			c.gone = true
			close(c.kick)
		}
		c.mu.Unlock()
	}
}

func (d *codexDriver) conv(sess Session) (*codexConv, error) {
	if sess.conv == "" || sess.sock == "" {
		return nil, errors.New(sess.Name + " has no structured conversation")
	}
	d.mu.Lock()
	c := d.convs[sess.Name]
	if c == nil || c.conv != sess.conv {
		c = &codexConv{b: d.b, name: sess.Name, cwd: sess.Dir, conv: sess.conv, sock: sess.sock,
			log: filepath.Join(sess.conv, agenthost.LogName), replies: map[string]chan json.RawMessage{}, sent: map[string]string{},
			changed: make(chan struct{}), caught: make(chan struct{}), kick: make(chan struct{}, 1)}
		if meta, ok := readConversation(sess.conv); ok {
			c.mode, c.model, c.effort = meta.Mode, meta.Model, meta.Effort
		}
		d.convs[sess.Name] = c
		go c.speak()
	}
	d.mu.Unlock()
	c.mu.Lock()
	if !c.following {
		c.following = true
		go c.follow()
	}
	c.mu.Unlock()
	return c, nil
}

func (c *codexConv) speak() {
	for range c.kick {
		c.mu.Lock()
		q := c.queue
		c.queue = nil
		c.mu.Unlock()
		for _, f := range q {
			f()
		}
	}
}

func (c *codexConv) signal() {
	close(c.changed)
	c.changed = make(chan struct{})
}

// follow is the Claude driver's: the log read back quietly, then followed
// live, with a host that is starting waited for.
func (c *codexConv) follow() {
	agenthost.ReadLog(c.log, 0, func(e agenthost.Entry) error {
		c.apply(e, false)
		return nil
	})
	c.reconcile()
	c.caughtOnce.Do(func() { close(c.caught) })
	var noHost time.Time
	for {
		c.mu.Lock()
		from, done := c.lastSeq, c.exited
		c.mu.Unlock()
		if done && !hostAlive(c.sock) {
			// Its last word was its end, and no host has started since. (A
			// host started again listens a moment before it says so.) Let
			// go, so it is followed again when next asked for (as Claude's).
			c.mu.Lock()
			c.following = false
			c.mu.Unlock()
			return
		}
		err := agenthost.Attach(context.Background(), c.sock, from, func(e agenthost.Entry) error {
			c.apply(e, true)
			return nil
		})
		if !errors.Is(err, agenthost.ErrNoHost) {
			noHost = time.Time{}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		agenthost.ReadLog(c.log, from, func(e agenthost.Entry) error {
			c.apply(e, true)
			return nil
		})
		if noHost.IsZero() {
			noHost = time.Now()
		}
		if time.Since(noHost) > hostGone {
			c.mu.Lock()
			c.following = false
			c.mu.Unlock()
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// reconcile tells the ledger what the log says now, and opens the thread
// of a host berthd hasn't greeted yet.
func (c *codexConv) reconcile() {
	c.mu.Lock()
	busy, pending, exited, greeted, lastSeq := c.busy, len(c.pending), c.exited, c.initialized, c.lastSeq
	c.mu.Unlock()
	if exited {
		return
	}
	if !greeted && lastSeq > 0 {
		go c.handshake()
	}
	if c.b.Turns == nil {
		return
	}
	st, _ := c.b.Turns.State(c.name)
	switch {
	case pending > 0 && st.State != "waiting":
		c.event(adapters.Waiting, map[string]any{"reason": "permission"}, nil)
	case busy && pending == 0 && st.State != "running":
		c.event(adapters.Started, map[string]any{"signal": "tool"}, nil)
	case !busy && (st.State == "running" || st.State == "waiting"):
		c.event(adapters.Finished, nil, nil)
	}
}

type codexMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *codexConv) apply(e agenthost.Entry, live bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e.Seq <= c.lastSeq {
		return
	}
	c.lastSeq = e.Seq
	var say []func()
	defer func() {
		c.signal()
		if live && len(say) > 0 && !c.gone {
			c.queue = append(c.queue, say...)
			select {
			case c.kick <- struct{}{}:
			default:
			}
		}
	}()
	switch e.Dir {
	case "host":
		switch e.Event {
		case "started":
			c.busy, c.pending, c.since, c.exited, c.initialized, c.turnID = false, nil, time.Time{}, false, false, ""
			if live {
				say = append(say, func() { go c.handshake() })
			}
		case "exited":
			c.exited, c.busy, c.pending = true, false, nil
			say = append(say, func() { c.event(adapters.Exited, nil, nil) })
		}
		return
	case "in":
		var m codexMessage
		if json.Unmarshal(e.Data, &m) != nil {
			return
		}
		switch {
		case m.Method == "initialize":
			c.initialized = true
			c.sent[string(m.ID)] = m.Method
		case m.Method != "" && len(m.ID) > 0:
			c.sent[string(m.ID)] = m.Method
		case m.Method == "" && len(m.ID) > 0:
			// berthd answered one of Codex's requests.
			c.drop(string(m.ID))
		}
		return
	case "out":
	default:
		return
	}
	var m codexMessage
	if len(e.Data) == 0 || json.Unmarshal(e.Data, &m) != nil {
		return
	}
	if m.Method == "" && len(m.ID) > 0 {
		// The answer to one of berthd's requests.
		id := string(m.ID)
		method := c.sent[id]
		delete(c.sent, id)
		if method == "thread/start" || method == "thread/resume" {
			var r struct {
				Thread struct {
					ID string `json:"id"`
				} `json:"thread"`
			}
			if json.Unmarshal(m.Result, &r) == nil && r.Thread.ID != "" && r.Thread.ID != c.threadID {
				c.threadID = r.Thread.ID
				if live {
					tid, dir := r.Thread.ID, c.conv
					say = append(say, func() { noteConversation(dir, func(x *Conversation) { x.AgentSessionID = tid }) }, func() { c.event(adapters.Ready, nil, nil) })
				}
			}
		}
		if ch := c.replies[id]; ch != nil {
			delete(c.replies, id)
			if m.Error != nil {
				msg, _ := json.Marshal(map[string]string{"error": m.Error.Message})
				ch <- msg
			} else {
				ch <- m.Result
			}
		}
		return
	}
	if len(m.ID) > 0 && m.Method != "" {
		// Codex asks berthd something.
		r := codexRequest{ID: m.ID, Method: m.Method, Params: m.Params}
		switch m.Method {
		case "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput":
			c.pending = append(c.pending, r)
			if live {
				ask, reason := r.ask(c.cwd)
				say = append(say, func() {
					c.event(adapters.Waiting, map[string]any{"reason": reason}, map[string]any{adapters.AskKey: ask})
				})
			}
		default:
			if live {
				say = append(say, func() {
					c.write(context.Background(), map[string]any{"jsonrpc": "2.0", "id": r.ID, "error": map[string]any{"code": -32601, "message": "Shipyard doesn't answer " + r.Method}})
				})
			}
		}
		return
	}
	var p struct {
		ThreadID string `json:"threadId"`
		Turn     struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"turn"`
		Item struct {
			Type    string `json:"type"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"item"`
		Delta     string          `json:"delta"`
		RequestID json.RawMessage `json:"requestId"`
	}
	json.Unmarshal(m.Params, &p)
	switch m.Method {
	case "turn/started":
		c.turnID = p.Turn.ID
	case "item/started":
		if p.Item.Type == "userMessage" && !c.busy {
			c.busy, c.since = true, time.UnixMilli(e.At)
			var text []string
			for _, t := range p.Item.Content {
				text = append(text, t.Text)
			}
			title := adapters.Title(strings.Join(text, "\n"))
			say = append(say, func() {
				if c.b.Turns != nil {
					c.b.Turns.AwaitSent(c.name, 2*time.Second)
				}
				c.event(adapters.Started, map[string]any{"signal": "prompt"}, map[string]any{"title": title})
			})
		}
		if p.Item.Type == "agentMessage" {
			c.draft.Reset()
		}
		say = append(say, c.changedConversation)
	case "item/agentMessage/delta":
		if c.draft.Len() < maxDraft {
			c.draft.WriteString(p.Delta)
		}
	case "item/completed":
		if p.Item.Type == "agentMessage" {
			c.draft.Reset()
		}
		say = append(say, c.changedConversation)
	case "serverRequest/resolved":
		before := len(c.pending)
		c.drop(string(p.RequestID))
		if live && len(c.pending) < before {
			say = append(say, func() { c.event(adapters.Started, map[string]any{"signal": "tool"}, nil) })
		}
	case "turn/completed":
		c.busy, c.pending, c.since, c.turnID = false, nil, time.Time{}, ""
		c.draft.Reset()
		data := map[string]any{}
		switch p.Turn.Status {
		case "interrupted":
			data["status"] = "interrupted"
		case "failed":
			data["status"] = "error"
		}
		dir := c.conv
		say = append(say, func() { c.event(adapters.Finished, data, nil) }, c.changedConversation,
			func() { noteConversation(dir, func(x *Conversation) { x.Updated = time.Now().UTC() }) })
	}
}

func (c *codexConv) drop(id string) {
	for i, r := range c.pending {
		if r.key() == id {
			c.pending = append(c.pending[:i], c.pending[i+1:]...)
			return
		}
	}
}

// ask is what a request asks, as a hook's ask is.
func (r codexRequest) ask(cwd string) (map[string]any, string) {
	var p struct {
		Command   string `json:"command"`
		Reason    string `json:"reason"`
		ItemID    string `json:"itemId"`
		GrantRoot string `json:"grantRoot"`
		Questions []struct {
			Question string `json:"question"`
		} `json:"questions"`
	}
	json.Unmarshal(r.Params, &p)
	switch r.Method {
	case "item/commandExecution/requestApproval":
		cmd := p.Command
		if m := shellWrappedCmd(cmd); m != "" {
			cmd = m
		}
		ask := map[string]any{"tool": "Bash", "input": adapters.Clip(cmd, adapters.AskLimit)}
		if p.Reason != "" {
			ask["why"] = adapters.Clip(p.Reason, adapters.AskLimit)
		}
		return ask, "permission"
	case "item/fileChange/requestApproval":
		ask := map[string]any{"tool": "Edit", "message": "Codex wants to change files"}
		if p.Reason != "" {
			ask["why"] = adapters.Clip(p.Reason, adapters.AskLimit)
		}
		return ask, "permission"
	}
	msg := "Codex asks you something"
	if len(p.Questions) > 0 {
		msg = adapters.Clip(p.Questions[0].Question, adapters.AskLimit)
	}
	return map[string]any{"tool": "request_user_input", "message": msg}, "question"
}

// shellWrappedCmd is the command inside `/bin/zsh -lc '…'`, or "".
func shellWrappedCmd(cmd string) string {
	if i := strings.Index(cmd, " -lc '"); i >= 0 && strings.HasSuffix(cmd, "'") {
		return strings.ReplaceAll(cmd[i+len(" -lc '"):len(cmd)-1], `'\''`, `'`)
	}
	return ""
}

func (c *codexConv) event(typ string, data, private map[string]any) {
	c.mu.Lock()
	tid := c.threadID
	c.mu.Unlock()
	if data == nil {
		data = map[string]any{}
	}
	data["session"], data["path"] = c.name, c.cwd
	if tid != "" {
		data["agent_session_id"], data["session_id"] = tid, tid
	}
	c.b.agentEvent(context.Background(), "codex", typ, data, private)
}

func (c *codexConv) changedConversation() {
	c.b.Events.Publish(events.Event{Type: events.TranscriptChanged, Box: c.b.Name, Data: map[string]any{"session": c.name, "name": c.name, "path": c.cwd}})
}

// write gives Codex one JSON-RPC message.
func (c *codexConv) write(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, err := agenthost.Write(ctx, c.sock, b)
		if !errors.Is(err, agenthost.ErrNoHost) {
			return err
		}
		if time.Now().After(deadline) {
			return ErrSessionExited
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// request sends Codex a request and waits for its answer. A request before
// berthd has read the log back waits for that first.
func (c *codexConv) request(ctx context.Context, method string, params any, wait time.Duration) (json.RawMessage, error) {
	select {
	case <-c.caught:
	case <-time.After(10 * time.Second):
		return nil, httpError{http.StatusServiceUnavailable, "still reading " + c.name + "'s log back"}
	}
	c.mu.Lock()
	c.next++
	id := "berth-" + strconv.Itoa(c.next) + "-" + newConvID()
	ch := make(chan json.RawMessage, 1)
	c.replies[`"`+id+`"`] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.replies, `"`+id+`"`)
		c.mu.Unlock()
	}()
	msg := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	if err := c.write(ctx, msg); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	select {
	case r := <-ch:
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(r, &e) == nil && e.Error != "" {
			return nil, httpError{http.StatusConflict, "Codex refused: " + e.Error}
		}
		return r, nil
	case <-ctx.Done():
		return nil, httpError{http.StatusGatewayTimeout, "Codex didn't answer " + method}
	}
}

// handshake greets a newly started app server and opens its thread: the
// conversation's own, carried on, when it has one.
func (c *codexConv) handshake() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	c.mu.Lock()
	if c.initialized {
		c.mu.Unlock()
		return
	}
	c.initialized = true
	thread, mode, model, cwd := c.threadID, c.mode, c.model, c.cwd
	c.mu.Unlock()
	if thread == "" {
		if meta, ok := readConversation(c.conv); ok {
			thread = meta.AgentSessionID
		}
	}
	if _, err := c.request(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "shipyard", "title": "Shipyard", "version": "1"},
		"capabilities": map[string]any{"experimentalApi": true},
	}, 30*time.Second); err != nil {
		c.mu.Lock()
		c.initialized = false
		c.mu.Unlock()
		return
	}
	c.write(ctx, map[string]any{"jsonrpc": "2.0", "method": "initialized"})
	approval, _ := codexPolicy(mode)
	params := map[string]any{"cwd": cwd, "approvalPolicy": approval, "sandbox": threadSandbox(mode)}
	if model != "" {
		params["model"] = model
	}
	if thread != "" {
		params["threadId"] = thread
		params["excludeTurns"] = true
		if _, err := c.request(ctx, "thread/resume", params, time.Minute); err == nil {
			return
		}
		delete(params, "threadId")
		delete(params, "excludeTurns")
	}
	c.request(ctx, "thread/start", params, time.Minute)
}

// awaitThread waits for the thread to be open.
func (c *codexConv) awaitThread(ctx context.Context) (string, error) {
	deadline := time.After(time.Minute)
	for {
		c.mu.Lock()
		tid, changed := c.threadID, c.changed
		c.mu.Unlock()
		if tid != "" {
			return tid, nil
		}
		select {
		case <-changed:
		case <-deadline:
			return "", httpError{http.StatusServiceUnavailable, "Codex hasn't opened its thread"}
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func (c *codexConv) first() (codexRequest, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) == 0 {
		return codexRequest{}, false
	}
	return c.pending[0], true
}

// respond answers one of Codex's requests.
func (c *codexConv) respond(r codexRequest, result any) error {
	return c.write(context.Background(), map[string]any{"jsonrpc": "2.0", "id": r.ID, "result": result})
}

// pick answers the oldest approval with the choice its key names.
func (c *codexConv) pick(key string) error {
	r, ok := c.first()
	if !ok {
		return httpError{http.StatusConflict, "Codex isn't asking for anything"}
	}
	if r.Method == "item/tool/requestUserInput" {
		return httpError{http.StatusConflict, "Codex asked questions: answer them in the chat"}
	}
	switch key {
	case "1", "y", "Y":
		return c.respond(r, map[string]any{"decision": "accept"})
	case "2":
		return c.respond(r, map[string]any{"decision": "acceptForSession"})
	case "3", "n", "N":
		return c.respond(r, map[string]any{"decision": "decline"})
	}
	return badRequest("pick 1, 2 or 3")
}

func (c *codexConv) choices() []AskChoice {
	r, ok := c.first()
	if !ok || r.Method == "item/tool/requestUserInput" {
		return nil
	}
	return permissionChoices
}

func (d *codexDriver) Send(ctx context.Context, sess Session, text string, enter bool) error {
	c, err := d.conv(sess)
	if err != nil {
		return err
	}
	if r, waiting := c.first(); waiting {
		if isKey(text) && !enter {
			return c.pick(text)
		}
		if strings.TrimSpace(text) != "" && r.Method != "item/tool/requestUserInput" {
			// Typed at an approval (sent with force): no, and this instead.
			if err := c.respond(r, map[string]any{"decision": "decline"}); err != nil {
				return err
			}
		}
	}
	if !enter {
		return badRequest("a structured session takes whole messages")
	}
	if strings.TrimSpace(text) == "" {
		return nil
	}
	tid, err := c.awaitThread(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	mode, model, effort := c.mode, c.model, c.effort
	c.mu.Unlock()
	approval, sandbox := codexPolicy(mode)
	params := map[string]any{"threadId": tid, "input": []any{map[string]any{"type": "text", "text": text, "text_elements": []any{}}},
		"approvalPolicy": approval, "sandboxPolicy": sandbox}
	if model != "" {
		params["model"] = model
	}
	if effort != "" {
		params["effort"] = effort
	}
	_, err = c.request(ctx, "turn/start", params, 30*time.Second)
	return err
}

func (d *codexDriver) Interrupt(ctx context.Context, sess Session) (bool, error) {
	c, err := d.conv(sess)
	if err != nil {
		return false, err
	}
	c.mu.Lock()
	tid, turn := c.threadID, c.turnID
	c.mu.Unlock()
	if turn == "" {
		return true, nil
	}
	if _, err := c.request(ctx, "turn/interrupt", map[string]any{"threadId": tid, "turnId": turn}, 10*time.Second); err != nil {
		return false, err
	}
	deadline := time.After(4 * time.Second)
	for {
		c.mu.Lock()
		busy, changed := c.busy, c.changed
		c.mu.Unlock()
		if !busy {
			return true, nil
		}
		select {
		case <-changed:
		case <-deadline:
			return false, nil
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}
}

func (d *codexDriver) Controls(ctx context.Context, sess Session) (Controls, error) {
	c, err := d.conv(sess)
	if err != nil {
		return Controls{Agent: "codex"}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return Controls{Agent: "codex", Mode: firstNonEmpty(c.mode, "default"), Modes: codexModes}, nil
}

// SetMode takes effect from the next turn, which carries it.
func (d *codexDriver) SetMode(ctx context.Context, sess Session, mode string) (string, error) {
	c, err := d.conv(sess)
	if err != nil {
		return "", err
	}
	known := false
	for _, m := range codexModes {
		known = known || m == mode
	}
	if !known {
		return "", badRequest("unknown permission mode %q", mode)
	}
	c.mu.Lock()
	c.mode = mode
	c.mu.Unlock()
	noteConversation(c.conv, func(m *Conversation) { m.Mode = mode })
	return mode, nil
}

func (d *codexDriver) Answer(ctx context.Context, sess Session, req AnswerRequest) ([]string, error) {
	c, err := d.conv(sess)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	var r codexRequest
	found := false
	for _, p := range c.pending {
		if p.Method != "item/tool/requestUserInput" {
			continue
		}
		var params struct {
			ItemID string `json:"itemId"`
		}
		json.Unmarshal(p.Params, &params)
		if firstNonEmpty(params.ItemID, "ask-"+p.key()) == req.Tool {
			r, found = p, true
		}
	}
	c.mu.Unlock()
	if !found {
		return nil, httpError{http.StatusConflict, "Codex isn't waiting for those answers"}
	}
	var in struct {
		Questions []struct {
			ID       string `json:"id"`
			Header   string `json:"header"`
			Question string `json:"question"`
			Options  []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(r.Params, &in); err != nil {
		return nil, err
	}
	qs := make([]transcript.Question, len(in.Questions))
	for i, q := range in.Questions {
		qs[i] = transcript.Question{Question: q.Question, Header: q.Header, ID: q.ID}
		for _, o := range q.Options {
			qs[i].Options = append(qs[i].Options, transcript.Option{Label: o.Label, Description: o.Description})
		}
	}
	shown, err := checkAnswers(qs, req.Answers)
	if err != nil {
		return nil, err
	}
	answers := map[string]any{}
	for i, q := range qs {
		picks := append([]string{}, req.Answers[i].Picks...)
		if req.Answers[i].Other != "" {
			picks = append(picks, req.Answers[i].Other)
		}
		answers[q.ID] = map[string]any{"answers": picks}
	}
	if err := c.respond(r, map[string]any{"answers": answers}); err != nil {
		return nil, err
	}
	return shown, nil
}

func (d *codexDriver) Conversation(ctx context.Context, sess Session, _ []Session, since int, gen string) (transcript.Result, error) {
	if _, err := d.conv(sess); err != nil {
		return transcript.Result{Source: "none", Items: []transcript.Item{}, Crew: []transcript.CrewMember{}, Reason: err.Error()}, nil
	}
	return reader().Follow(transcript.SourceCodexHost, filepath.Join(sess.conv, agenthost.LogName), sess.Dir, max(since, 0), gen)
}

func (d *codexDriver) Record(ctx context.Context, sess Session, _ []Session) (string, string) {
	return transcript.SourceCodexHost, filepath.Join(sess.conv, agenthost.LogName)
}

func (d *codexDriver) Draft(ctx context.Context, sess Session) (Draft, error) {
	c, err := d.conv(sess)
	if err != nil {
		return Draft{Agent: "codex"}, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := Draft{Agent: "codex", Text: c.draft.String()}
	if c.busy && len(c.pending) == 0 {
		out.Status = &DraftStatus{Word: "Working…"}
		if !c.since.IsZero() {
			out.Status.Elapsed = time.Since(c.since).Round(time.Second).String()
		}
	}
	return out, nil
}

func (d *codexDriver) askChoices(sess Session) []AskChoice {
	c, err := d.conv(sess)
	if err != nil {
		return nil
	}
	return c.choices()
}
