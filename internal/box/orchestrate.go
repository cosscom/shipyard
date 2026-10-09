package box

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/groups"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
)

// The pieces agents, hooks and the app orchestrate with: type into a session,
// wait for its agent, and run a check in a worktree.

// Send types text into a session as one paste, then presses Enter if asked.
// A paste keeps a multi-line prompt from being submitted line by line.
func (s *Sessions) Send(ctx context.Context, name, text string, enter bool) error {
	if sess, err := s.Get(ctx, name); err != nil {
		return err
	} else if sess.Exited {
		return ErrSessionExited
	}
	if text != "" && !enter && isKey(text) {
		// An answer to a menu (a number, y, n) is a keystroke: agents' menus
		// ignore a pasted one.
		if out, err := s.tmux(ctx, "send-keys", "-t", "="+name+":", "-l", text); err != nil {
			return tmuxSendError("send-keys", out, err)
		}
		return nil
	}
	if text != "" {
		// The text goes to tmux on stdin, never on its command line, which
		// tmux caps at about 16 KB: a prompt can be far longer.
		buf := "berth-send-" + name
		load, cctx, cancel, err := s.tmuxCommand(ctx, "load-buffer", "-b", buf, "-")
		if err != nil {
			return err
		}
		load.Stdin = strings.NewReader(text)
		out, err := runTmux(ctx, cctx, load)
		cancel()
		if err != nil {
			return tmuxSendError("load-buffer", out, err)
		}
		if out, err := s.tmux(ctx, "paste-buffer", "-p", "-d", "-b", buf, "-t", "="+name+":"); err != nil {
			return tmuxSendError("paste-buffer", out, err)
		}
	}
	if enter {
		// Agents' input boxes need a moment to take a paste before Enter
		// submits it rather than adding a newline.
		time.Sleep(150 * time.Millisecond)
		if out, err := s.tmux(ctx, "send-keys", "-t", "="+name+":", "Enter"); err != nil {
			return tmuxSendError("send-keys", out, err)
		}
	}
	return nil
}

// tmuxSendError is a failed send. A pane whose program ended between the
// check and the send is ErrSessionExited, with tmux's words kept after it.
func tmuxSendError(cmd string, out []byte, err error) error {
	msg := strings.TrimSpace(string(out))
	if exitedPane(msg) {
		return fmt.Errorf("%w (tmux %s: %s)", ErrSessionExited, cmd, msg)
	}
	return tmuxError(cmd, out, err)
}

// literalChunk is the most text one send-keys -l carries: tmux refuses a
// command line over about 16 KB, and a character can take 4 bytes.
const literalChunk = 2048

// literalChunks splits text for send-keys -l, on character boundaries.
func literalChunks(text string) []string {
	var out []string
	for len(text) > literalChunk {
		cut := literalChunk
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		out = append(out, text[:cut])
		text = text[cut:]
	}
	return append(out, text)
}

// isKey says whether text is one key to press rather than text to paste:
// a single letter or digit, as a menu's answer is.
func isKey(text string) bool {
	if len(text) != 1 {
		return false
	}
	c := text[0]
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// SendRequest types a prompt into a session.
//
// When is "now" (type it at once) or "idle" (hold it in the box's inbox for
// the session, typed once the agent is idle or finished). A request that
// gives When never types into an agent waiting for someone (a permission or
// a question) unless Force: an Enter there would pick an answer for the
// person. Requests without When, from older clients, type at once as
// before. IdemKey makes a retried send return the turn it already made.
type SendRequest struct {
	Text    string `json:"text"`
	Enter   *bool  `json:"enter,omitempty"`
	When    string `json:"when,omitempty"`
	Force   bool   `json:"force,omitempty"`
	IdemKey string `json:"idem_key,omitempty"`
}

// SendResult names the turn a send started or queued, the journal Seq of
// the send, and the box's time, which callers wait from rather than their
// own clock.
type SendResult struct {
	Sent      bool      `json:"sent"`
	Queued    bool      `json:"queued,omitempty"`
	Duplicate bool      `json:"duplicate,omitempty"`
	Turn      string    `json:"turn,omitempty"`
	Seq       int64     `json:"seq,omitempty"`
	At        time.Time `json:"at"`
}

// ErrAgentWaiting refuses to type into an agent that waits for someone.
type ErrAgentWaiting struct{ Session string }

func (e ErrAgentWaiting) Error() string {
	return e.Session + " is waiting for someone to answer it (a permission or a question); answer it at the terminal, or send with force to type anyway"
}

func (b *Box) sendToSession(w http.ResponseWriter, r *http.Request) error {
	var req SendRequest
	if err := decodeLimit(r, &req, maxPromptBody); err != nil {
		return err
	}
	name := r.PathValue("name")
	if err := b.before(r, "session.send", map[string]any{"name": name}); err != nil {
		return err
	}
	res, err := b.sendPrompt(r.Context(), name, req, origin(r), gateOrigin(r))
	if err != nil {
		return err
	}
	if res.Turn != "" {
		b.watchCaller(r, Watch{Kind: "turn", Session: name, Turn: res.Turn})
	}
	writeJSON(w, res)
	return nil
}

// sendPrompt is send for the API and flows: it checks the agent can take
// the prompt, types or queues it, and returns its turn.
func (b *Box) sendPrompt(ctx context.Context, name string, req SendRequest, origin, from string) (SendResult, error) {
	enter := req.Enter == nil || *req.Enter
	switch req.When {
	case "", "now", "idle":
	default:
		return SendResult{}, badRequest("when must be now or idle")
	}
	defer b.lockSend(name)()
	if b.Turns != nil {
		if tr, ok := b.Turns.ByIdem(name, req.IdemKey); ok {
			return SendResult{Sent: tr.State != "queued", Queued: tr.State == "queued", Duplicate: true, Turn: tr.ID, Seq: tr.SentSeq, At: time.Now().UTC()}, nil
		}
	}
	sess, err := b.Sessions.Get(ctx, name)
	if err != nil {
		return SendResult{}, err
	}
	if sess.Exited {
		// Typed now or queued for later, nothing would ever read it.
		return SendResult{}, ErrSessionExited
	}
	hold := func() (SendResult, error) {
		tr, err := b.Turns.Queue(name, req.Text, enter, from, req.IdemKey)
		if err != nil {
			return SendResult{}, err
		}
		e := b.Events.Publish(events.Event{Type: "session.queued", Box: b.Name, Origin: origin, Data: map[string]any{"name": name, "turn": tr.ID}})
		return SendResult{Queued: true, Turn: tr.ID, Seq: e.Seq, At: e.Time.UTC()}, nil
	}
	if agent := agentFor(sess); agent != "" {
		// A new agent reads nothing until it has drawn. At its startup
		// question (startup.go) a prompt is held for it, now or idle:
		// typed, the question drops it and its Enter answers. A key alone,
		// or Enter, is someone answering. Text meant for the question
		// (forced, or a key and Enter) is no answer it takes: refused.
		b.awaitDrawn(ctx, name)
		if req.Text != "" && !(isKey(req.Text) && !enter) && b.atStartupQuestion(ctx, Session{Name: name, Agent: agent}) {
			if b.Turns == nil || req.Force || isKey(req.Text) {
				return SendResult{}, startupText(agent)
			}
			return hold()
		}
	}
	waiting := ""
	if b.Turns != nil {
		if st := b.enrich(ctx, []Session{sess})[0]; st.AgentState == "waiting" && !b.Turns.SoftWait(name) {
			waiting = st.Turn
		}
	}
	if waiting != "" && req.When == "now" && !req.Force {
		return SendResult{}, httpError{http.StatusConflict, ErrAgentWaiting{name}.Error()}
	}
	if b.Turns != nil && req.When == "idle" && !b.Turns.Ready(name) {
		return hold()
	}
	if err := b.Sessions.Send(ctx, name, req.Text, enter); err != nil {
		return SendResult{}, err
	}
	// Only that something was sent: prompts never go into events.
	data := map[string]any{"name": name, "from": from}
	if c, local := localCommand(sessionAgent(sess), req.Text); local && enter && waiting == "" {
		// The agent's own command (/cost, /model): its program answers, no
		// turn starts, so none is opened to wait for.
		data["command"] = c
	}
	if req.IdemKey != "" {
		data["idem_key"] = req.IdemKey
	}
	if waiting != "" {
		// Typed at a question: an answer, part of the turn that asked.
		data["answer"], data["turn"] = true, waiting
	}
	e := b.Events.Publish(events.Event{Type: "session.sent", Box: b.Name, Origin: origin, Data: data})
	res := SendResult{Sent: true, Seq: e.Seq, At: e.Time.UTC()}
	if waiting != "" {
		res.Turn = waiting
		return res, nil
	}
	if enter && sess.Title == "" && commandName(req.Text) == "" {
		b.nameAfter(ctx, name, adapters.Title(req.Text))
	}
	if b.Turns != nil {
		if tr, ok := b.Turns.ForSent(name, e.Seq); ok {
			res.Turn = tr.ID
			if tr.State == "running" && tr.Fidelity != "hooks" {
				// The agent cannot say it started: the send says so, so the
				// guard, Review and hooks see it working.
				b.Events.Publish(events.Event{Type: "agent.started", Box: b.Name, Origin: origin, Data: map[string]any{
					"session": name, "path": sess.Dir, "agent": tr.Agent, "source": "send", "turn": tr.ID,
				}})
			}
		}
	}
	return res, nil
}

// WaitResult is what an agent was doing when a wait ended.
type WaitResult struct {
	State    string `json:"state"`
	TimedOut bool   `json:"timed_out"`
	// Turn is the turn the state belongs to, when the box keeps turns.
	Turn string `json:"turn,omitempty"`
}

func waitTimeout(v string, def time.Duration) (time.Duration, error) {
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		secs, err2 := strconv.Atoi(v)
		if err2 != nil {
			return 0, badRequest("timeout %q is not a duration", v)
		}
		d = time.Duration(secs) * time.Second
	}
	return min(max(d, time.Second), time.Hour), nil
}

// waitForSession long-polls until the session's agent reports one of the
// wanted states after a given time, its program exits, or the timeout ends.
// The time is placed in the journal's order, so a caller whose clock runs
// ahead of the box's still sees the turn end.
func (b *Box) waitForSession(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	q := r.URL.Query()
	want := map[string]bool{}
	for _, s := range strings.Split(q.Get("for"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			want[s] = true
		}
	}
	if len(want) == 0 {
		want = map[string]bool{"finished": true, "waiting": true}
	}
	timeout, err := waitTimeout(q.Get("timeout"), 10*time.Minute)
	if err != nil {
		return err
	}
	var after time.Time
	if v := q.Get("after"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return badRequest("after %q is not an RFC 3339 time", v)
		}
		after = t
	}
	var afterSeq int64
	if !after.IsZero() && b.Events.Journal != nil {
		if s, ok := b.Events.Journal.SeqAt(after); ok {
			afterSeq = s
		}
	} else if !after.IsZero() && b.Events.Sequence && after.After(time.Now()) {
		afterSeq = b.Events.Head() + 1
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	last := ""
	lastTurn := ""
	for {
		var changed <-chan struct{}
		if b.Turns != nil {
			changed = b.Turns.Changed()
		}
		sess, err := b.Sessions.Get(ctx, name)
		if err != nil && ctx.Err() == nil {
			return err
		}
		if err == nil {
			s := b.enrich(ctx, []Session{sess})[0]
			if s.Exited {
				writeJSON(w, WaitResult{State: "exited", Turn: s.Turn})
				return nil
			}
			if s.AgentState != "" {
				last, lastTurn = s.AgentState, s.Turn
			}
			fresh := s.StateSince.After(after)
			if afterSeq > 0 {
				fresh = s.StateSeq >= afterSeq
			}
			if want[s.AgentState] && fresh {
				writeJSON(w, WaitResult{State: s.AgentState, Turn: s.Turn})
				return nil
			}
		}
		select {
		case <-ctx.Done():
			if r.Context().Err() != nil {
				return nil // the caller went away
			}
			// The last state seen, never an empty one.
			if last == "" {
				last = "running"
			}
			writeJSON(w, WaitResult{State: last, TimedOut: true, Turn: lastTurn})
			return nil
		case <-changed:
		case <-tick.C:
		}
	}
}

// TurnWait is what a turn wait returns.
type TurnWait struct {
	Turn     Turn   `json:"turn"`
	State    string `json:"state"`
	TimedOut bool   `json:"timed_out"`
}

func (b *Box) getTurn(w http.ResponseWriter, r *http.Request) error {
	if b.Turns == nil {
		return httpError{http.StatusNotImplemented, "this box keeps no turns"}
	}
	tr, ok := b.Turns.Get(r.PathValue("id"))
	if !ok {
		return errUnknownTurn
	}
	writeJSON(w, tr)
	return nil
}

// waitTurn long-polls until a turn ends (until=end), or also until it waits
// for someone (until=waiting), or the timeout ends. It needs no clock.
func (b *Box) waitTurn(w http.ResponseWriter, r *http.Request) error {
	if b.Turns == nil {
		return httpError{http.StatusNotImplemented, "this box keeps no turns"}
	}
	id := r.PathValue("id")
	q := r.URL.Query()
	until := q.Get("until")
	if until != "" && until != "end" && until != "waiting" {
		return badRequest("until must be end or waiting")
	}
	timeout, err := waitTimeout(q.Get("timeout"), 10*time.Minute)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	// The ledger hears of an agent that exits from the screen; look every
	// few seconds so a wait does not outlive its session.
	name, _, _ := strings.Cut(id, "#")
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if s, err := b.Sessions.Get(ctx, name); err == nil && s.Exited {
					b.Turns.Exited(name)
				} else if errors.Is(err, ErrUnknownSession) {
					if all, err := b.Sessions.List(ctx); err == nil {
						b.Turns.Prune(all)
					}
				}
			}
		}
	}()
	tr, timedOut, err := b.Turns.WaitTurn(ctx, id, until == "waiting")
	if err != nil {
		return err
	}
	if timedOut && r.Context().Err() != nil {
		return nil
	}
	writeJSON(w, TurnWait{Turn: tr, State: tr.State, TimedOut: timedOut})
	return nil
}

func (b *Box) listTurns(w http.ResponseWriter, r *http.Request) error {
	if b.Turns == nil {
		return httpError{http.StatusNotImplemented, "this box keeps no turns"}
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	writeJSON(w, b.Turns.List(r.PathValue("name"), min(max(limit, 0), 500)))
	return nil
}

// ExecRequest runs a command to completion in a location or worktree, such
// as the check a loop runs after each of an agent's turns.
type ExecRequest struct {
	Location string `json:"location"`
	Command  string `json:"command"`
	Timeout  string `json:"timeout,omitempty"`
	// Detach answers at once with a run whose result holds the exit code
	// and output, so no caller blocks (or times out) on a long check.
	Detach bool `json:"detach,omitempty"`
}

type ExecResult struct {
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"`
	// Truncated is true when only the end of the output is kept.
	Truncated bool `json:"truncated,omitempty"`
}

const execOutputLimit = 64 << 10

func (b *Box) handleExec(w http.ResponseWriter, r *http.Request) error {
	var req ExecRequest
	if err := decode(r, &req); err != nil {
		return err
	}
	if strings.TrimSpace(req.Command) == "" {
		return badRequest("nothing to run")
	}
	timeout := 10 * time.Minute
	if req.Timeout != "" {
		d, err := time.ParseDuration(req.Timeout)
		if err != nil || d <= 0 {
			return badRequest("timeout %q is not a duration", req.Timeout)
		}
		timeout = min(d, time.Hour)
	}
	dir, err := b.Locations.Dir(r.Context(), req.Location)
	if err != nil {
		return err
	}
	data := map[string]any{"location": req.Location, "path": dir, "command": req.Command}
	if err := b.before(r, "exec", data); err != nil {
		return err
	}
	if req.Detach {
		if b.Runs == nil {
			return badRequest("this box cannot run detached commands")
		}
		vars := map[string]string{"worktree.path": dir}
		if loc, wt, ok := b.worktreeAt(r.Context(), dir); ok {
			vars["location"], vars["worktree.name"], vars["worktree.branch"] = loc.Name, wt.Name, wt.Branch
		}
		t := req.Timeout
		if t == "" {
			t = "30m"
		}
		s, _, err := b.Runs.Start(runs.Request{Template: "exec", Params: map[string]any{"command": req.Command, "timeout": t}, Vars: vars,
			IdemKey: r.Header.Get("Idempotency-Key"), Origin: gateOrigin(r), Path: dir})
		if err != nil {
			return badRequest("%v", err)
		}
		b.watchCaller(r, Watch{Kind: "run", Run: s.ID})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		writeJSON(w, map[string]any{"run": s.ID, "status": s.Status, "detached": true})
		return nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := groups.CommandContext(ctx, shell, "-lc", req.Command)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), b.envForDir(ctx, dir)...)
	var out tailBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	res := ExecResult{}
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		switch {
		case ctx.Err() != nil:
			res.ExitCode = -1
			out.Write([]byte(fmt.Sprintf("\n[berth: stopped after %v]\n", timeout)))
		case errors.As(err, &ee):
			res.ExitCode = ee.ExitCode()
		default:
			return err
		}
	}
	res.Output, res.Truncated = out.String(), out.dropped
	data["exit_code"] = res.ExitCode
	b.publish(r, "exec.finished", data)
	writeJSON(w, res)
	return nil
}

// tailBuffer keeps the last execOutputLimit bytes written to it.
type tailBuffer struct {
	bytes.Buffer
	dropped bool
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	n, _ := t.Buffer.Write(p)
	if over := t.Len() - execOutputLimit; over > 0 {
		t.Next(over)
		t.dropped = true
	}
	return n, nil
}

// HooksDoc is a machine's hooks as the app edits them.
type HooksDoc struct {
	Path  string       `json:"path"`
	Hooks []hooks.Hook `json:"hooks"`
}

func (b *Box) getHooks(w http.ResponseWriter, r *http.Request) error {
	if b.Hooks == nil {
		return httpError{http.StatusNotImplemented, "this box has no hooks file"}
	}
	cfg, err := b.Hooks.Load()
	if err != nil {
		return err
	}
	if cfg.Hooks == nil {
		cfg.Hooks = []hooks.Hook{}
	}
	writeJSON(w, HooksDoc{Path: b.Hooks.Path, Hooks: cfg.Hooks})
	return nil
}

func (b *Box) putHooks(w http.ResponseWriter, r *http.Request) error {
	if b.Hooks == nil {
		return httpError{http.StatusNotImplemented, "this box has no hooks file"}
	}
	var doc HooksDoc
	if err := decode(r, &doc); err != nil {
		return err
	}
	// The gates run before they can be replaced: otherwise replacing them
	// would be the way around any of them.
	if err := b.before(r, "hooks.change", nil); err != nil {
		return err
	}
	if err := b.Hooks.Save(doc.Hooks); err != nil {
		return badRequest("%v", err)
	}
	b.publish(r, "hooks.changed", nil)
	return b.getHooks(w, r)
}
