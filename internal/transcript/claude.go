package transcript

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// claudeParser reads Claude Code's transcript: one JSON object per line,
// user and assistant messages whose content is text, thinking, tool_use
// and tool_result blocks. Everything else (snapshots, titles, modes) is
// skipped.
type claudeParser struct{}

type claudeLine struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	IsMeta  bool   `json:"isMeta"`
	// IsCompactSummary marks the summary a compacted conversation goes on
	// from: written as the person's, but not what they said.
	IsCompactSummary bool            `json:"isCompactSummary"`
	Sidechain        bool            `json:"isSidechain"`
	Timestamp        string          `json:"timestamp"`
	Message          json.RawMessage `json:"message"`
	// Operation and Content are a queue-operation line's: what Claude Code
	// queued for itself, such as a helper's "finished" notification.
	Operation string `json:"operation"`
	Content   string `json:"content"`
	// UUID and ParentUUID chain the entries: a fork picks up at one.
	UUID       string `json:"uuid"`
	ParentUUID string `json:"parentUuid"`
	// Attachment is what Claude Code hands the model mid-turn: a message
	// typed while it worked arrives as a queued_command, at the point the
	// model reads it, and is not written as a user line (claudeAttached).
	// The signals read its other kinds.
	Attachment json.RawMessage `json:"attachment"`
	// Origin says who a user turn is from (Claude Code 2.1): the person
	// (human), another agent (peer), the lead (coordinator) or a task's
	// notification (peer.go).
	Origin *Origin `json:"origin"`

	// The signals' own fields (claudeExtra), read in the same pass: a
	// line is decoded once, not again for them.
	Level          string          `json:"level"`
	PermissionMode string          `json:"permissionMode"`
	Effort         string          `json:"effort"`
	IsAPIError     bool            `json:"isApiErrorMessage"`
	Error          json.RawMessage `json:"error"`
	RetryAttempt   int             `json:"retryAttempt"`
	MaxRetries     int             `json:"maxRetries"`
}

// signalFields are claudeLine's fields only the signals read: one of a
// type they never had leaves the line to the conversation, unread by the
// signals, as when they read the line apart.
var signalFields = map[string]bool{"level": true, "permissionMode": true, "effort": true, "isApiErrorMessage": true, "retryAttempt": true, "maxRetries": true}

// claudeAttached is an attachment line's queued_command.
type claudeAttached struct {
	Type   string          `json:"type"`
	Prompt json.RawMessage `json:"prompt"`
	Origin *Origin         `json:"origin"`
}

type claudeMessage struct {
	Content json.RawMessage `json:"content"`
	// Model and Usage are the signals' (an assistant line's).
	Model string `json:"model"`
	Usage *struct {
		Input       int `json:"input_tokens"`
		CacheCreate int `json:"cache_creation_input_tokens"`
		CacheRead   int `json:"cache_read_input_tokens"`
	} `json:"usage"`
}

// isArray says whether raw JSON is an array: content is a string or an
// array of blocks, and which is told by its first byte without trying to
// decode it as the other.
func isArray(raw []byte) bool {
	raw = bytes.TrimLeft(raw, " \t\r\n")
	return len(raw) > 0 && raw[0] == '['
}

type claudeBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (claudeParser) line(c *conv, b []byte) {
	var l claudeLine
	sigOK := true
	if err := json.Unmarshal(b, &l); err != nil {
		var te *json.UnmarshalTypeError
		if !errors.As(err, &te) || !signalFields[te.Field] {
			return
		}
		sigOK = false
	}
	// A helper's own record (a subagent's file) is all sidechain.
	if l.Sidechain && !c.side {
		return
	}
	// The message is decoded once, for the conversation and the signals.
	var msg claudeMessage
	msgOK := len(l.Message) > 0 && json.Unmarshal(l.Message, &msg) == nil
	if !msgOK {
		msg = claudeMessage{}
	}
	c.lineUUID, c.lineParent = l.UUID, l.ParentUUID
	if l.IsMeta {
		// A message from another agent, Claude Code's notification or a
		// note around the person's mid-turn message, marked meta: read for
		// what it is (peer.go), not dropped.
		if l.Type == "user" && l.Origin != nil && metaOrigins[l.Origin.Kind] {
			if s := userString(msg.Content); s != "" {
				c.userTurn(s, l.Origin, turnMeta, parseTime(l.Timestamp))
			}
			return
		}
		commandMeta(c, l.Type, msg.Content)
		return
	}
	at := parseTime(l.Timestamp)
	// When the agent last wrote, for how long it has been thinking since.
	if (l.Type == "user" || l.Type == "assistant") && l.Timestamp != "" {
		c.lineAt = at
	}
	// Its mode, model, context, errors and background work (signals.go):
	// an API error's synthetic reply is a notice, not the agent's words.
	var x *claudeExtra
	if sigOK && (len(l.Message) == 0 || msgOK) {
		x = &claudeExtra{Subtype: l.Subtype, Level: l.Level, PermissionMode: l.PermissionMode, Effort: l.Effort, IsAPIError: l.IsAPIError,
			Error: l.Error, RetryAttempt: l.RetryAttempt, MaxRetries: l.MaxRetries, Attachment: l.Attachment, Message: msg}
	}
	if claudeSignals(c, l.Type, x, b, at) {
		return
	}
	switch {
	case l.Type == "system" && l.Subtype == "local_command":
		commandText(c, l.Content)
		return
	case l.Type == "system" && l.Subtype == "compact_boundary":
		// The /compact typed just before (Claude Code 2.1 writes it as a
		// plain prompt) and its boundary read as one divider.
		const compacted = "Conversation compacted: the agent goes on from a summary of it"
		if n := len(c.items); n > 0 && c.items[n-1].Kind == "command" && c.items[n-1].Command == "/compact" && c.items[n-1].Text == "" {
			c.items[n-1].Text = compacted
			return
		}
		c.add(Item{Kind: "command", ID: c.id(), Command: "/compact", Text: compacted})
		return
	case l.IsCompactSummary:
		return
	}
	if l.Type == "queue-operation" && l.Operation == "enqueue" {
		helperDone(c, l.Content, at)
		return
	}
	if l.Type == "attachment" && len(l.Attachment) > 0 {
		var a claudeAttached
		if json.Unmarshal(l.Attachment, &a) == nil && a.Type == "queued_command" {
			// Shown where the model read it, so a reply never sits above
			// the message it answers.
			if t := strings.TrimSpace(unwrapPasted(resultFull(a.Prompt))); t != "" {
				c.userTurn(t, a.Origin, turnQueued, at)
			}
			return
		}
	}
	if l.Type != "user" && l.Type != "assistant" {
		return
	}
	if !msgOK || len(msg.Content) == 0 {
		return
	}
	// A prompt can be a plain string.
	if !isArray(msg.Content) {
		var s string
		if json.Unmarshal(msg.Content, &s) == nil && l.Type == "user" {
			c.userTurn(s, l.Origin, turnPrompt, at)
		}
		return
	}
	var blocks []claudeBlock
	if json.Unmarshal(msg.Content, &blocks) != nil {
		return
	}
	var typed []string
	for _, bl := range blocks {
		switch {
		case l.Type == "user" && bl.Type == "text":
			typed = append(typed, bl.Text)
		case l.Type == "user" && bl.Type == "image":
			typed = append(typed, "[image]")
		case l.Type == "user" && bl.Type == "tool_result":
			// A helper started in the background answers at once; it is
			// back when its notification says so, not now.
			text := resultText(bl.Content)
			if strings.HasPrefix(text, "Async agent launched") {
				c.launched(bl.ToolUseID)
			}
			// Its agent ID, which its notifications and hand-back name.
			if m := agentIDRe.FindStringSubmatch(text); m != nil {
				if c.agentIDs == nil {
					c.agentIDs = map[string]string{}
				}
				c.agentIDs[m[1]] = bl.ToolUseID
			}
			c.result(bl.ToolUseID, at)
			claudeResultSignal(c, bl.ToolUseID, text, at)
			c.published(bl.ToolUseID, b, text, bl.IsError, at)
			if !bl.IsError {
				c.localArtifacts(bl.ToolUseID, text)
			}
			c.claudeAnswered(bl.ToolUseID, b, text, bl.IsError)
			// A rejected call with words for the agent (a plan sent back
			// with "Tell Claude what to change") reads as what the person
			// said.
			if _, said, ok := strings.Cut(text, "To tell you how to proceed, the user said:\n"); ok {
				userText(c, said)
			}
		case l.Type == "assistant" && bl.Type == "text":
			if t := strings.TrimSpace(bl.Text); t != "" {
				c.add(Item{Kind: "text", ID: c.id(), Text: clip(t, maxText)})
			}
		case l.Type == "assistant" && bl.Type == "tool_use":
			claudeTool(c, bl, at)
		}
	}
	if len(typed) > 0 {
		c.userTurn(strings.Join(typed, "\n"), l.Origin, turnPrompt, at)
	}
}

// userText adds what a person typed. Lines Claude Code writes for itself
// (command output, reminders) start with a tag and are skipped.
// pastedRe is how Claude Code records a paste in a prompt: wrapped in
// <pasted_content id="…"> tags, which the person never typed. Claude Code
// 2.1 closes it with its id too (</pasted_content id="…">).
var pastedRe = regexp.MustCompile(`(?s)<pasted_content(?:\s[^>]*)?>\n?(.*?)\n?</pasted_content(?:\s[^>]*)?>`)

// pastedTag is a tag of a paste left unclosed.
var pastedTag = regexp.MustCompile(`</?pasted_content(?:\s[^>]*)?>\n?`)

// unwrapPasted is a prompt as it was typed, a paste's words in place.
func unwrapPasted(s string) string {
	if !strings.Contains(s, "<pasted_content") {
		return s
	}
	return pastedTag.ReplaceAllString(pastedRe.ReplaceAllString(s, "$1"), "")
}

// metaOrigins are the origins of the isMeta lines worth reading.
var metaOrigins = map[string]bool{"human": true, "peer": true, "coordinator": true, "task-notification": true}

// userString is a user line's text, from its message's content: a plain
// string, or its text blocks.
func userString(content json.RawMessage) string {
	if !isArray(content) {
		var s string
		_ = json.Unmarshal(content, &s)
		return s
	}
	var blocks []claudeBlock
	if json.Unmarshal(content, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func userText(c *conv, s string) {
	s = strings.TrimSpace(unwrapPasted(s))
	// Shown already, where the model read it mid-turn.
	if c.queued[s] {
		delete(c.queued, s)
		return
	}
	if commandText(c, s) {
		return
	}
	if berthReports(c, s) {
		c.closeArtifacts()
		c.closeQuestions()
		return
	}
	if s == "" || strings.HasPrefix(s, "<") || strings.HasPrefix(s, "Caveat:") {
		return
	}
	// Claude Code 2.1 writes /compact as typed, before its boundary.
	if s == "/compact" || strings.HasPrefix(s, "/compact ") {
		c.add(Item{Kind: "command", ID: c.id(), Command: "/compact", Args: clip(strings.TrimSpace(strings.TrimPrefix(s, "/compact")), 2000)})
		return
	}
	c.rewound()
	c.closeArtifacts()
	c.closeQuestions()
	// The person has seen the questions other agents asked before it.
	c.repliedTo("")
	c.prompted(c.add(Item{Kind: "user", ID: c.id(), Text: clip(s, 4000), UUID: c.lineUUID, Parent: c.lineParent}))
}

func claudeTool(c *conv, bl claudeBlock, at int64) {
	var in map[string]any
	_ = json.Unmarshal(bl.Input, &in)
	str := func(k string) string { v, _ := in[k].(string); return v }
	// A task list is the agent's state, not a step (signals.go).
	if claudeToolSignal(c, bl, at) {
		return
	}
	switch bl.Name {
	case "SendMessage":
		// An answer to another agent: its question is no longer open.
		c.repliedTo(firstNonEmpty(str("to"), str("recipient"), str("session")))
		c.call(bl.ID, ToolCall{Verb: "Run", Target: "SendMessage"})
	case "Read", "NotebookRead":
		c.call(bl.ID, ToolCall{Verb: "Read", Target: filepath.Base(str("file_path")), File: true})
	case "Glob", "Grep", "LS", "WebSearch", "WebFetch":
		target := firstNonEmpty(str("pattern"), str("query"), str("url"), str("path"))
		c.call(bl.ID, ToolCall{Verb: "Search", Target: clip(target, 80)})
	case "Bash", "BashOutput":
		c.call(bl.ID, ToolCall{Verb: "Run", Target: clip(firstLine(str("command")), 80)})
	case "Edit", "MultiEdit", "Write", "NotebookEdit":
		// Plan mode's plan file is outside the work: its plan shows when
		// the agent presents it (ExitPlanMode).
		if strings.Contains(firstNonEmpty(str("file_path"), str("notebook_path")), "/.claude/plans/") {
			c.byTool[bl.ID] = -1
			return
		}
		added, removed := 0, 0
		switch bl.Name {
		case "Write":
			added = lines(str("content"))
		case "MultiEdit":
			if edits, ok := in["edits"].([]any); ok {
				for _, e := range edits {
					if m, ok := e.(map[string]any); ok {
						ns, _ := m["new_string"].(string)
						os, _ := m["old_string"].(string)
						added += lines(ns)
						removed += lines(os)
					}
				}
			}
		default:
			added, removed = lines(str("new_string")), lines(str("old_string"))
		}
		c.add(Item{Kind: "edit", ID: c.id(), File: rel(c.dir, firstNonEmpty(str("file_path"), str("notebook_path"))), Added: added, Removed: removed, Tool: bl.ID})
		c.byTool[bl.ID] = -1
	case "Agent", "Task":
		name := firstNonEmpty(str("description"), str("subagent_type"), "Helper")
		c.add(Item{Kind: "crew", ID: c.id(), Names: []string{name}, Tool: bl.ID})
		c.helper(CrewMember{ID: bl.ID, Name: clip(name, 60), Kind: "subagent", Agent: "claude", State: "running", Doing: clip(firstNonEmpty(str("subagent_type"), "Working"), 60), Since: at})
	case "AskUserQuestion":
		// Its questions, answered from the chat (questions.go).
		if !c.asked(bl.ID, in["questions"]) {
			c.call(bl.ID, ToolCall{Verb: "Run", Target: "AskUserQuestion"})
		}
	case "ExitPlanMode":
		// The plan the agent presents for approval is its answer.
		if plan := strings.TrimSpace(str("plan")); plan != "" {
			c.add(Item{Kind: "text", ID: c.id(), Text: clip(plan, maxText)})
		}
	case "SubagentHandback":
		// A helper's answer to the agent that started it, in its own record.
		if msg := strings.TrimSpace(str("message")); msg != "" {
			c.add(Item{Kind: "text", ID: c.id(), Text: clip(msg, maxText)})
		}
		c.byTool[bl.ID] = -1
	case "ToolSearch":
		// Bookkeeping, not work worth a line.
	case "Artifact":
		// A page published on claude.ai: a card, and the conversation's
		// list of them (artifacts.go). Its other actions are steps.
		if !claudeArtifact(c, bl, in) {
			action := firstNonEmpty(str("action"), "publish")
			if asset, _ := in["asset"].(bool); asset {
				action = "upload"
			}
			c.call(bl.ID, ToolCall{Verb: "Run", Target: "Artifact " + action})
		}
	default:
		name := bl.Name
		if i := strings.LastIndex(name, "__"); i >= 0 {
			name = name[i+2:]
		}
		c.call(bl.ID, ToolCall{Verb: "Run", Target: clip(name, 80)})
	}
}

// resultText is a tool result's text: a string, or its first text block.
func resultText(raw json.RawMessage) string {
	if !isArray(raw) {
		var s string
		_ = json.Unmarshal(raw, &s)
		return s
	}
	var blocks []claudeBlock
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" {
				return b.Text
			}
		}
	}
	return ""
}

var agentIDRe = regexp.MustCompile(`agentId: ([a-z0-9]+)`)

var taskNote = regexp.MustCompile(`(?s)<task-notification>.*?<tool-use-id>([^<]+)</tool-use-id>.*?<status>([^<]+)</status>`)

// helperDone reads a background helper's notification, "<task-notification>
// … <tool-use-id>X</tool-use-id> <status>completed</status>", and marks
// that helper back.
func helperDone(c *conv, s string, at int64) {
	if !strings.Contains(s, "<task-notification>") {
		return
	}
	for _, m := range taskNote.FindAllStringSubmatch(s, -1) {
		if strings.TrimSpace(m[2]) != "running" {
			c.back(strings.TrimSpace(m[1]), at)
		}
	}
}

func parseTime(s string) int64 {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Now().UnixMilli()
	}
	return t.UnixMilli()
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && cut < len(s) && s[cut]&0xC0 == 0x80 { // keep runes whole
		cut--
	}
	return s[:cut] + "…"
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " …"
	}
	return s
}

func lines(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(strings.TrimSuffix(s, "\n"), "\n") + 1
}

func rel(dir, p string) string {
	if !filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if dir != "" {
		if r, err := filepath.Rel(dir, p); err == nil && !strings.HasPrefix(r, "..") {
			return r
		}
	}
	return filepath.Base(p)
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// maxOutput is the most of a command's output kept.
const maxOutput = 8 << 10

// tagged is the text inside <tag>…</tag> in s, if s has it.
func tagged(s, tag string) (string, bool) {
	_, after, ok := strings.Cut(s, "<"+tag+">")
	if !ok {
		return "", false
	}
	in, _, _ := strings.Cut(after, "</"+tag+">")
	return in, true
}

// commandText reads what Claude Code writes for a command typed to it: a
// slash command ("<command-name>/model</command-name>…<command-args>") and
// the output its program printed ("<local-command-stdout>"), or a shell
// command ("<bash-input>ls</bash-input>") and its output. They read as one
// command item. It says whether s was one.
func commandText(c *conv, s string) bool {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "<") {
		return false
	}
	if name, ok := tagged(s, "command-name"); ok {
		name = strings.TrimSpace(name)
		if !strings.HasPrefix(name, "/") {
			name = "/" + name
		}
		args, _ := tagged(s, "command-args")
		// /compact writes itself again after its boundary: that line says it.
		if n := len(c.items); name == "/compact" && n > 0 && c.items[n-1].Kind == "command" && c.items[n-1].Command == "/compact" && c.items[n-1].Text != "" {
			return true
		}
		c.add(Item{Kind: "command", ID: c.id(), Command: name, Args: clip(strings.TrimSpace(args), 2000)})
		return true
	}
	if in, ok := tagged(s, "bash-input"); ok {
		c.add(Item{Kind: "command", ID: c.id(), Command: "!", Args: clip(strings.TrimSpace(in), 2000)})
		return true
	}
	out, isOut := tagged(s, "local-command-stdout")
	errOut, isErr := tagged(s, "local-command-stderr")
	if !isOut && !isErr {
		out, isOut = tagged(s, "bash-stdout")
		errOut, isErr = tagged(s, "bash-stderr")
	}
	if !isOut && !isErr {
		return false
	}
	text := strings.TrimSpace(hookReports.ReplaceAllString(plain(strings.TrimSpace(out+"\n"+errOut)), ""))
	if n := len(c.items); n > 0 && c.items[n-1].Kind == "command" && c.items[n-1].Text == "" {
		last := &c.items[n-1]
		last.Text, last.Error = clip(text, maxOutput), strings.TrimSpace(errOut) != "" && strings.TrimSpace(out) == ""
	}
	return true
}

// hookReports are the lines Claude Code adds to a command's output for the
// hooks it ran ("PostCompact [cmd] completed successfully: {}"): the
// person's hooks' business, not the command's answer.
var hookReports = regexp.MustCompile(`(?m)^(?:Pre|Post|Session|Stop|User|Notification|Subagent)\w* \[.*$\n?`)

// commandMeta keeps the Markdown Claude Code writes for its model after a
// command's output (/context's table) as that output, which reads better
// than the terminal's drawing of it.
func commandMeta(c *conv, typ string, content json.RawMessage) {
	if typ != "user" {
		return
	}
	var s string
	if json.Unmarshal(content, &s) != nil {
		return
	}
	s = strings.TrimSpace(s)
	if n := len(c.items); n > 0 && strings.HasPrefix(s, "## ") && c.items[n-1].Kind == "command" && !c.items[n-1].Markdown {
		c.items[n-1].Text, c.items[n-1].Markdown = clip(s, maxOutput), true
	}
}
