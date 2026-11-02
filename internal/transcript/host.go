package transcript

import (
	"bytes"
	"encoding/json"
	"time"
)

// SourceClaudeHost is a structured Claude Code session's own log, kept by
// berthd agent-host (internal/agenthost): each line an entry whose data is
// one line of Claude Code's stream-json. Its messages are the lines of
// Claude Code's transcript, so the Claude parser reads them, and the
// conversation reads as the transcript's would.
const SourceClaudeHost = "claude-host"

// hostEntry is the part of an agent-host log entry read here.
type hostEntry struct {
	Dir  string          `json:"dir"`
	At   int64           `json:"at"`
	Data json.RawMessage `json:"data"`
}

// hostHead is the part of a stream-json line that says whether it is one
// of the conversation's.
type hostHead struct {
	Type      string  `json:"type"`
	Subtype   string  `json:"subtype"`
	Parent    *string `json:"parent_tool_use_id"`
	Timestamp string  `json:"timestamp"`
	// A task_notification's: the call that started the helper, and how it
	// ended.
	ToolUseID string `json:"tool_use_id"`
	TaskID    string `json:"task_id"`
	Status    string `json:"status"`
	Summary   string `json:"summary"`
}

// unwrapHost is the transcript line a log entry carries: one of the
// conversation's messages, from the agent, with its time. A helper's
// messages (parent_tool_use_id set) are its own, as a subagent's file is.
func unwrapHost(b []byte) ([]byte, bool) {
	var e hostEntry
	if json.Unmarshal(b, &e) != nil || e.Dir != "out" || len(e.Data) == 0 || e.Data[0] != '{' {
		return nil, false
	}
	var h hostHead
	if json.Unmarshal(e.Data, &h) != nil {
		return nil, false
	}
	switch {
	case h.Parent != nil && *h.Parent != "":
		return nil, false
	case h.Type == "user", h.Type == "assistant":
	case h.Type == "system" && h.Subtype == "compact_boundary":
	case h.Type == "system" && h.Subtype == "task_notification":
		// A helper or a shell left working in the background is back. The
		// stream says so in a line of its own, where the transcript queues
		// Claude a <task-notification>: read as that, so the crew shows it
		// back and the shell ended, with its exit code.
		if h.ToolUseID == "" || h.Status == "" {
			return nil, false
		}
		note := "<task-notification>\n<task-id>" + h.TaskID + "</task-id>\n<tool-use-id>" + h.ToolUseID + "</tool-use-id>\n<status>" + h.Status + "</status>\n<summary>" + h.Summary + "</summary>\n</task-notification>"
		line, _ := json.Marshal(map[string]string{
			"type": "queue-operation", "operation": "enqueue", "content": note,
			"timestamp": time.UnixMilli(e.At).UTC().Format(time.RFC3339Nano),
		})
		return line, true
	default:
		return nil, false
	}
	if h.Timestamp != "" || e.At == 0 {
		return e.Data, true
	}
	// Stream-json lines carry no time of their own: the log's is theirs.
	// A key put first is overridden by one of the line's own.
	ts, _ := json.Marshal(time.UnixMilli(e.At).UTC().Format(time.RFC3339Nano))
	out := make([]byte, 0, len(e.Data)+len(ts)+16)
	out = append(out, `{"timestamp":`...)
	out = append(out, ts...)
	if rest := bytes.TrimLeft(e.Data[1:], " \t\r\n"); len(rest) > 0 && rest[0] != '}' {
		out = append(out, ',')
	}
	return append(out, e.Data[1:]...), true
}

// shownSource is the agent a conversation's source is: a structured Claude
// session's log is Claude's conversation.
func shownSource(source string) string {
	switch source {
	case SourceClaudeHost:
		return "claude"
	case SourceCodexHost:
		return "codex"
	case SourceACPHost:
		return "acp"
	}
	return source
}

// hostParser reads an agent-host log with the Claude parser.
type hostParser struct{ claudeParser }

func (p hostParser) line(c *conv, b []byte) {
	if line, ok := unwrapHost(b); ok {
		p.claudeParser.line(c, line)
	}
}
