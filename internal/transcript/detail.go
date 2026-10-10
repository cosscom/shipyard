package transcript

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// ToolDetail is one tool call opened up, the way the agent's terminal shows
// it when expanded: the full command and its output, an edit's exact
// change, a written file's contents. It is read from the transcript only
// when someone opens the call, from their own box, and is never kept.
type ToolDetail struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command,omitempty"`
	File    string `json:"file,omitempty"`
	Pattern string `json:"pattern,omitempty"`
	// An edit: the text it replaced and what it put there; a write: the
	// whole new file in New.
	Old string `json:"old,omitempty"`
	New string `json:"new,omitempty"`
	// Hunks is the change as Claude Code recorded it in the file, numbered
	// by the file's own lines (its structuredPatch). Older records, other
	// agents and very large changes have none: Old and New, numbered from
	// 1, are what there is then.
	Hunks []Hunk `json:"hunks,omitempty"`
	// What the call returned, its head and tail when it is long.
	Output    string `json:"output,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	Error     bool   `json:"error,omitempty"`
	// A call nobody has answered yet.
	Pending bool `json:"pending,omitempty"`
	// Live is a background shell whose output is still growing.
	Live bool `json:"live,omitempty"`
}

// Hunk is one piece of a change, as a unified diff has it: where it starts
// in the old and new file, how many lines it spans in each, and its lines,
// each led by ' ', '-' or '+'.
type Hunk struct {
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

// ErrNoTool is a call the transcript doesn't hold (any more).
var ErrNoTool = errors.New("no such tool call in this conversation")

const (
	// detailWindow is how far back a call is looked for: the end of the
	// file, where the conversation on screen is.
	detailWindow = 32 << 20
	detailLine   = 16 << 20
	outputCap    = 32 << 10
	textCap      = 64 << 10
)

// Detail finds one call in a transcript by its ID.
func Detail(source, path, dir, id string) (ToolDetail, error) {
	if id == "" || strings.ContainsAny(id, "\"\\\n") {
		return ToolDetail{}, ErrNoTool
	}
	f, err := os.Open(path)
	if err != nil {
		return ToolDetail{}, err
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > detailWindow {
		if _, err := f.Seek(st.Size()-detailWindow, io.SeekStart); err != nil {
			return ToolDetail{}, err
		}
	}
	r := bufio.NewReaderSize(f, 256<<10)
	needle := []byte(`"` + id + `"`)
	d := ToolDetail{ID: id}
	found, answered := false, false
	var line []byte
	for {
		var err error
		line, err = readLineInto(r, line)
		if len(line) > 0 && bytes.Contains(line, needle) {
			var call, result bool
			if source == "codex" {
				call, result = codexDetail(line, id, dir, &d)
			} else {
				call, result = claudeDetail(line, id, dir, &d)
			}
			found = found || call
			answered = answered || result
		}
		if err != nil {
			break
		}
	}
	if !found {
		return ToolDetail{}, ErrNoTool
	}
	d.Pending = !answered
	liveOutput(&d)
	return d, nil
}

// readLine reads one line, skipping (not keeping) any longer than
// detailLine.
func readLine(r *bufio.Reader) ([]byte, error) { return readLineInto(r, nil) }

// readLineInto is readLine into buf's space: a scan of a long record reuses
// one buffer rather than allocating every line again. The line is good
// until the next call.
func readLineInto(r *bufio.Reader, buf []byte) ([]byte, error) {
	buf = buf[:0]
	over := false
	for {
		chunk, err := r.ReadSlice('\n')
		if !over {
			if len(buf)+len(chunk) > detailLine {
				over, buf = true, buf[:0]
			} else {
				buf = append(buf, chunk...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		return buf, err
	}
}

func claudeDetail(line []byte, id, dir string, d *ToolDetail) (call, result bool) {
	var l struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		ToolUseResult json.RawMessage `json:"toolUseResult"`
	}
	if json.Unmarshal(line, &l) != nil {
		return
	}
	var blocks []struct {
		Type      string          `json:"type"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Input     json.RawMessage `json:"input"`
		ToolUseID string          `json:"tool_use_id"`
		Content   json.RawMessage `json:"content"`
		IsError   bool            `json:"is_error"`
	}
	if json.Unmarshal(l.Message.Content, &blocks) != nil {
		return
	}
	for _, b := range blocks {
		switch {
		case b.Type == "tool_use" && b.ID == id:
			call = true
			d.Name = b.Name
			var in map[string]any
			_ = json.Unmarshal(b.Input, &in)
			str := func(k string) string { v, _ := in[k].(string); return v }
			d.Command = clip(str("command"), textCap)
			if p := firstNonEmpty(str("file_path"), str("notebook_path"), str("path")); p != "" {
				d.File = rel(dir, p)
			}
			d.Pattern = firstNonEmpty(str("pattern"), str("query"), str("url"))
			switch b.Name {
			case "Edit":
				d.Old, d.New = clip(str("old_string"), textCap), clip(str("new_string"), textCap)
			case "MultiEdit":
				var olds, news []string
				if edits, ok := in["edits"].([]any); ok {
					for _, e := range edits {
						if m, ok := e.(map[string]any); ok {
							o, _ := m["old_string"].(string)
							n, _ := m["new_string"].(string)
							olds, news = append(olds, o), append(news, n)
						}
					}
				}
				d.Old, d.New = clip(strings.Join(olds, "\n⋯\n"), textCap), clip(strings.Join(news, "\n⋯\n"), textCap)
			case "Write":
				d.New = clip(str("content"), textCap)
			default:
				if d.Command == "" && d.File == "" && d.Pattern == "" {
					// Any other tool: its input, as the terminal prints it.
					d.Command = clip(string(b.Input), 2<<10)
				}
			}
		case b.Type == "tool_result" && b.ToolUseID == id:
			result = true
			d.Error = b.IsError
			d.Output, d.Truncated = capOutput(resultFull(b.Content))
			if !b.IsError {
				d.Hunks = structuredHunks(l.ToolUseResult)
			}
		}
	}
	return
}

// structuredHunks reads the hunks Claude Code keeps beside an edit's or a
// write's result (toolUseResult.structuredPatch), or none: a result without
// them, a malformed one, or one past textCap (twice: both sides), which
// reads as its old and new text instead.
func structuredHunks(raw json.RawMessage) []Hunk {
	if len(raw) == 0 || raw[0] != '{' {
		return nil
	}
	var r struct {
		StructuredPatch []Hunk `json:"structuredPatch"`
	}
	if json.Unmarshal(raw, &r) != nil || len(r.StructuredPatch) == 0 {
		return nil
	}
	size := 0
	for _, h := range r.StructuredPatch {
		if h.OldStart < 0 || h.NewStart < 0 || h.OldLines < 0 || h.NewLines < 0 || len(h.Lines) == 0 {
			return nil
		}
		for _, l := range h.Lines {
			if l == "" || !strings.ContainsRune(" -+\\", rune(l[0])) {
				return nil
			}
			size += len(l) + 1
		}
		if size > 2*textCap {
			return nil
		}
	}
	return r.StructuredPatch
}

// resultFull is a tool result's whole text: a string, or all its text blocks.
func resultFull(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var out []string
	for _, p := range parts {
		if p.Type == "text" {
			out = append(out, p.Text)
		} else if p.Type == "image" {
			out = append(out, "[image]")
		}
	}
	return strings.Join(out, "\n")
}

func codexDetail(line []byte, id, dir string, d *ToolDetail) (call, result bool) {
	var l struct {
		Payload struct {
			Type      string `json:"type"`
			Name      string `json:"name"`
			CallID    string `json:"call_id"`
			Arguments string `json:"arguments"`
			Input     string `json:"input"`
			Output    any    `json:"output"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &l) != nil || l.Payload.CallID != id {
		return
	}
	p := l.Payload
	switch p.Type {
	case "function_call", "custom_tool_call", "local_shell_call":
		call = true
		d.Name = p.Name
		var args struct {
			Command any    `json:"command"`
			Cmd     string `json:"cmd"`
			Path    string `json:"path"`
		}
		_ = json.Unmarshal([]byte(p.Arguments), &args)
		cmd := args.Cmd
		switch v := args.Command.(type) {
		case string:
			cmd = v
		case []any:
			var parts []string
			for _, x := range v {
				if s, ok := x.(string); ok {
					parts = append(parts, s)
				}
			}
			if len(parts) == 3 && (parts[1] == "-lc" || parts[1] == "-c") {
				cmd = parts[2]
			} else {
				cmd = strings.Join(parts, " ")
			}
		}
		if p.Name == "apply_patch" || strings.Contains(cmd, "apply_patch") {
			d.New = clip(firstNonEmpty(p.Input, patchFromArgs(p.Arguments), cmd), textCap)
		} else {
			d.Command = clip(cmd, textCap)
		}
		if args.Path != "" {
			d.File = rel(dir, args.Path)
		}
	case "function_call_output", "custom_tool_call_output", "local_shell_call_output":
		result = true
		out := ""
		switch v := p.Output.(type) {
		case string:
			// Codex wraps it as {"output": "...", "metadata": {"exit_code": n}}.
			var w struct {
				Output   string `json:"output"`
				Metadata struct {
					ExitCode int `json:"exit_code"`
				} `json:"metadata"`
			}
			if json.Unmarshal([]byte(v), &w) == nil && w.Output != "" {
				out, d.Error = w.Output, w.Metadata.ExitCode != 0
			} else {
				out = v
			}
		default:
			b, _ := json.Marshal(v)
			out = string(b)
		}
		d.Output, d.Truncated = capOutput(out)
	}
	return
}

// ansi matches terminal escape sequences: colours, cursor moves, titles.
var ansi = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r`)

// plain is a command's output as text: tools such as lefthook colour theirs
// for a terminal, which reads as noise anywhere else.
func plain(s string) string {
	if !strings.ContainsAny(s, "\x1b\r") {
		return s
	}
	return ansi.ReplaceAllString(s, "")
}

// capOutput keeps a long output's head and tail, as the terminal does.
func capOutput(s string) (string, bool) {
	s = plain(s)
	if len(s) <= outputCap {
		return s, false
	}
	head, tail := s[:outputCap/2], s[len(s)-outputCap/2:]
	cut := strings.Count(s[outputCap/2:len(s)-outputCap/2], "\n")
	return head + "\n… " + strconv.Itoa(cut) + " more lines …\n" + tail, true
}
