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

// The ACP driver: any agent that speaks the Agent Client Protocol
// (opencode, Gemini CLI, Cursor Agent, or a repository's own agent whose
// preset says how: AgentPreset.ACP), hosted by `berthd agent-host`. berthd
// opens its session (authenticating first when the agent asks for it),
// sends prompts, cancels turns, switches the agent's own modes, and brings
// its permission requests to the chat, picking among their options by kind,
// since each agent names them its own way. What else an agent asks of its
// client (files, terminals, its own extensions) gets an error: berthd
// offers none of those, so the agent uses its own tools.

// DriverACP is a structured session of an ACP agent.
const DriverACP = "acp"

// acpEnv is what an agent's ACP server needs to put its permissions to
// berthd: opencode allows everything unless told to ask.
var acpEnv = map[string][]string{
	"opencode": {`OPENCODE_CONFIG_CONTENT={"permission":{"bash":"ask","edit":"ask","webfetch":"ask"}}`},
}

// launchACPIn is what starts preset p's ACP server under an agent host.
func (b *Box) launchACPIn(p AgentPreset, mode, dir, sock string) (structuredLaunch, error) {
	if p.ACP == "" {
		return structuredLaunch{}, badRequest("berth doesn't know how to run %s over ACP: give its preset an acp", p.Name)
	}
	host, err := b.agentHostCommand()
	if err != nil {
		return structuredLaunch{}, err
	}
	words := make([]string, 0, len(host)+6)
	for _, w := range host {
		words = append(words, shellQuote(w))
	}
	words = append(words, "--dir", shellQuote(dir), "--socket", shellQuote(sock), "--", p.Command, p.ACP)
	bypass := "0"
	if mode == "bypassPermissions" {
		bypass = "1"
	}
	return structuredLaunch{
		mode: mode, agent: p.ID,
		command: strings.Join(words, " "),
		env:     append([]string{"BERTH_DRIVER=structured"}, acpEnv[p.ID]...),
		labels:  map[string]string{labelDriver: DriverACP, labelConv: dir, labelSock: sock, labelBypass: bypass},
	}, nil
}

// acpRequest is a permission an ACP agent asks for.
type acpRequest struct {
	ID       json.RawMessage
	ToolCall struct {
		Title    string `json:"title"`
		Kind     string `json:"kind"`
		RawInput struct {
			Command  string `json:"command"`
			FilePath string `json:"filePath"`
			Path     string `json:"path"`
		} `json:"rawInput"`
	} `json:"toolCall"`
	Options []struct {
		OptionID string `json:"optionId"`
		Kind     string `json:"kind"`
		Name     string `json:"name"`
	} `json:"options"`
}

// option is the id of the option of kind, or "".
func (r acpRequest) option(kinds ...string) string {
	for _, k := range kinds {
		for _, o := range r.Options {
			if o.Kind == k {
				return o.OptionID
			}
		}
	}
	return ""
}

type acpConv struct {
	b     *Box
	name  string
	agent string
	cwd   string
	conv  string
	sock  string
	log   string

	mu          sync.Mutex
	sessionID   string
	mode        string // the agent's own mode
	modes       []string
	modeConfig  string // its mode's config option id, when it has one
	canResume   bool
	canLoad     bool
	canList     bool
	authMethod  string
	bypass      bool
	busy        bool
	since       time.Time
	draft       strings.Builder
	pending     []acpRequest
	replies     map[string]chan json.RawMessage
	sent        map[string]string
	prompts     map[string]bool
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

type acpDriver struct {
	b     *Box
	mu    sync.Mutex
	convs map[string]*acpConv
}

func (b *Box) acp() *acpDriver {
	b.acpOnce.Do(func() { b.acpDrv = &acpDriver{b: b, convs: map[string]*acpConv{}} })
	return b.acpDrv
}

func (d *acpDriver) Kind() string { return DriverACP }

func (d *acpDriver) forget(name string) {
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

func (d *acpDriver) conv(sess Session) (*acpConv, error) {
	if sess.conv == "" || sess.sock == "" {
		return nil, errors.New(sess.Name + " has no structured conversation")
	}
	d.mu.Lock()
	c := d.convs[sess.Name]
	if c == nil || c.conv != sess.conv {
		c = &acpConv{b: d.b, name: sess.Name, agent: agentFor(sess), cwd: sess.Dir, conv: sess.conv, sock: sess.sock,
			log: filepath.Join(sess.conv, agenthost.LogName), replies: map[string]chan json.RawMessage{}, sent: map[string]string{},
			prompts: map[string]bool{}, changed: make(chan struct{}), caught: make(chan struct{}), kick: make(chan struct{}, 1), bypass: sess.bypass}
		if meta, ok := readConversation(sess.conv); ok && c.agent == "" {
			c.agent = meta.Agent
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

func (c *acpConv) speak() {
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

func (c *acpConv) signal() {
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *acpConv) follow() {
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

func (c *acpConv) reconcile() {
	c.mu.Lock()
	busy, pending, exited, greeted, lastSeq, bypass := c.busy, append([]acpRequest(nil), c.pending...), c.exited, c.initialized, c.lastSeq, c.bypass
	c.mu.Unlock()
	if exited {
		return
	}
	if !greeted && lastSeq > 0 {
		go c.handshake()
	}
	if bypass {
		for _, r := range pending {
			go c.allow(r, false)
		}
		pending = nil
	}
	if c.b.Turns == nil {
		return
	}
	st, _ := c.b.Turns.State(c.name)
	switch {
	case len(pending) > 0 && st.State != "waiting":
		c.event(adapters.Waiting, map[string]any{"reason": "permission"}, map[string]any{adapters.AskKey: pending[0].ask()})
	case busy && len(pending) == 0 && st.State != "running":
		c.event(adapters.Started, map[string]any{"signal": "tool"}, nil)
	case !busy && (st.State == "running" || st.State == "waiting"):
		c.event(adapters.Finished, nil, nil)
	}
}

func (c *acpConv) apply(e agenthost.Entry, live bool) {
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
			c.busy, c.pending, c.since, c.exited, c.initialized = false, nil, time.Time{}, false, false
			c.prompts = map[string]bool{}
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
		case m.Method == "session/prompt":
			c.sent[string(m.ID)] = m.Method
			c.prompts[string(m.ID)] = true
			if !c.busy {
				c.busy, c.since = true, time.UnixMilli(e.At)
				c.draft.Reset()
				var p struct {
					Prompt []struct {
						Text string `json:"text"`
					} `json:"prompt"`
				}
				json.Unmarshal(m.Params, &p)
				var text []string
				for _, b := range p.Prompt {
					text = append(text, b.Text)
				}
				title := adapters.Title(strings.Join(text, "\n"))
				say = append(say, func() {
					if c.b.Turns != nil {
						c.b.Turns.AwaitSent(c.name, 2*time.Second)
					}
					c.event(adapters.Started, map[string]any{"signal": "prompt"}, map[string]any{"title": title})
				}, c.changedConversation)
			}
		case m.Method != "" && len(m.ID) > 0:
			c.sent[string(m.ID)] = m.Method
		case m.Method == "" && len(m.ID) > 0:
			if c.drop(string(m.ID)) && live {
				say = append(say, func() { c.event(adapters.Started, map[string]any{"signal": "tool"}, nil) })
			}
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
		id := string(m.ID)
		method := c.sent[id]
		delete(c.sent, id)
		switch method {
		case "initialize":
			var r struct {
				AgentCapabilities struct {
					LoadSession         bool `json:"loadSession"`
					SessionCapabilities struct {
						Resume json.RawMessage `json:"resume"`
						List   json.RawMessage `json:"list"`
					} `json:"sessionCapabilities"`
				} `json:"agentCapabilities"`
				AuthMethods []struct {
					ID string `json:"id"`
				} `json:"authMethods"`
			}
			if json.Unmarshal(m.Result, &r) == nil {
				c.canLoad = r.AgentCapabilities.LoadSession
				c.canResume = offered(r.AgentCapabilities.SessionCapabilities.Resume)
				c.canList = offered(r.AgentCapabilities.SessionCapabilities.List)
				if len(r.AuthMethods) > 0 {
					c.authMethod = r.AuthMethods[0].ID
				}
			}
		case "session/new", "session/load", "session/resume":
			c.readSession(m.Result)
			var r struct {
				SessionID string `json:"sessionId"`
			}
			json.Unmarshal(m.Result, &r)
			if r.SessionID != "" {
				c.sessionID = r.SessionID
			}
			if live && m.Error == nil && c.sessionID != "" {
				sid, dir := c.sessionID, c.conv
				say = append(say, func() { noteConversation(dir, func(x *Conversation) { x.AgentSessionID = sid }) }, func() { c.event(adapters.Ready, nil, nil) })
			}
		case "session/set_config_option", "session/set_mode":
			c.readSession(m.Result)
		case "session/prompt":
			delete(c.prompts, id)
			if len(c.prompts) == 0 {
				c.busy, c.pending, c.since = false, nil, time.Time{}
				c.draft.Reset()
				data := map[string]any{}
				var r struct {
					StopReason string `json:"stopReason"`
				}
				json.Unmarshal(m.Result, &r)
				switch {
				case m.Error != nil:
					data["status"] = "error"
				case r.StopReason == "cancelled":
					data["status"] = "interrupted"
				}
				dir := c.conv
				say = append(say, func() { c.event(adapters.Finished, data, nil) }, c.changedConversation,
					func() { noteConversation(dir, func(x *Conversation) { x.Updated = time.Now().UTC() }) })
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
		if m.Method == "session/request_permission" {
			var r acpRequest
			if json.Unmarshal(m.Params, &r) == nil {
				r.ID = m.ID
				if live && c.bypass {
					say = append(say, func() { c.allow(r, false) })
					return
				}
				c.pending = append(c.pending, r)
				if live {
					ask := r.ask()
					say = append(say, func() {
						c.event(adapters.Waiting, map[string]any{"reason": "permission"}, map[string]any{adapters.AskKey: ask})
					})
				}
			}
			return
		}
		if live {
			id, method := m.ID, m.Method
			say = append(say, func() {
				c.write(context.Background(), map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "Shipyard doesn't answer " + method}})
			})
		}
		return
	}
	if m.Method == "session/update" {
		var p struct {
			Update struct {
				SessionUpdate string `json:"sessionUpdate"`
				Content       struct {
					Text string `json:"text"`
				} `json:"content"`
				CurrentModeID string `json:"currentModeId"`
			} `json:"update"`
		}
		json.Unmarshal(m.Params, &p)
		switch p.Update.SessionUpdate {
		case "agent_message_chunk":
			if c.busy && c.draft.Len() < maxDraft {
				c.draft.WriteString(p.Update.Content.Text)
			}
		case "tool_call":
			c.draft.Reset()
			say = append(say, c.changedConversation)
		case "tool_call_update":
			say = append(say, c.changedConversation)
		case "current_mode_update":
			if p.Update.CurrentModeID != "" {
				c.mode = p.Update.CurrentModeID
			}
		}
	}
}

// readSession reads a session's modes from session/new (or a mode change's
// answer): its modes, or its mode config option. Called with c.mu held.
func (c *acpConv) readSession(raw json.RawMessage) {
	var r struct {
		Modes *struct {
			CurrentModeID  string `json:"currentModeId"`
			AvailableModes []struct {
				ID string `json:"id"`
			} `json:"availableModes"`
		} `json:"modes"`
		ConfigOptions []struct {
			ID           string `json:"id"`
			Category     string `json:"category"`
			CurrentValue string `json:"currentValue"`
			Options      []struct {
				Value string `json:"value"`
			} `json:"options"`
		} `json:"configOptions"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return
	}
	for _, o := range r.ConfigOptions {
		if o.Category != "mode" {
			continue
		}
		c.modeConfig, c.mode, c.modes = o.ID, o.CurrentValue, nil
		for _, v := range o.Options {
			c.modes = append(c.modes, v.Value)
		}
		return
	}
	if r.Modes != nil {
		c.mode, c.modes = r.Modes.CurrentModeID, nil
		for _, m := range r.Modes.AvailableModes {
			c.modes = append(c.modes, m.ID)
		}
	}
}

func (c *acpConv) drop(id string) bool {
	for i, r := range c.pending {
		if string(r.ID) == id {
			c.pending = append(c.pending[:i], c.pending[i+1:]...)
			return true
		}
	}
	return false
}

// ask is what a permission asks, as a hook's ask is.
func (r acpRequest) ask() map[string]any {
	t := r.ToolCall
	tool := map[string]string{"execute": "Bash", "edit": "Edit", "delete": "Edit", "move": "Edit", "read": "Read", "fetch": "WebFetch"}[t.Kind]
	input := firstNonEmpty(t.RawInput.Command, firstNonEmpty(t.RawInput.FilePath, t.RawInput.Path))
	ask := map[string]any{"tool": firstNonEmpty(tool, adapters.Clip(t.Title, adapters.AskLimit))}
	if input != "" {
		ask["input"] = adapters.Clip(input, adapters.AskLimit)
	} else if t.Title != "" {
		ask["message"] = adapters.Clip(t.Title, adapters.AskLimit)
	}
	return ask
}

func (c *acpConv) event(typ string, data, private map[string]any) {
	c.mu.Lock()
	sid := c.sessionID
	c.mu.Unlock()
	if data == nil {
		data = map[string]any{}
	}
	data["session"], data["path"] = c.name, c.cwd
	if sid != "" {
		data["agent_session_id"], data["session_id"] = sid, sid
	}
	c.b.agentEvent(context.Background(), c.agent, typ, data, private)
}

func (c *acpConv) changedConversation() {
	c.b.Events.Publish(events.Event{Type: events.TranscriptChanged, Box: c.b.Name, Data: map[string]any{"session": c.name, "name": c.name, "path": c.cwd}})
}

func (c *acpConv) write(ctx context.Context, v any) error {
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

// call sends the agent a request; with wait 0 it doesn't wait for the
// answer (a prompt's comes at its turn's end), and returns its id.
func (c *acpConv) call(ctx context.Context, method string, params any, wait time.Duration) (json.RawMessage, error) {
	select {
	case <-c.caught:
	case <-time.After(10 * time.Second):
		return nil, httpError{http.StatusServiceUnavailable, "still reading " + c.name + "'s log back"}
	}
	c.mu.Lock()
	c.next++
	id := "berth-" + strconv.Itoa(c.next) + "-" + newConvID()
	ch := make(chan json.RawMessage, 1)
	if wait > 0 {
		c.replies[`"`+id+`"`] = ch
	}
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.replies, `"`+id+`"`)
		c.mu.Unlock()
	}()
	if err := c.write(ctx, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	if wait == 0 {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	select {
	case r := <-ch:
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(r, &e) == nil && e.Error != "" {
			return nil, httpError{http.StatusConflict, e.Error}
		}
		return r, nil
	case <-ctx.Done():
		return nil, httpError{http.StatusGatewayTimeout, "the agent didn't answer " + method}
	}
}

// handshake greets a newly started agent and opens its session: the
// conversation's own, carried on, when it has one and the agent can.
func (c *acpConv) handshake() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	c.mu.Lock()
	if c.initialized {
		c.mu.Unlock()
		return
	}
	c.initialized = true
	sid, cwd := c.sessionID, c.cwd
	c.mu.Unlock()
	meta, _ := readConversation(c.conv)
	if sid == "" {
		sid = meta.AgentSessionID
	}
	if _, err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": false},
		"clientInfo":         map[string]any{"name": "shipyard", "version": "1"},
	}, 60*time.Second); err != nil {
		c.mu.Lock()
		c.initialized = false
		c.mu.Unlock()
		return
	}
	open := func(method string, params map[string]any) error {
		_, err := c.call(ctx, method, params, time.Minute)
		c.mu.Lock()
		auth := c.authMethod
		c.mu.Unlock()
		if err != nil && auth != "" && strings.Contains(strings.ToLower(err.Error()), "auth") {
			// It uses its own login, once asked to (Cursor Agent).
			if _, aerr := c.call(ctx, "authenticate", map[string]any{"methodId": auth}, time.Minute); aerr == nil {
				_, err = c.call(ctx, method, params, time.Minute)
			}
		}
		return err
	}
	base := map[string]any{"cwd": cwd, "mcpServers": []any{}}
	c.mu.Lock()
	canResume, canLoad := c.canResume, c.canLoad
	c.mu.Unlock()
	opened := false
	if sid != "" && (canResume || canLoad) {
		// Loaded, it replays the conversation: what a log that has none
		// of it yet (one picked from its past sessions) shows.
		method := "session/load"
		if canResume && (!canLoad || acpLogHasTurns(c.log)) {
			method = "session/resume"
		}
		params := map[string]any{"sessionId": sid}
		for k, v := range base {
			params[k] = v
		}
		c.mu.Lock()
		c.sessionID = sid
		c.mu.Unlock()
		opened = open(method, params) == nil
		if !opened {
			c.mu.Lock()
			c.sessionID = ""
			c.mu.Unlock()
		}
	}
	if !opened {
		open("session/new", base)
	}
	if meta.Model != "" {
		c.mu.Lock()
		s := c.sessionID
		c.mu.Unlock()
		c.call(ctx, "session/set_config_option", map[string]any{"sessionId": s, "configId": "model", "value": meta.Model}, 30*time.Second)
	}
	if mode := meta.Mode; mode != "" && mode != "bypassPermissions" {
		c.setMode(ctx, mode)
	}
}

// offered says whether a capability is there: an object, not absent or null.
func offered(v json.RawMessage) bool {
	return len(v) > 0 && string(v) != "null"
}

// acpLogHasTurns says whether an ACP conversation's log has a prompt or a
// replay in it already.
func acpLogHasTurns(path string) bool {
	found := errors.New("found")
	err := agenthost.ReadLog(path, 0, func(e agenthost.Entry) error {
		var m struct {
			Method string `json:"method"`
		}
		if e.Dir == "in" && json.Unmarshal(e.Data, &m) == nil && (m.Method == "session/prompt" || m.Method == "session/load") {
			return found
		}
		return nil
	})
	return errors.Is(err, found)
}

func (c *acpConv) awaitSession(ctx context.Context) (string, error) {
	deadline := time.After(time.Minute)
	for {
		c.mu.Lock()
		sid, changed := c.sessionID, c.changed
		c.mu.Unlock()
		if sid != "" {
			return sid, nil
		}
		select {
		case <-changed:
		case <-deadline:
			return "", httpError{http.StatusServiceUnavailable, "the agent hasn't opened its session"}
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func (c *acpConv) first() (acpRequest, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) == 0 {
		return acpRequest{}, false
	}
	return c.pending[0], true
}

func (c *acpConv) choose(r acpRequest, optionID string) error {
	result := map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": optionID}}
	if optionID == "" {
		result = map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}
	}
	// Working again is said when the answer is read back from the log
	// (apply), before anything the agent says after it.
	return c.write(context.Background(), map[string]any{"jsonrpc": "2.0", "id": r.ID, "result": result})
}

// allow says yes to a permission, for this time or always.
func (c *acpConv) allow(r acpRequest, always bool) error {
	if always {
		return c.choose(r, r.option("allow_always", "allow_once"))
	}
	return c.choose(r, r.option("allow_once", "allow_always"))
}

func (c *acpConv) pick(key string) error {
	r, ok := c.first()
	if !ok {
		return httpError{http.StatusConflict, "the agent isn't asking for anything"}
	}
	switch key {
	case "1", "y", "Y":
		return c.allow(r, false)
	case "2":
		return c.allow(r, true)
	case "3", "n", "N":
		return c.choose(r, r.option("reject_once", "reject_always"))
	}
	return badRequest("pick 1, 2 or 3")
}

func (c *acpConv) choices() []AskChoice {
	r, ok := c.first()
	if !ok {
		return nil
	}
	var out []AskChoice
	if r.option("allow_once") != "" {
		out = append(out, AskChoice{Key: "1", Label: "Yes"})
	}
	if r.option("allow_always") != "" {
		out = append(out, AskChoice{Key: "2", Label: "Yes, and don't ask again this session"})
	}
	if r.option("reject_once", "reject_always") != "" {
		out = append(out, AskChoice{Key: "3", Label: "No"})
	}
	return out
}

func (c *acpConv) setMode(ctx context.Context, mode string) error {
	sid, err := c.awaitSession(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	config := c.modeConfig
	c.mu.Unlock()
	if config != "" {
		_, err = c.call(ctx, "session/set_config_option", map[string]any{"sessionId": sid, "configId": config, "value": mode}, 30*time.Second)
	} else {
		_, err = c.call(ctx, "session/set_mode", map[string]any{"sessionId": sid, "modeId": mode}, 30*time.Second)
	}
	if err == nil {
		c.mu.Lock()
		c.mode = mode
		c.mu.Unlock()
	}
	return err
}

func (d *acpDriver) Send(ctx context.Context, sess Session, text string, enter bool) error {
	c, err := d.conv(sess)
	if err != nil {
		return err
	}
	if r, waiting := c.first(); waiting {
		if isKey(text) && !enter {
			return c.pick(text)
		}
		if strings.TrimSpace(text) != "" {
			if err := c.choose(r, r.option("reject_once", "reject_always")); err != nil {
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
	sid, err := c.awaitSession(ctx)
	if err != nil {
		return err
	}
	_, err = c.call(ctx, "session/prompt", map[string]any{"sessionId": sid, "prompt": []any{map[string]any{"type": "text", "text": text}}}, 0)
	return err
}

func (d *acpDriver) Interrupt(ctx context.Context, sess Session) (bool, error) {
	c, err := d.conv(sess)
	if err != nil {
		return false, err
	}
	c.mu.Lock()
	sid, busy := c.sessionID, c.busy
	c.mu.Unlock()
	if !busy || sid == "" {
		return true, nil
	}
	if err := c.write(ctx, map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": sid}}); err != nil {
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

func (d *acpDriver) Controls(ctx context.Context, sess Session) (Controls, error) {
	c, err := d.conv(sess)
	if err != nil {
		return Controls{Agent: agentFor(sess)}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	mode := c.mode
	if c.bypass {
		mode = "bypassPermissions"
	}
	return Controls{Agent: c.agent, Mode: mode, Modes: append(append([]string{}, c.modes...), "bypassPermissions")}, nil
}

func (d *acpDriver) SetMode(ctx context.Context, sess Session, mode string) (string, error) {
	c, err := d.conv(sess)
	if err != nil {
		return "", err
	}
	bypass := mode == "bypassPermissions"
	if !bypass {
		c.mu.Lock()
		known := false
		for _, m := range c.modes {
			known = known || m == mode
		}
		c.mu.Unlock()
		if !known {
			return "", badRequest("unknown mode %q", mode)
		}
		if err := c.setMode(ctx, mode); err != nil {
			return "", err
		}
	}
	c.mu.Lock()
	c.bypass = bypass
	var allow []acpRequest
	if bypass {
		allow = append(allow, c.pending...)
	}
	c.mu.Unlock()
	v := "0"
	if bypass {
		v = "1"
	}
	d.b.Sessions.tmux(ctx, "set-option", "-t", "="+sess.Name+":", labelBypass, v)
	noteConversation(c.conv, func(m *Conversation) { m.Mode = mode })
	for _, r := range allow {
		c.allow(r, false)
	}
	return mode, nil
}

func (d *acpDriver) Answer(ctx context.Context, sess Session, req AnswerRequest) ([]string, error) {
	return nil, httpError{http.StatusConflict, "this agent asks no questions in forms"}
}

func (d *acpDriver) Conversation(ctx context.Context, sess Session, _ []Session, since int, gen string) (transcript.Result, error) {
	if _, err := d.conv(sess); err != nil {
		return transcript.Result{Source: "none", Items: []transcript.Item{}, Crew: []transcript.CrewMember{}, Reason: err.Error()}, nil
	}
	return reader().Follow(transcript.SourceACPHost, filepath.Join(sess.conv, agenthost.LogName), sess.Dir, max(since, 0), gen)
}

func (d *acpDriver) Record(ctx context.Context, sess Session, _ []Session) (string, string) {
	return transcript.SourceACPHost, filepath.Join(sess.conv, agenthost.LogName)
}

func (d *acpDriver) Draft(ctx context.Context, sess Session) (Draft, error) {
	c, err := d.conv(sess)
	if err != nil {
		return Draft{Agent: agentFor(sess)}, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := Draft{Agent: c.agent, Text: c.draft.String()}
	if c.busy && len(c.pending) == 0 {
		out.Status = &DraftStatus{Word: "Working…"}
		if !c.since.IsZero() {
			out.Status.Elapsed = time.Since(c.since).Round(time.Second).String()
		}
	}
	return out, nil
}

func (d *acpDriver) askChoices(sess Session) []AskChoice {
	c, err := d.conv(sess)
	if err != nil {
		return nil
	}
	return c.choices()
}
