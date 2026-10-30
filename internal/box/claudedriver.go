package box

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/transcript"
)

// The Claude driver: Claude Code without its TUI, as `claude -p` speaking
// stream-json both ways, hosted by `berthd agent-host` in the session's
// tmux pane (internal/agenthost). Prompts, interrupts, mode changes and
// answers go in as JSON lines; the conversation, the reply being written
// and every permission Claude asks for come out of the host's log. berthd's
// own hooks stay quiet in these sessions (BERTH_DRIVER): the driver says
// what the agent is doing from the stream instead.
//
// Permissions: Claude always runs in a mode of its own short of bypass,
// with --permission-prompt-tool stdio, so each permission it wants comes
// here. "Bypass" is berthd answering every one of them yes (it works where
// Claude refuses its own bypass, as root); questions and plans always wait
// for a person.

// DriverClaude is a structured Claude Code session.
const DriverClaude = "claude"

// The tmux options a structured session keeps.
const (
	labelDriver = "@berth_driver"
	labelConv   = "@berth_conv"
	labelSock   = "@berth_sock"
	labelBypass = "@berth_bypass"
)

// structuredModes are the modes a structured Claude session offers.
var structuredModes = []string{"default", "acceptEdits", "plan", "auto", "bypassPermissions"}

// interactiveTools always wait for a person, bypass or not.
var interactiveTools = map[string]bool{"AskUserQuestion": true, "ExitPlanMode": true}

// claudeStructuredFlags make claude speak stream-json both ways.
func claudeStructuredFlags(mode string) []string {
	return []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--include-partial-messages", "--replay-user-messages", "--permission-mode", mode, "--permission-prompt-tool", "stdio"}
}

// structuredLaunch is what starts a structured Claude session.
type structuredLaunch struct {
	command string
	env     []string
	labels  map[string]string
	// mode, model and effort are what was asked for; agent the agent.
	mode, model, effort, agent string
}

// launchClaude is the command, environment and labels that start the
// preset's Claude Code under an agent host. mode is the permission mode it
// starts in ("" is default).
func (b *Box) launchClaude(p AgentPreset, model, effort, mode, resume string) (structuredLaunch, error) {
	if p.ID != "claude" {
		return structuredLaunch{}, badRequest("the structured driver runs Claude Code; %s runs in its terminal", p.Name)
	}
	if b.ConversationsDir == "" {
		return structuredLaunch{}, errors.New("this box keeps no conversations")
	}
	switch mode {
	case "":
		mode = "default"
	case "default", "acceptEdits", "plan", "auto", "bypassPermissions":
	default:
		return structuredLaunch{}, badRequest("unknown permission mode %q", mode)
	}
	dir, sock, err := b.newConversation()
	if err != nil {
		return structuredLaunch{}, err
	}
	return b.launchClaudeIn(p, model, effort, mode, resume, dir, sock)
}

// launchClaudeIn is launchClaude keeping its log in dir and listening on
// sock: a new conversation's, or one carrying on (resume).
func (b *Box) launchClaudeIn(p AgentPreset, model, effort, mode, resume, dir, sock string) (structuredLaunch, error) {
	if mode == "" {
		mode = "default"
	}
	base, err := AgentCommandWith(p, "", model, effort)
	if err != nil {
		return structuredLaunch{}, err
	}
	host, err := b.agentHostCommand()
	if err != nil {
		return structuredLaunch{}, err
	}
	claudeMode, bypass := mode, "0"
	if mode == "bypassPermissions" {
		claudeMode, bypass = "default", "1"
	}
	words := make([]string, 0, len(host)+6)
	for _, w := range host {
		words = append(words, shellQuote(w))
	}
	words = append(words, "--dir", shellQuote(dir), "--socket", shellQuote(sock), "--", base)
	for _, f := range claudeStructuredFlags(claudeMode) {
		words = append(words, shellQuote(f))
	}
	if resume != "" {
		// A conversation never prompted, here or in its terminal, has
		// nothing saved to resume (toTerminal): it starts under its ID.
		flag := "--resume"
		if !prompted(dir) {
			flag = "--session-id"
		}
		words = append(words, flag, shellQuote(resume))
	}
	return structuredLaunch{
		mode: mode, model: model, effort: effort, agent: "claude",
		command: strings.Join(words, " "),
		env:     []string{"BERTH_DRIVER=structured"},
		labels:  map[string]string{labelDriver: DriverClaude, labelConv: dir, labelSock: sock, labelBypass: bypass},
	}, nil
}

// ownedByMe says the box user owns a file.
func ownedByMe(st os.FileInfo) bool {
	sys, ok := st.Sys().(*syscall.Stat_t)
	return ok && int(sys.Uid) == os.Getuid()
}

// agentHostCommand is the command that runs `berthd agent-host`.
func (b *Box) agentHostCommand() ([]string, error) {
	if len(b.AgentHost) > 0 {
		return b.AgentHost, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return []string{exe, "agent-host"}, nil
}

// newConversation makes a new conversation's folder and names its socket.
func (b *Box) newConversation() (dir, sock string, err error) {
	if b.ConversationsDir == "" {
		return "", "", errors.New("this box keeps no conversations")
	}
	id := newConvID()
	dir = filepath.Join(b.ConversationsDir, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	sock, err = hostSocket(id)
	return dir, sock, err
}

func newConvID() string {
	var b [6]byte
	rand.Read(b[:])
	return strconv.FormatInt(time.Now().Unix(), 36) + "-" + hex.EncodeToString(b[:])
}

// hostSocket is where a host listens: under /tmp, as a unix socket's path
// is limited to about 100 bytes and a state folder's can be longer. The
// folder is the box user's alone.
func hostSocket(id string) (string, error) {
	dir := filepath.Join("/tmp", "berth-"+strconv.Itoa(os.Getuid()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if st, err := os.Lstat(dir); err != nil || !st.IsDir() || st.Mode().Perm()&0o077 != 0 || !ownedByMe(st) {
		return "", fmt.Errorf("%s is not this user's own folder", dir)
	}
	return filepath.Join(dir, id+".sock"), nil
}

// claudeRequest is a permission Claude asks for (can_use_tool).
type claudeRequest struct {
	ID          string          `json:"request_id"`
	Tool        string          `json:"tool_name"`
	ToolUseID   string          `json:"tool_use_id"`
	Input       json.RawMessage `json:"input"`
	Suggestions json.RawMessage `json:"permission_suggestions"`
	Description string          `json:"description"`
	// AgentID names the helper (a subagent working in the background)
	// that asks; "" when it is the agent itself.
	AgentID string `json:"agent_id"`
}

// claudeConv is what berthd knows of one structured session, from its log.
type claudeConv struct {
	b    *Box
	name string
	cwd  string
	conv string
	sock string
	log  string

	mu        sync.Mutex
	sessionID string
	mode      string
	bypass    bool
	busy      bool
	since     time.Time
	draft     strings.Builder
	pending   []claudeRequest
	replies   map[string]chan json.RawMessage
	next      int
	lastSeq   int64
	exited    bool
	changed   chan struct{}
	following bool
	// caught is closed once the log as it was is read back: what comes
	// after is new, and is said as it comes.
	caught     chan struct{}
	caughtOnce sync.Once
	// queue is what is to be said, in the order it happened, by speak;
	// kick wakes it. gone stops it, once the session is let go.
	queue []func()
	kick  chan struct{}
	gone  bool
	// account names the Claude Code account the session runs on, and
	// accountDir its folder, once its plan limits are first recorded.
	// Only speak uses them (recordLimits).
	account, accountDir string
}

// claudeDriver holds the structured sessions berthd follows.
type claudeDriver struct {
	b     *Box
	mu    sync.Mutex
	convs map[string]*claudeConv
}

func (b *Box) claude() *claudeDriver {
	b.claudeOnce.Do(func() { b.claudeDrv = &claudeDriver{b: b, convs: map[string]*claudeConv{}} })
	return b.claudeDrv
}

func (d *claudeDriver) Kind() string { return DriverClaude }

// forget lets a session's conversation go: it is followed afresh from its
// log when next asked for (a session switching to its terminal and back).
func (d *claudeDriver) forget(name string) {
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

// speak says what the log said, one thing after another, in its order.
func (c *claudeConv) speak() {
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

// conv is the session's, followed from its log from the first time it is
// asked for.
func (d *claudeDriver) conv(sess Session) (*claudeConv, error) {
	if sess.conv == "" || sess.sock == "" {
		return nil, errors.New(sess.Name + " has no structured conversation")
	}
	d.mu.Lock()
	c := d.convs[sess.Name]
	if c == nil || c.conv != sess.conv {
		c = &claudeConv{b: d.b, name: sess.Name, cwd: sess.Dir, conv: sess.conv, sock: sess.sock,
			log: filepath.Join(sess.conv, agenthost.LogName), replies: map[string]chan json.RawMessage{}, changed: make(chan struct{}), caught: make(chan struct{}),
			kick: make(chan struct{}, 1)}
		go c.speak()
		d.convs[sess.Name] = c
	}
	d.mu.Unlock()
	c.mu.Lock()
	if !c.following {
		c.following = true
		c.bypass = sess.bypass
		go c.follow()
	}
	c.mu.Unlock()
	return c, nil
}

// follow reads the log: what is in it already without saying anything (it
// happened before), then each new entry as it comes, saying what the agent
// does. When the host has gone, the log is all there is.
func (c *claudeConv) follow() {
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
			// go, so it is followed again when next asked for: a session
			// started again on this log is asked for before its host
			// listens, and would otherwise never be followed.
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
		// No host: one still starting, or one gone. What it wrote last
		// says which; one that died without a word is let go after a
		// while, and followed again when next asked for.
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

// hostGone is how long a host may not answer before berthd stops
// following its session (until it is asked about again).
const hostGone = time.Minute

// signal wakes whoever waits on a change. Called with c.mu held.
func (c *claudeConv) signal() {
	close(c.changed)
	c.changed = make(chan struct{})
}

// streamLine is the part of a stream-json line the driver reads.
type streamLine struct {
	Type           string          `json:"type"`
	Subtype        string          `json:"subtype"`
	SessionID      string          `json:"session_id"`
	PermissionMode string          `json:"permissionMode"`
	Parent         *string         `json:"parent_tool_use_id"`
	IsReplay       bool            `json:"isReplay"`
	IsError        bool            `json:"is_error"`
	Message        json.RawMessage `json:"message"`
	Event          *struct {
		Type  string `json:"type"`
		Delta *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
	Response  *struct {
		RequestID string          `json:"request_id"`
		Subtype   string          `json:"subtype"`
		Error     string          `json:"error"`
		Response  json.RawMessage `json:"response"`
	} `json:"response"`
	RateLimit json.RawMessage `json:"rate_limit_info"`
}

// apply reads one log entry into what the driver knows; live, it also says
// what changed.
func (c *claudeConv) apply(e agenthost.Entry, live bool) {
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
			// A host started again (resumed, or back from its terminal).
			c.busy, c.pending, c.since, c.exited = false, nil, time.Time{}, false
			say = append(say, func() { c.event(adapters.Ready, nil, nil) })
		case "exited":
			c.exited, c.busy, c.pending = true, false, nil
			say = append(say, func() { c.event(adapters.Exited, nil, nil) })
		}
		return
	case "in":
		var l streamLine
		if json.Unmarshal(e.Data, &l) == nil && l.Type == "control_response" && l.Response != nil {
			if c.drop(l.Response.RequestID) && live {
				// Answered: the tool runs, or the agent goes on without it,
				// unless another permission still waits for the person.
				say = append(say, c.afterAsk())
			}
		}
		return
	case "out":
	default:
		return
	}
	var l streamLine
	if len(e.Data) == 0 || json.Unmarshal(e.Data, &l) != nil {
		return
	}
	if l.SessionID != "" && l.SessionID != c.sessionID {
		c.sessionID = l.SessionID
		if live {
			sid, dir := l.SessionID, c.conv
			say = append(say, func() { noteConversation(dir, func(m *Conversation) { m.AgentSessionID = sid }) })
		}
	}
	helper := l.Parent != nil && *l.Parent != ""
	switch l.Type {
	case "system":
		if l.Subtype == "init" || l.PermissionMode != "" {
			if l.PermissionMode != "" {
				c.mode = l.PermissionMode
			}
		}
		if l.Subtype == "compact_boundary" {
			say = append(say, c.changedConversation)
		}
	case "stream_event":
		if helper || l.Event == nil {
			return
		}
		switch {
		case l.Event.Type == "message_start":
			c.draft.Reset()
			if !c.busy {
				// A turn no prompt started: Claude goes on by itself, as
				// when a helper it left working in the background is back.
				c.busy, c.since = true, time.UnixMilli(e.At)
				say = append(say, func() { c.event(adapters.Started, map[string]any{"signal": "background"}, nil) })
			}
		case l.Event.Type == "content_block_delta" && l.Event.Delta != nil && l.Event.Delta.Type == "text_delta":
			if c.draft.Len() < maxDraft {
				c.draft.WriteString(l.Event.Delta.Text)
			}
		}
	case "assistant":
		if !helper {
			c.draft.Reset()
		}
		say = append(say, c.changedConversation)
	case "user":
		if !helper && l.IsReplay {
			if text, ok := promptText(l.Message); ok && !c.busy {
				c.busy, c.since = true, time.UnixMilli(e.At)
				title := adapters.Title(text)
				say = append(say, func() {
					// The send that started it is said first.
					if c.b.Turns != nil {
						c.b.Turns.AwaitSent(c.name, 2*time.Second)
					}
					c.event(adapters.Started, map[string]any{"signal": "prompt"}, map[string]any{"title": title})
				})
			}
		}
		say = append(say, c.changedConversation)
	case "control_request":
		var r claudeRequest
		var head struct {
			Subtype string `json:"subtype"`
		}
		json.Unmarshal(l.Request, &head)
		if head.Subtype != "can_use_tool" || json.Unmarshal(l.Request, &r) != nil {
			return
		}
		r.ID = l.RequestID
		if live && c.bypass && !interactiveTools[r.Tool] {
			go c.answer(r, true, false, "")
			return
		}
		c.pending = append(c.pending, r)
		// What shows is the oldest still waiting: the one an answer answers
		// (pick). A helper asking meanwhile waits its turn behind it.
		r = c.pending[0]
		ask := r.ask(c.cwd)
		say = append(say, func() {
			c.event(adapters.Waiting, map[string]any{"reason": askReason(r)}, map[string]any{adapters.AskKey: ask})
		})
	case "rate_limit_event":
		// How much of the account's plan limits is used, kept where the
		// Usage plugin reads it. Said only live, as all of this: a log read
		// back after a restart holds old readings.
		if len(l.RateLimit) > 0 {
			info, at := l.RateLimit, time.UnixMilli(e.At)
			say = append(say, func() { c.recordLimits(at, info) })
		}
	case "control_cancel_request":
		// Withdrawn: a helper that asked was stopped, or the turn was.
		if c.drop(l.RequestID) && live {
			say = append(say, c.afterAsk())
		}
	case "control_response":
		if l.Response != nil {
			if ch := c.replies[l.Response.RequestID]; ch != nil {
				delete(c.replies, l.Response.RequestID)
				if l.Response.Subtype == "error" {
					msg, _ := json.Marshal(map[string]string{"error": l.Response.Error})
					ch <- msg
				} else {
					ch <- l.Response.Response
				}
			}
		}
	case "result":
		if helper {
			return
		}
		// The turn ends, but a helper still working in the background may
		// be waiting for the person: its permission stays, and so does the
		// wait, for Claude goes on once it is answered.
		var helpers []claudeRequest
		for _, r := range c.pending {
			if r.AgentID != "" {
				helpers = append(helpers, r)
			}
		}
		c.busy, c.pending, c.since = false, helpers, time.Time{}
		c.draft.Reset()
		if len(helpers) > 0 {
			r := helpers[0]
			ask := r.ask(c.cwd)
			say = append(say, c.changedConversation, func() {
				c.event(adapters.Waiting, map[string]any{"reason": askReason(r)}, map[string]any{adapters.AskKey: ask})
			})
			return
		}
		data := map[string]any{}
		if l.IsError {
			data["status"] = "error"
			if l.Subtype == "error_during_execution" {
				data["status"] = "interrupted"
			}
		}
		dir := c.conv
		say = append(say, func() { c.event(adapters.Finished, data, nil) }, c.changedConversation,
			func() { noteConversation(dir, func(m *Conversation) { m.Updated = time.Now().UTC() }) })
	}
}

// afterAsk is what is said once a permission is answered or withdrawn:
// the next one still waiting, or working again, or (the turn having ended
// while a helper asked) done. Called with c.mu held.
func (c *claudeConv) afterAsk() func() {
	if len(c.pending) > 0 {
		r := c.pending[0]
		ask := r.ask(c.cwd)
		return func() {
			c.event(adapters.Waiting, map[string]any{"reason": askReason(r)}, map[string]any{adapters.AskKey: ask})
		}
	}
	if c.busy {
		return func() { c.event(adapters.Started, map[string]any{"signal": "tool"}, nil) }
	}
	return func() { c.event(adapters.Finished, nil, nil) }
}

// drop forgets a permission that was answered or withdrawn, and says
// whether it was waiting. Called with c.mu held.
func (c *claudeConv) drop(id string) bool {
	for i, r := range c.pending {
		if r.ID == id {
			c.pending = append(c.pending[:i], c.pending[i+1:]...)
			return true
		}
	}
	return false
}

// reconcile tells the ledger what the log says now, after a restart read
// it back: a turn the agent ended, or one it still works on or waits in.
func (c *claudeConv) reconcile() {
	c.mu.Lock()
	busy, pending, exited, bypass := c.busy, append([]claudeRequest(nil), c.pending...), c.exited, c.bypass
	c.mu.Unlock()
	if exited {
		return
	}
	if bypass {
		// Asked while berthd was away: allowed now, as it would have been.
		kept := pending[:0]
		for _, r := range pending {
			if interactiveTools[r.Tool] {
				kept = append(kept, r)
				continue
			}
			go c.answer(r, true, false, "")
		}
		pending = kept
	}
	if c.b.Turns == nil {
		return
	}
	st, _ := c.b.Turns.State(c.name)
	switch {
	case len(pending) > 0 && st.State != "waiting":
		c.event(adapters.Waiting, map[string]any{"reason": askReason(pending[0])}, map[string]any{adapters.AskKey: pending[0].ask(c.cwd)})
	case busy && len(pending) == 0 && st.State != "running":
		c.event(adapters.Started, map[string]any{"signal": "tool"}, nil)
	case !busy && (st.State == "running" || st.State == "waiting"):
		c.event(adapters.Finished, nil, nil)
	}
}

// promptText is a person's prompt in a user message: text, not a tool's
// result or Claude Code's own note.
func promptText(raw json.RawMessage) (string, bool) {
	var m struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return "", false
	}
	var s string
	if json.Unmarshal(m.Content, &s) == nil {
		return s, s != "" && !strings.HasPrefix(s, "<local-command") && !strings.HasPrefix(s, "<command-")
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(m.Content, &blocks) != nil {
		return "", false
	}
	var text []string
	for _, b := range blocks {
		switch b.Type {
		case "tool_result":
			return "", false
		case "text":
			text = append(text, b.Text)
		}
	}
	s = strings.Join(text, "\n")
	return s, s != "" && !strings.HasPrefix(s, "[Request interrupted")
}

func askReason(r claudeRequest) string {
	if r.Tool == "AskUserQuestion" {
		return "question"
	}
	return "permission"
}

// ask is what a permission asks, as a hook's ask is (adapters).
func (r claudeRequest) ask(cwd string) map[string]any {
	payload, _ := json.Marshal(map[string]any{"cwd": cwd, "tool_name": r.Tool, "tool_input": json.RawMessage(r.Input)})
	e, ok := translateClaude("PermissionRequest", payload)
	ask, _ := e[adapters.AskKey].(map[string]any)
	if !ok || ask == nil {
		ask = map[string]any{"tool": r.Tool}
	}
	if r.Tool == "ExitPlanMode" {
		ask["message"] = "Claude has a plan and is ready to start"
	}
	return ask
}

// translateClaude is a hook's translation of a Claude Code hook payload.
func translateClaude(hook string, payload []byte) (map[string]any, bool) {
	var in adapters.Payload
	json.Unmarshal(payload, &in)
	_, d, ok := adapters.Claude.Translate(hook, in)
	return d, ok
}

// event says what the agent does, as its hooks would: on the box's bus,
// for its turns, from Claude.
func (c *claudeConv) event(typ string, data, private map[string]any) {
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
	c.b.agentEvent(context.Background(), "claude", typ, data, private)
}

// changedConversation tells a chat showing the conversation to read it.
func (c *claudeConv) changedConversation() {
	c.b.Events.Publish(events.Event{Type: events.TranscriptChanged, Box: c.b.Name, Data: map[string]any{"session": c.name, "name": c.name, "path": c.cwd}})
}

// write gives Claude one JSON line, once the log is read back: what Claude
// answers is then read as new.
func (c *claudeConv) write(ctx context.Context, v any) error {
	select {
	case <-c.caught:
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(10 * time.Second):
		return httpError{http.StatusServiceUnavailable, "still reading " + c.name + "'s log back"}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	// A host starting (just launched, or back from its terminal) is
	// waited for a moment.
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

// control sends Claude a control request and waits for its answer.
func (c *claudeConv) control(ctx context.Context, request map[string]any) (json.RawMessage, error) {
	c.mu.Lock()
	c.next++
	id := "berth-" + strconv.Itoa(c.next) + "-" + newConvID()
	ch := make(chan json.RawMessage, 1)
	c.replies[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.replies, id)
		c.mu.Unlock()
	}()
	if err := c.write(ctx, map[string]any{"type": "control_request", "request_id": id, "request": request}); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	select {
	case r := <-ch:
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(r, &e) == nil && e.Error != "" {
			return nil, httpError{http.StatusConflict, "Claude refused: " + e.Error}
		}
		return r, nil
	case <-ctx.Done():
		return nil, httpError{http.StatusGatewayTimeout, "Claude didn't answer"}
	}
}

// answer answers a permission: allowed (always, for the rest of the
// session, when asked so), or denied with what to do instead.
func (c *claudeConv) answer(r claudeRequest, allow, always bool, message string) error {
	resp := map[string]any{"behavior": "deny", "message": firstNonEmpty(message, "The person said no.")}
	if allow {
		resp = map[string]any{"behavior": "allow", "updatedInput": json.RawMessage(r.Input)}
		if always && len(r.Suggestions) > 0 {
			resp["updatedPermissions"] = sessionOnly(r.Suggestions)
		}
	}
	return c.respond(r, resp)
}

func (c *claudeConv) respond(r claudeRequest, resp map[string]any) error {
	err := c.write(context.Background(), map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": r.ID, "response": resp,
	}})
	// Working again is said when the answer is read back from the log
	// (apply), before anything the agent says after it.
	return err
}

// sessionOnly keeps "don't ask again" to this session: Claude suggests
// rules for the project's settings file.
func sessionOnly(raw json.RawMessage) json.RawMessage {
	var sug []map[string]any
	if json.Unmarshal(raw, &sug) != nil {
		return raw
	}
	for _, s := range sug {
		s["destination"] = "session"
	}
	b, _ := json.Marshal(sug)
	return b
}

// first is the oldest permission still waiting.
func (c *claudeConv) first() (claudeRequest, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) == 0 {
		return claudeRequest{}, false
	}
	return c.pending[0], true
}

// planChoices answer Claude's plan; permissionChoices any other permission.
var (
	permissionChoices = []AskChoice{{Key: "1", Label: "Yes"}, {Key: "2", Label: "Yes, and don't ask again this session"}, {Key: "3", Label: "No"}}
	planChoices       = []AskChoice{{Key: "1", Label: "Yes, and auto-accept edits"}, {Key: "2", Label: "Yes, and approve each edit"}, {Key: "3", Label: "No, keep planning"}}
)

// AskChoice is one answer a waiting agent offers, by the key that picks it.
type AskChoice struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// choices are the answers the oldest permission offers, by key.
func (c *claudeConv) choices() []AskChoice {
	r, ok := c.first()
	switch {
	case !ok, r.Tool == "AskUserQuestion":
		return nil
	case r.Tool == "ExitPlanMode":
		return planChoices
	}
	return permissionChoices
}

// pick answers the oldest permission with the choice its key names.
func (c *claudeConv) pick(ctx context.Context, key string) error {
	r, ok := c.first()
	if !ok {
		return httpError{http.StatusConflict, "Claude isn't asking for anything"}
	}
	if r.Tool == "AskUserQuestion" {
		return httpError{http.StatusConflict, "Claude asked questions: answer them in the chat"}
	}
	if r.Tool == "ExitPlanMode" {
		switch key {
		case "1", "2":
			mode := "acceptEdits"
			if key == "2" {
				mode = "default"
			}
			return c.respond(r, map[string]any{"behavior": "allow", "updatedInput": json.RawMessage(r.Input),
				"updatedPermissions": []map[string]any{{"type": "setMode", "mode": mode, "destination": "session"}}})
		case "3":
			return c.answer(r, false, false, "The person wants to keep planning.")
		}
		return badRequest("pick 1, 2 or 3")
	}
	switch key {
	case "1", "y", "Y":
		return c.answer(r, true, false, "")
	case "2":
		return c.answer(r, true, true, "")
	case "3", "n", "N":
		return c.answer(r, false, false, "")
	}
	return badRequest("pick 1, 2 or 3")
}

func (d *claudeDriver) Send(ctx context.Context, sess Session, text string, enter bool) error {
	c, err := d.conv(sess)
	if err != nil {
		return err
	}
	if r, waiting := c.first(); waiting {
		if isKey(text) && !enter {
			return c.pick(ctx, text)
		}
		if strings.TrimSpace(text) != "" {
			// Typed at a permission (sent with force): no, and this instead.
			return c.answer(r, false, false, "The person said no, and: "+text)
		}
	}
	if !enter {
		return badRequest("a structured session takes whole messages")
	}
	if strings.TrimSpace(text) == "" {
		return nil
	}
	return c.write(ctx, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
}

func (d *claudeDriver) Interrupt(ctx context.Context, sess Session) (bool, error) {
	c, err := d.conv(sess)
	if err != nil {
		return false, err
	}
	if _, err := c.control(ctx, map[string]any{"subtype": "interrupt"}); err != nil {
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

func (d *claudeDriver) Controls(ctx context.Context, sess Session) (Controls, error) {
	c, err := d.conv(sess)
	if err != nil {
		return Controls{Agent: "claude"}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	mode := firstNonEmpty(c.mode, "default")
	if c.bypass {
		mode = "bypassPermissions"
	}
	return Controls{Agent: "claude", Mode: mode, Modes: structuredModes}, nil
}

func (d *claudeDriver) SetMode(ctx context.Context, sess Session, mode string) (string, error) {
	c, err := d.conv(sess)
	if err != nil {
		return "", err
	}
	known := false
	for _, m := range structuredModes {
		known = known || m == mode
	}
	if !known {
		return "", badRequest("unknown permission mode %q", mode)
	}
	bypass := mode == "bypassPermissions"
	claudeMode := mode
	if bypass {
		claudeMode = "default"
	}
	c.mu.Lock()
	current := firstNonEmpty(c.mode, "default")
	c.mu.Unlock()
	if current != claudeMode {
		if _, err := c.control(ctx, map[string]any{"subtype": "set_permission_mode", "mode": claudeMode}); err != nil {
			return "", err
		}
		c.mu.Lock()
		c.mode = claudeMode
		c.mu.Unlock()
	}
	c.mu.Lock()
	c.bypass = bypass
	var allow []claudeRequest
	if bypass {
		for _, r := range c.pending {
			if !interactiveTools[r.Tool] {
				allow = append(allow, r)
			}
		}
	}
	c.mu.Unlock()
	v := "0"
	if bypass {
		v = "1"
	}
	d.b.Sessions.tmux(ctx, "set-option", "-t", "="+sess.Name+":", labelBypass, v)
	noteConversation(c.conv, func(m *Conversation) { m.Mode = mode })
	for _, r := range allow {
		c.answer(r, true, false, "")
	}
	return mode, nil
}

func (d *claudeDriver) Answer(ctx context.Context, sess Session, req AnswerRequest) ([]string, error) {
	c, err := d.conv(sess)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	var r claudeRequest
	found := false
	for _, p := range c.pending {
		if p.Tool == "AskUserQuestion" && p.ToolUseID == req.Tool {
			r, found = p, true
		}
	}
	c.mu.Unlock()
	if !found {
		return nil, httpError{http.StatusConflict, "Claude isn't waiting for those answers"}
	}
	var in struct {
		Questions []struct {
			Question    string `json:"question"`
			Header      string `json:"header"`
			MultiSelect bool   `json:"multiSelect"`
			Options     []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(r.Input, &in); err != nil {
		return nil, err
	}
	qs := make([]transcript.Question, len(in.Questions))
	for i, q := range in.Questions {
		qs[i] = transcript.Question{Question: q.Question, Header: q.Header, Multi: q.MultiSelect}
		for _, o := range q.Options {
			qs[i].Options = append(qs[i].Options, transcript.Option{Label: o.Label, Description: o.Description})
		}
	}
	shown, err := checkAnswers(qs, req.Answers)
	if err != nil {
		return nil, err
	}
	answers := map[string]string{}
	for i, q := range qs {
		answers[q.Question] = shown[i]
	}
	var input map[string]any
	json.Unmarshal(r.Input, &input)
	if input == nil {
		input = map[string]any{}
	}
	input["answers"] = answers
	if err := c.respond(r, map[string]any{"behavior": "allow", "updatedInput": input}); err != nil {
		return nil, err
	}
	return shown, nil
}

func (d *claudeDriver) Conversation(ctx context.Context, sess Session, _ []Session, since int, gen string) (transcript.Result, error) {
	if _, err := d.conv(sess); err != nil {
		return transcript.Result{Source: "none", Items: []transcript.Item{}, Crew: []transcript.CrewMember{}, Reason: err.Error()}, nil
	}
	return reader().Follow(transcript.SourceClaudeHost, filepath.Join(sess.conv, agenthost.LogName), sess.Dir, max(since, 0), gen)
}

func (d *claudeDriver) Record(ctx context.Context, sess Session, _ []Session) (string, string) {
	return transcript.SourceClaudeHost, filepath.Join(sess.conv, agenthost.LogName)
}

// Draft is the reply Claude is streaming, and how long it has worked.
func (d *claudeDriver) Draft(ctx context.Context, sess Session) (Draft, error) {
	c, err := d.conv(sess)
	if err != nil {
		return Draft{Agent: "claude"}, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := Draft{Agent: "claude", Text: c.draft.String()}
	if c.busy && len(c.pending) == 0 {
		out.Status = &DraftStatus{Word: "Working…"}
		if !c.since.IsZero() {
			out.Status.Elapsed = time.Since(c.since).Round(time.Second).String()
		}
	}
	return out, nil
}

// askChoices are the answers a waiting structured session offers.
func (d *claudeDriver) askChoices(sess Session) []AskChoice {
	c, err := d.conv(sess)
	if err != nil {
		return nil
	}
	return c.choices()
}

// follow starts following a structured session's log, for its driver.
func (b *Box) follow(sess Session) {
	switch sess.Driver {
	case DriverClaude:
		b.claude().conv(sess)
	case DriverCodex:
		b.codex().conv(sess)
	case DriverACP:
		b.acp().conv(sess)
	}
}

// forgetConversation lets a structured session's conversation go, for
// whichever driver follows it.
func (b *Box) forgetConversation(name string) {
	b.claude().forget(name)
	b.codex().forget(name)
	b.acp().forget(name)
}

// hostAlive says whether a host answers on sock.
func hostAlive(sock string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, err := agenthost.Dial(ctx, sock)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// awaitHost waits up to d for a session's host to listen.
func awaitHost(sock string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if c, err := agenthost.Dial(context.Background(), sock); err == nil {
			c.Close()
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

// startStructured gives a new structured session its first prompt once its
// host listens.
func (b *Box) startStructured(origin, from string, sess Session, prompt string) {
	go func() {
		awaitHost(sess.sock, 30*time.Second)
		// Followed from its start, so its first turn is said as it goes.
		b.follow(sess)
		if strings.TrimSpace(prompt) == "" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		b.sendPrompt(ctx, sess.Name, SendRequest{Text: prompt, When: "now"}, origin, from)
	}()
}
