package transcript

import (
	"bufio"
	"bytes"
	"encoding/base64"
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
	// Images are the pictures the call returned that the app can show,
	// fetched one by one (GET …/tool/{id}/image/{n}): never inline, so a
	// detail stays small. Output keeps an "[image]" line for every one.
	Images []ToolImage `json:"images,omitempty"`
}

// ToolImage is one picture in a call's result. N counts the result's image
// blocks, the ones not served too; Line is where it stands in Output: its
// "[image]" line, or the "… more lines …" line when the middle was cut.
type ToolImage struct {
	N         int    `json:"n"`
	Line      int    `json:"line"`
	MediaType string `json:"mediaType"`
}

// imageTypes are the pictures a result's image may be served as.
var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// servable says an image block's source is one the box serves.
func servable(sourceType, mediaType string) bool {
	return sourceType == "base64" && imageTypes[mediaType]
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

// ErrNoImage is a picture a call's result doesn't hold, or not as one of
// imageTypes.
var ErrNoImage = errors.New("no such image in that step")

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
	d := ToolDetail{ID: id}
	found, answered := false, false
	err := scanFor(path, id, func(line []byte) bool {
		var call, result bool
		if source == "codex" {
			call, result = codexDetail(line, id, dir, &d)
		} else if source == SourceCodexHost {
			call, result = codexHostDetail(line, id, dir, &d)
		} else if source == SourceClaudeHost {
			if inner, ok := unwrapHost(line); ok {
				call, result = claudeDetail(inner, id, dir, &d)
			}
		} else {
			call, result = claudeDetail(line, id, dir, &d)
		}
		found = found || call
		answered = answered || result
		return false
	})
	if err != nil {
		return ToolDetail{}, err
	}
	if !found {
		return ToolDetail{}, ErrNoTool
	}
	d.Pending = !answered
	liveOutput(&d)
	return d, nil
}

// Image is the n-th picture in call id's result, decoded: its type and
// bytes. Only Claude Code's results hold pictures.
func Image(source, path, id string, n int) (string, []byte, error) {
	if n < 0 || (source != "claude" && source != SourceClaudeHost) {
		return "", nil, ErrNoImage
	}
	var typ string
	var data []byte
	err := scanFor(path, id, func(line []byte) bool {
		if source == SourceClaudeHost {
			var ok bool
			if line, ok = unwrapHost(line); !ok {
				return false
			}
		}
		results := claudeResults(line, id)
		if len(results) == 0 {
			return false
		}
		typ, data = resultImage(results[0], n)
		return true
	})
	if errors.Is(err, ErrNoTool) || (err == nil && data == nil) {
		return "", nil, ErrNoImage
	}
	return typ, data, err
}

// scanFor calls fn with each line of the transcript's last detailWindow
// that mentions id, until fn says it has what it wanted.
func scanFor(path, id string, fn func(line []byte) (done bool)) error {
	if id == "" || strings.ContainsAny(id, "\"\\\n") {
		return ErrNoTool
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > detailWindow {
		if _, err := f.Seek(st.Size()-detailWindow, io.SeekStart); err != nil {
			return err
		}
	}
	r := bufio.NewReaderSize(f, 256<<10)
	needle := []byte(`"` + id + `"`)
	var line []byte
	for {
		var err error
		line, err = readLineInto(r, line)
		if len(line) > 0 && bytes.Contains(line, needle) && fn(line) {
			return nil
		}
		if err != nil {
			return nil
		}
	}
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
		// The same, as Claude Code's stream (a structured session's log)
		// names it.
		StreamResult json.RawMessage `json:"tool_use_result"`
	}
	if json.Unmarshal(line, &l) != nil {
		return
	}
	if len(l.ToolUseResult) == 0 {
		l.ToolUseResult = l.StreamResult
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
			full, images := resultParts(b.Content)
			d.Output, d.Truncated = capOutput(full)
			if d.Truncated {
				full = plain(full)
				for i := range images {
					images[i].Line = cappedLine(full, images[i].Line)
				}
			}
			d.Images = images
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
	s, _ := resultParts(raw)
	return s
}

// resultParts is a tool result's whole text, with an "[image]" line for
// each of its pictures, and the pictures the box serves, each at its line.
// Their bytes are skipped, not read.
func resultParts(raw json.RawMessage) (string, []ToolImage) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, nil
	}
	var parts []struct {
		Type   string `json:"type"`
		Text   string `json:"text"`
		Source struct {
			Type      string `json:"type"`
			MediaType string `json:"media_type"`
		} `json:"source"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return "", nil
	}
	var out []string
	var images []ToolImage
	line, n := 0, 0
	for _, p := range parts {
		switch p.Type {
		case "text":
			out = append(out, p.Text)
			line += strings.Count(p.Text, "\n") + 1
		case "image":
			if servable(p.Source.Type, p.Source.MediaType) {
				images = append(images, ToolImage{N: n, Line: line, MediaType: p.Source.MediaType})
			}
			out = append(out, "[image]")
			line, n = line+1, n+1
		}
	}
	return strings.Join(out, "\n"), images
}

// resultImage is the n-th image block in a tool's result, decoded, if the
// box serves it.
func resultImage(raw json.RawMessage, n int) (string, []byte) {
	if !isArray(raw) {
		return "", nil
	}
	var parts []json.RawMessage
	if json.Unmarshal(raw, &parts) != nil {
		return "", nil
	}
	for _, p := range parts {
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(p, &head) != nil || head.Type != "image" {
			continue
		}
		if n--; n >= 0 {
			continue
		}
		var img struct {
			Source struct {
				Type      string `json:"type"`
				MediaType string `json:"media_type"`
				Data      string `json:"data"`
			} `json:"source"`
		}
		if json.Unmarshal(p, &img) != nil || !servable(img.Source.Type, img.Source.MediaType) {
			return "", nil
		}
		data, err := base64.StdEncoding.DecodeString(img.Source.Data)
		if err != nil {
			return "", nil
		}
		return img.Source.MediaType, data
	}
	return "", nil
}

// claudeResults are the contents of line's tool_result blocks for call id.
func claudeResults(line []byte, id string) []json.RawMessage {
	var l struct {
		Message struct {
			Content []claudeBlock `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &l) != nil {
		return nil
	}
	var out []json.RawMessage
	for _, b := range l.Message.Content {
		if b.Type == "tool_result" && b.ToolUseID == id {
			out = append(out, b.Content)
		}
	}
	return out
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

// cappedLine is where line l of s, an output past outputCap, stands once
// capOutput has cut its middle: a line cut away (even in part) is the
// "… more lines …" line.
func cappedLine(s string, l int) int {
	head := strings.Count(s[:outputCap/2], "\n")
	if l < head {
		return l
	}
	tail := strings.Count(s[:len(s)-outputCap/2], "\n")
	if l > tail {
		return head + 2 + l - tail
	}
	return head + 1
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
