package transcript

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Signals are what a conversation says about the agent rather than to the
// person: its permission mode, model and effort, how full its context is,
// its task list, the work it left running in the background, and a request
// it is retrying. The app draws them as the chat's controls; they are
// replaced as the transcript goes on, never kept as items.
type Signals struct {
	// Mode is the agent's permission mode as it writes it: default,
	// acceptEdits, plan, auto or bypassPermissions for Claude Code; the
	// approval policy (never, on-request, untrusted…) for Codex.
	Mode   string `json:"mode,omitempty"`
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
	// Context is how many tokens the last request held, and the window when
	// the agent says (Codex does; Claude's is known by model).
	Context *ContextUse `json:"context,omitempty"`
	// Todos is the agent's latest task list, in its order.
	Todos []Todo `json:"todos,omitempty"`
	// Background is the work left running: shells and monitors, newest
	// last, finished ones kept a while so their end shows.
	Background []Job `json:"background,omitempty"`
	// Retrying is a request the agent is retrying (a dropped connection),
	// until it gets an answer.
	Retrying *Retry `json:"retrying,omitempty"`
}

type ContextUse struct {
	Tokens int   `json:"tokens"`
	Window int   `json:"window,omitempty"`
	At     int64 `json:"at,omitempty"`
}

// Todo is one entry in the agent's task list: pending, in_progress or
// completed. Active is its "doing" form ("Running the tests").
type Todo struct {
	ID     string `json:"id,omitempty"`
	Text   string `json:"text"`
	Active string `json:"active,omitempty"`
	Status string `json:"status"`
}

// Job is one piece of background work: a shell started with
// run_in_background, or a monitor. Tool names the call for its details
// (GET …/transcript/tool/{tool}), which read its output as it grows.
type Job struct {
	Tool    string `json:"tool"`
	Task    string `json:"task,omitempty"`
	Kind    string `json:"kind"`
	Command string `json:"command"`
	Label   string `json:"label,omitempty"`
	State   string `json:"state"`
	Since   int64  `json:"since"`
	Until   int64  `json:"until,omitempty"`
}

type Retry struct {
	Message string `json:"message"`
	Attempt int    `json:"attempt,omitempty"`
	Max     int    `json:"max,omitempty"`
	At      int64  `json:"at"`
}

// signals is a conversation's running state behind Signals.
type signals struct {
	Signals
	// tasks are TaskCreate's tasks by ID; creating is a TaskCreate call
	// waiting for its result to learn the ID it got.
	tasks    map[string]*Todo
	order    []string
	creating map[string]Todo
	// taskTurn is the prompt count when the task list last changed: a list
	// all done is cleared when a later turn starts a new one.
	taskTurn int
	turns    int
	// jobs by tool call ID; pendingJob are calls not answered yet.
	jobs map[string]*Job
}

func (s *signals) snapshot() *Signals {
	out := s.Signals
	if s.Context != nil {
		u := *s.Context
		out.Context = &u
	}
	if s.Retrying != nil {
		r := *s.Retrying
		out.Retrying = &r
	}
	out.Todos = append([]Todo(nil), s.Todos...)
	out.Background = nil
	for _, j := range s.Background {
		out.Background = append(out.Background, j)
	}
	return &out
}

// prompt counts a person's prompt: a new turn.
func (s *signals) prompt() { s.turns++ }

// --- Notices ---

// notice adds a card the person should see: an API error, a usage limit,
// a hook that failed, a turn they interrupted. Kind is the notice's type
// and Level error, warning or info.
func (c *conv) notice(kind, level, text string, resets int64) {
	// The same notice twice in a row (a retried request failing the same
	// way) is one card.
	if n := len(c.items); n > 0 {
		if last := c.items[n-1]; last.Kind == "notice" && last.Notice == kind && last.Text == text {
			return
		}
	}
	c.add(Item{Kind: "notice", ID: c.id(), Notice: kind, Level: level, Text: clip(strings.TrimSpace(text), 2000), Resets: resets})
}

var (
	// "Claude AI usage limit reached|1760000000": the reset as a Unix time.
	limitPipe = regexp.MustCompile(`\|(\d{9,11})\s*$`)
	limitWord = regexp.MustCompile(`(?i)(usage limit|limit reached|hit your limit|out of (extra )?usage|rate.?limit|too many requests|overloaded)`)
)

// apiNotice reads an API error the agent wrote into its conversation:
// Claude Code's synthetic "API Error: …" replies, with error naming the
// kind (rate_limit, authentication_failed, server_error…).
func (c *conv) apiNotice(errKind, text string) {
	text = strings.TrimSpace(text)
	var resets int64
	if m := limitPipe.FindStringSubmatch(text); m != nil {
		sec, _ := strconv.ParseInt(m[1], 10, 64)
		resets = sec * 1000
		text = strings.TrimSpace(text[:len(text)-len(m[0])])
	}
	low := strings.ToLower(text)
	switch {
	case errKind == "rate_limit" || strings.Contains(low, "limit") && (strings.Contains(low, "reset") || resets > 0) || strings.Contains(low, "usage limit") || strings.Contains(low, "hit your limit"):
		c.notice("limit", "warning", text, resets)
	case limitWord.MatchString(text):
		c.notice("rate_limit", "warning", text, resets)
	case errKind == "authentication_failed" || strings.Contains(low, "/login") || strings.Contains(low, "oauth"):
		c.notice("auth", "error", text, 0)
	case errKind == "billing_error" || strings.Contains(low, "credit balance"):
		c.notice("billing", "error", text, 0)
	default:
		c.notice("api_error", "error", text, 0)
	}
}

// interrupted reads "[Request interrupted by user]" (and "… for tool
// use"): the turn the person stopped, as a notice rather than their words.
func (c *conv) interrupted(text string) bool {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "[Request interrupted by user") {
		return false
	}
	c.notice("interrupted", "info", "Interrupted", 0)
	c.sig.Retrying = nil
	return true
}

// --- Claude Code ---

// claudeExtra are the fields of a Claude Code line the signals read, past
// the ones the conversation does. The parser decodes them with the line
// (claudeLine).
type claudeExtra struct {
	Subtype        string
	Level          string
	PermissionMode string
	Effort         string
	IsAPIError     bool
	Error          json.RawMessage
	RetryAttempt   int
	MaxRetries     int
	Attachment     json.RawMessage
	Message        claudeMessage
}

// claudeSignals reads what a Claude Code line says about the agent: x is
// the line's fields, or nil when one is not of the type they read (the line
// is no signal then). It reports true when the line is wholly a signal and
// the conversation should not read it as a message too (an API error's
// synthetic reply).
func claudeSignals(c *conv, typ string, x *claudeExtra, b []byte, at int64) bool {
	// A tool's result or a prompt is read only when it holds what the
	// signals want: most are long and say nothing about the agent.
	if typ == "user" && !bytes.Contains(b, []byte(`"permissionMode"`)) && !bytes.Contains(b, []byte("[Request interrupted by user")) && !bytes.Contains(b, []byte("<task-notification>")) {
		return false
	}
	if x == nil {
		return false
	}
	if x.PermissionMode != "" {
		c.sig.Mode = x.PermissionMode
	}
	switch typ {
	case "permission-mode":
		// Written as each prompt is sent: a turn.
		c.sig.prompt()
	case "user":
		var s string
		var blocks []claudeBlock
		if json.Unmarshal(x.Message.Content, &s) != nil {
			_ = json.Unmarshal(x.Message.Content, &blocks)
		}
		texts := []string{s}
		for _, bl := range blocks {
			if bl.Type == "text" {
				texts = append(texts, bl.Text)
			}
		}
		stopped := false
		for _, t := range texts {
			c.jobNote(t, at)
			stopped = c.interrupted(t) || stopped
		}
		// "[Request interrupted by user]" alone is the notice, not words.
		return stopped && len(blocks) <= 1
	case "assistant":
		if x.IsAPIError {
			var kind string
			_ = json.Unmarshal(x.Error, &kind)
			c.apiNotice(kind, firstText(x.Message.Content))
			c.sig.Retrying = nil
			return true
		}
		if m := x.Message.Model; m != "" && m != "<synthetic>" {
			c.sig.Model = m
		}
		if x.Effort != "" {
			c.sig.Effort = x.Effort
		}
		if u := x.Message.Usage; u != nil && x.Message.Model != "<synthetic>" {
			if n := u.Input + u.CacheCreate + u.CacheRead; n > 0 {
				c.sig.Context = &ContextUse{Tokens: n, At: at}
			}
		}
		c.sig.Retrying = nil
	case "system":
		switch x.Subtype {
		case "api_error":
			// A request being retried: one line that updates, not a card
			// per attempt. When retries run out the agent writes an API
			// error reply, which is the card.
			var e struct {
				Message   string `json:"message"`
				Formatted string `json:"formatted"`
			}
			_ = json.Unmarshal(x.Error, &e)
			c.sig.Retrying = &Retry{Message: firstNonEmpty(e.Formatted, e.Message, "The request failed"), Attempt: x.RetryAttempt, Max: x.MaxRetries, At: at}
		case "stop_hook_summary":
			var h struct {
				HookErrors []json.RawMessage `json:"hookErrors"`
			}
			_ = json.Unmarshal(b, &h)
			for _, e := range h.HookErrors {
				var s string
				if json.Unmarshal(e, &s) != nil {
					s = string(e)
				}
				c.notice("hook", "warning", "A Stop hook failed: "+s, 0)
			}
		case "informational":
			var t struct {
				Content string `json:"content"`
			}
			_ = json.Unmarshal(b, &t)
			if x.Level == "error" || x.Level == "warning" {
				if limitWord.MatchString(t.Content) {
					c.apiNotice("", t.Content)
				}
			}
		}
	case "attachment":
		claudeAttachment(c, x.Attachment, at)
	}
	return false
}

// claudeAttachment reads the attachments that matter to the person: hooks
// that failed or blocked, and background work's notifications.
func claudeAttachment(c *conv, raw json.RawMessage, at int64) {
	var a struct {
		Type     string `json:"type"`
		HookName string `json:"hookName"`
		Stderr   string `json:"stderr"`
		Stdout   string `json:"stdout"`
		Content  any    `json:"content"`
		Exit     int    `json:"exitCode"`
		Prompt   string `json:"prompt"`

		Command  string `json:"command"`
		Blocking string `json:"blockingError"`
	}
	if json.Unmarshal(raw, &a) != nil {
		return
	}
	switch a.Type {
	case "hook_non_blocking_error", "hook_blocking_error", "hook_error_during_execution":
		what := strings.TrimSpace(firstNonEmpty(a.Blocking, a.Stderr, contentText(a.Content), a.Stdout))
		name := firstNonEmpty(a.HookName, "A hook")
		msg := name + " hook failed"
		if a.Type == "hook_blocking_error" {
			msg = name + " hook blocked this"
		}
		if what != "" {
			msg += ": " + what
		}
		c.notice("hook", "warning", msg, 0)
	case "hook_stopped_continuation":
		c.notice("hook", "warning", firstNonEmpty(a.HookName, "A hook")+" hook stopped the turn: "+strings.TrimSpace(contentText(a.Content)), 0)
	case "queued_command":
		c.jobNote(a.Prompt, at)
	}
}

func contentText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var parts []string
		for _, p := range t {
			if s, ok := p.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// firstText is a message's first text block.
func firstText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []claudeBlock
	_ = json.Unmarshal(raw, &blocks)
	for _, b := range blocks {
		if b.Type == "text" {
			return b.Text
		}
	}
	return ""
}

// claudeToolSignal reads a tool call that changes the agent's state rather
// than doing work: its task list, background shells, stopping one. It
// reports true when the call is bookkeeping, not a step worth a line.
func claudeToolSignal(c *conv, bl claudeBlock, at int64) bool {
	var in map[string]any
	_ = json.Unmarshal(bl.Input, &in)
	str := func(k string) string { v, _ := in[k].(string); return v }
	switch bl.Name {
	case "TodoWrite":
		var t struct {
			Todos []struct {
				Content    string `json:"content"`
				Status     string `json:"status"`
				ActiveForm string `json:"activeForm"`
				ID         string `json:"id"`
			} `json:"todos"`
		}
		_ = json.Unmarshal(bl.Input, &t)
		c.sig.Todos = c.sig.Todos[:0:0]
		for _, x := range t.Todos {
			c.sig.Todos = append(c.sig.Todos, Todo{ID: x.ID, Text: clip(x.Content, 300), Active: clip(x.ActiveForm, 300), Status: todoStatus(x.Status)})
		}
		c.sig.tasks, c.sig.order = nil, nil
		c.sig.taskTurn = c.sig.turns
		return true
	case "TaskCreate":
		if c.sig.creating == nil {
			c.sig.creating = map[string]Todo{}
		}
		c.sig.creating[bl.ID] = Todo{Text: clip(firstNonEmpty(str("subject"), str("description")), 300), Active: clip(str("activeForm"), 300), Status: "pending"}
		return true
	case "TaskUpdate":
		id := firstNonEmpty(str("taskId"), str("task_id"), str("id"))
		if t := c.sig.tasks[id]; t != nil {
			if s := str("status"); s == "deleted" {
				delete(c.sig.tasks, id)
			} else if s != "" {
				t.Status = todoStatus(s)
			}
			if s := str("subject"); s != "" {
				t.Text = clip(s, 300)
			}
			if s := str("activeForm"); s != "" {
				t.Active = clip(s, 300)
			}
			c.sig.taskTurn = c.sig.turns
			c.syncTasks()
		}
		return true
	case "TaskList", "TaskGet":
		return true
	case "KillShell", "KillBash", "TaskStop":
		id := firstNonEmpty(str("shell_id"), str("task_id"), str("bash_id"), str("id"))
		for _, j := range c.sig.Background {
			if j.Task == id && j.State == "running" {
				c.jobEnd(j.Tool, "stopped", at)
			}
		}
		return false
	case "Bash":
		if bg, _ := in["run_in_background"].(bool); bg {
			c.jobStart(Job{Tool: bl.ID, Kind: "shell", Command: clip(str("command"), 400), Label: clip(str("description"), 120), State: "starting", Since: at})
		}
	case "Monitor":
		c.jobStart(Job{Tool: bl.ID, Kind: "monitor", Command: clip(str("command"), 400), Label: clip(str("description"), 120), State: "starting", Since: at})
	}
	return false
}

func todoStatus(s string) string {
	switch s {
	case "in_progress", "completed":
		return s
	case "done", "complete":
		return "completed"
	case "active", "running":
		return "in_progress"
	}
	return "pending"
}

var (
	createdTask = regexp.MustCompile(`Task #?(\w+) created`)
	startedJob  = regexp.MustCompile(`(?:running in background with ID|Monitor started \(task):? (\w+)`)
)

// claudeResultSignal reads a tool result for the signals: the ID a task or
// a background shell got.
func claudeResultSignal(c *conv, toolID, text string, at int64) {
	if t, ok := c.sig.creating[toolID]; ok {
		delete(c.sig.creating, toolID)
		id := ""
		if m := createdTask.FindStringSubmatch(text); m != nil {
			id = m[1]
		} else {
			id = strconv.Itoa(len(c.sig.order) + 1)
		}
		// A list all done, made in an earlier turn, gives way to a new one.
		if c.sig.turns > c.sig.taskTurn && c.allDone() {
			c.sig.tasks, c.sig.order = nil, nil
		}
		if c.sig.tasks == nil {
			c.sig.tasks = map[string]*Todo{}
		}
		t.ID = id
		if _, seen := c.sig.tasks[id]; !seen {
			c.sig.order = append(c.sig.order, id)
		}
		c.sig.tasks[id] = &t
		c.sig.taskTurn = c.sig.turns
		c.syncTasks()
	}
	if j := c.job(toolID); j != nil && j.State == "starting" {
		if m := startedJob.FindStringSubmatch(text); m != nil {
			j.Task, j.State = m[1], "running"
		} else {
			// It never started: an error, or a refusal.
			j.State, j.Until = "failed", at
		}
	}
}

func (c *conv) allDone() bool {
	for _, t := range c.sig.Todos {
		if t.Status != "completed" {
			return false
		}
	}
	return true
}

// syncTasks lays TaskCreate's tasks out as the list, by ID where IDs are
// numbers.
func (c *conv) syncTasks() {
	ids := append([]string(nil), c.sig.order...)
	sort.SliceStable(ids, func(i, j int) bool {
		a, ea := strconv.Atoi(ids[i])
		b, eb := strconv.Atoi(ids[j])
		if ea == nil && eb == nil {
			return a < b
		}
		return false
	})
	c.sig.Todos = c.sig.Todos[:0:0]
	order := ids[:0]
	for _, id := range ids {
		if t := c.sig.tasks[id]; t != nil {
			c.sig.Todos = append(c.sig.Todos, *t)
			order = append(order, id)
		}
	}
	c.sig.order = order
}

// --- Background work ---

const keepJobs = 12

func (c *conv) job(tool string) *Job {
	for i := range c.sig.Background {
		if c.sig.Background[i].Tool == tool {
			return &c.sig.Background[i]
		}
	}
	return nil
}

func (c *conv) jobStart(j Job) {
	if c.job(j.Tool) != nil {
		return
	}
	c.sig.Background = append(c.sig.Background, j)
	// Finished ones drop off first.
	for len(c.sig.Background) > keepJobs {
		drop := 0
		for i, x := range c.sig.Background {
			if x.State != "running" && x.State != "starting" {
				drop = i
				break
			}
		}
		c.sig.Background = append(c.sig.Background[:drop], c.sig.Background[drop+1:]...)
	}
}

func (c *conv) jobEnd(tool, state string, at int64) {
	if j := c.job(tool); j != nil && (j.State == "running" || j.State == "starting") {
		j.State, j.Until = state, at
	}
}

var jobNoteRe = regexp.MustCompile(`(?s)<task-notification>(.*?)</task-notification>`)

// jobNote reads a background shell's notification: "<task-id>…</task-id>
// <tool-use-id>…</tool-use-id> <status>completed</status>".
func (c *conv) jobNote(s string, at int64) {
	if !strings.Contains(s, "<task-notification>") {
		return
	}
	tag := func(body, name string) string {
		_, after, ok := strings.Cut(body, "<"+name+">")
		if !ok {
			return ""
		}
		v, _, _ := strings.Cut(after, "</"+name+">")
		return strings.TrimSpace(v)
	}
	for _, m := range jobNoteRe.FindAllStringSubmatch(s, -1) {
		status := tag(m[1], "status")
		if status == "" || status == "running" {
			continue
		}
		state := "done"
		switch status {
		case "failed", "error":
			state = "failed"
		case "stopped", "killed", "cancelled":
			state = "stopped"
		}
		tool, task := tag(m[1], "tool-use-id"), tag(m[1], "task-id")
		for _, j := range c.sig.Background {
			if (tool != "" && j.Tool == tool) || (task != "" && j.Task == task) {
				c.jobEnd(j.Tool, state, at)
			}
		}
	}
}

// --- Codex ---

// codexSignals reads Codex's turn context (model, effort, approval
// policy), its token counts and limits, and its events (an interrupted
// turn, an error).
func codexSignals(c *conv, typ string, payload json.RawMessage, at int64) {
	switch typ {
	case "turn_context":
		var t struct {
			Model    string `json:"model"`
			Effort   string `json:"effort"`
			Approval string `json:"approval_policy"`
		}
		if json.Unmarshal(payload, &t) == nil {
			if t.Model != "" {
				c.sig.Model = t.Model
			}
			if t.Effort != "" {
				c.sig.Effort = t.Effort
			}
			if t.Approval != "" {
				c.sig.Mode = t.Approval
			}
		}
	case "event_msg":
		var e struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Reason  string `json:"reason"`
			Window  int    `json:"model_context_window"`
			Info    *struct {
				Last struct {
					Total int `json:"total_tokens"`
					Input int `json:"input_tokens"`
				} `json:"last_token_usage"`
				Window int `json:"model_context_window"`
			} `json:"info"`
			Limits *struct {
				Reached *string `json:"rate_limit_reached_type"`
				Primary *struct {
					Resets int64 `json:"resets_at"`
				} `json:"primary"`
			} `json:"rate_limits"`
		}
		if json.Unmarshal(payload, &e) != nil {
			return
		}
		switch e.Type {
		case "task_started":
			if e.Window > 0 && c.sig.Context != nil {
				c.sig.Context.Window = e.Window
			}
		case "token_count":
			if e.Info != nil && e.Info.Last.Total > 0 {
				c.sig.Context = &ContextUse{Tokens: e.Info.Last.Total, Window: e.Info.Window, At: at}
			}
			if e.Limits != nil && e.Limits.Reached != nil && *e.Limits.Reached != "" {
				var resets int64
				if e.Limits.Primary != nil {
					resets = e.Limits.Primary.Resets * 1000
				}
				c.notice("limit", "warning", "Codex usage limit reached ("+strings.ReplaceAll(*e.Limits.Reached, "_", " ")+")", resets)
			}
		case "turn_aborted":
			if e.Reason == "" || e.Reason == "interrupted" {
				c.notice("interrupted", "info", "Interrupted", 0)
			} else {
				c.notice("api_error", "error", "The turn ended early: "+strings.ReplaceAll(e.Reason, "_", " "), 0)
			}
		case "error", "stream_error":
			if e.Message != "" {
				if e.Type == "stream_error" {
					c.sig.Retrying = &Retry{Message: e.Message, At: at}
				} else {
					c.apiNotice("", e.Message)
				}
			}
		case "task_complete":
			c.sig.Retrying = nil
		}
	}
}

// codexPlan reads Codex's update_plan call as the task list.
func codexPlan(c *conv, args string) {
	var p struct {
		Plan []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"plan"`
	}
	if json.Unmarshal([]byte(args), &p) != nil {
		return
	}
	c.sig.Todos = c.sig.Todos[:0:0]
	for _, s := range p.Plan {
		c.sig.Todos = append(c.sig.Todos, Todo{Text: clip(s.Step, 300), Status: todoStatus(s.Status)})
	}
}

// --- A background shell's output ---

var outputFile = regexp.MustCompile(`Output is being written to: (\S+?\.output)\b`)

// liveOutput reads a background shell's output file, named in its tool
// result, so its details show what it has printed so far rather than "Command
// running in background". Only a .output file in a tasks folder is read,
// its last part.
func liveOutput(d *ToolDetail) {
	m := outputFile.FindStringSubmatch(d.Output)
	if m == nil {
		return
	}
	p := filepath.Clean(m[1])
	if !filepath.IsAbs(p) || filepath.Base(filepath.Dir(p)) != "tasks" {
		return
	}
	f, err := os.Open(p)
	if err != nil {
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return
	}
	const tail = 16 << 10
	start := max(st.Size()-tail, 0)
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return
	}
	b, _ := io.ReadAll(io.LimitReader(f, tail))
	out := string(b)
	if start > 0 {
		if i := strings.IndexByte(out, '\n'); i >= 0 {
			out = out[i+1:]
		}
		d.Truncated = true
	}
	if strings.TrimSpace(out) == "" {
		out = "(nothing printed yet)"
	}
	d.Output = out
	d.Live = time.Since(st.ModTime()) < 10*time.Second
}
