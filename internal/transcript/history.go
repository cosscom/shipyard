package transcript

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// A conversation's history beyond what is followed live: older items a
// page at a time, the helpers' (subagents') own conversations, and a copy
// of Claude Code's record up to a point, which a fork resumes.

const (
	// maxSpan is the most of a file read back for one page of older items.
	maxSpan = 64 << 20
	// maxHelpers is how many helpers a session lists, newest first.
	maxHelpers = 100
)

func parserFor(source string) parser {
	switch source {
	case "codex":
		return &codexParser{}
	case SourceClaudeHost:
		return &hostParser{}
	case SourceCodexHost:
		return &codexHostParser{}
	case SourceACPHost:
		return &acpHostParser{}
	}
	return &claudeParser{}
}

// Before reads a page of older items: at most limit, made by lines that
// start before the offset before, newest last. Each is named by where its
// line starts, so pages never repeat one, and none are kept. More says
// earlier ones remain.
func Before(source, path, dir string, before int64, limit int) (Result, error) {
	f, err := os.Open(path)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return Result{}, err
	}
	if before <= 0 || before > st.Size() {
		before = st.Size()
	}
	if limit <= 0 || limit > keep {
		limit = keep
	}
	for span := int64(1 << 20); ; span *= 4 {
		start := max(0, before-span)
		// One more than asked: read from the middle of a file, the first
		// item may be the tail of a group begun before it.
		c := newConv(source, dir, isHelper(path))
		c.paged, c.limit = true, limit+1
		if err := c.scan(f, start, before); err != nil {
			return Result{}, err
		}
		if len(c.items) > limit || start == 0 || span >= maxSpan {
			items := c.items
			more := start > 0 || c.base > 0
			if len(items) > limit || (start > 0 && len(items) > 0) {
				items = items[1:]
			}
			// Every older item has one after it, so its calls are done.
			for i := range items {
				if items[i].Kind == "tools" || items[i].Kind == "artifact" {
					items[i].Done, items[i].pending = true, nil
				}
			}
			return Result{Source: shownSource(source), Items: append([]Item{}, items...), Crew: []CrewMember{}, More: more}, nil
		}
	}
}

// scan parses the lines that start in [from, to): from the first whole
// line at or after from.
func (c *conv) scan(f *os.File, from, to int64) error {
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return err
	}
	r := bufio.NewReaderSize(f, 64<<10)
	off := from
	if from > 0 { // the middle of a line: skip to the next
		n, err := skipLine(r)
		off += n
		if err != nil {
			return nil
		}
	}
	var line []byte
	for off < to {
		c.lineOff = off
		line = line[:0]
		over := false
		for {
			chunk, err := r.ReadSlice('\n')
			off += int64(len(chunk))
			if !over && len(line)+len(chunk) <= maxLine {
				line = append(line, chunk...)
			} else {
				over, line = true, line[:0]
			}
			if err == bufio.ErrBufferFull {
				continue
			}
			if err != nil {
				return nil // EOF: a line still being written is left for later
			}
			break
		}
		if t := bytes.TrimSpace(line); !over && len(t) > 0 && t[0] == '{' {
			c.p.line(c, t)
		}
	}
	return nil
}

func skipLine(r *bufio.Reader) (int64, error) {
	var n int64
	for {
		chunk, err := r.ReadSlice('\n')
		n += int64(len(chunk))
		if err == bufio.ErrBufferFull {
			continue
		}
		return n, err
	}
}

// Helper is one of a session's helpers (a subagent): its own conversation
// is the file agent-<ID>.jsonl beside the session's.
type Helper struct {
	ID string `json:"id"`
	// Tool is the call that started it (Task or Agent), when known.
	Tool   string `json:"tool,omitempty"`
	Type   string `json:"type,omitempty"`
	Name   string `json:"name"`
	Prompt string `json:"prompt,omitempty"`
	// Started and Updated are when it began and last wrote, in ms.
	Started int64 `json:"started"`
	Updated int64 `json:"updated"`
	// Depth is 1 for the session's own helpers, 2 for theirs.
	Depth      int  `json:"depth,omitempty"`
	Background bool `json:"background,omitempty"`
	// State is running or finished.
	State string `json:"state"`
}

var helperID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// isHelper says a file is a helper's own record.
func isHelper(path string) bool { return filepath.Base(filepath.Dir(path)) == "subagents" }

// HelpersDir is where Claude Code keeps the helpers of the conversation in
// path: <session-id>/subagents beside <session-id>.jsonl.
func HelpersDir(path string) string {
	return filepath.Join(strings.TrimSuffix(path, ".jsonl"), "subagents")
}

// HelperPath is the record of a session's helper id, if it has one.
func HelperPath(path, id string) (string, bool) {
	if !helperID.MatchString(id) {
		return "", false
	}
	p := filepath.Join(HelpersDir(path), "agent-"+id+".jsonl")
	return p, exists(p)
}

// Helpers lists the helpers of the conversation in path, oldest first,
// with what started each when the crew says (MatchHelpers).
func Helpers(path string) []Helper {
	files, _ := filepath.Glob(filepath.Join(HelpersDir(path), "agent-*.jsonl"))
	out := make([]Helper, 0, len(files))
	for _, p := range files {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		id := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(p), "agent-"), ".jsonl")
		if !helperID.MatchString(id) {
			continue
		}
		h := Helper{ID: id, Updated: st.ModTime().UnixMilli(), Started: st.ModTime().UnixMilli()}
		var meta struct {
			AgentType    string `json:"agentType"`
			Description  string `json:"description"`
			Name         string `json:"name"`
			ToolUseID    string `json:"toolUseId"`
			SpawnDepth   int    `json:"spawnDepth"`
			RequestShape string `json:"requestShape"`
		}
		if b, err := os.ReadFile(strings.TrimSuffix(p, ".jsonl") + ".meta.json"); err == nil && len(b) < 64<<10 {
			_ = json.Unmarshal(b, &meta)
		}
		h.Tool, h.Type, h.Depth = meta.ToolUseID, meta.AgentType, meta.SpawnDepth
		h.Name = clip(firstNonEmpty(meta.Description, meta.Name, meta.AgentType, "Helper"), 80)
		h.Background = meta.RequestShape == "background"
		if t, prompt := helperStart(p); t > 0 {
			h.Started, h.Prompt = t, prompt
		}
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Started < out[j].Started })
	if len(out) > maxHelpers {
		out = out[len(out)-maxHelpers:]
	}
	return out
}

// helperStart reads a helper's first line: when it began, and what it was
// asked.
func helperStart(p string) (int64, string) {
	f, err := os.Open(p)
	if err != nil {
		return 0, ""
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	line, err := readLine(r)
	if len(line) == 0 || len(line) >= detailLine || (err != nil && err != io.EOF) {
		return 0, ""
	}
	var l struct {
		Timestamp string `json:"timestamp"`
		Message   struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &l) != nil {
		return 0, ""
	}
	t, err := time.Parse(time.RFC3339Nano, l.Timestamp)
	if err != nil {
		return 0, ""
	}
	prompt := resultText(l.Message.Content)
	return t.UnixMilli(), clip(strings.TrimSpace(prompt), 400)
}

// MatchHelpers names the call behind each helper the record didn't (a
// teammate's, an older Claude Code's) from the crew: by its name, else the
// latest call started in the minute before it; and says which still work.
func MatchHelpers(hs []Helper, crew []CrewMember, now time.Time) {
	taken := map[string]bool{}
	for _, h := range hs {
		if h.Tool != "" {
			taken[h.Tool] = true
		}
	}
	for i := range hs {
		h := &hs[i]
		if h.Tool != "" {
			continue
		}
		for _, m := range crew {
			if !taken[m.ID] && m.Name == clip(h.Name, 60) {
				h.Tool = m.ID
				break
			}
		}
		if h.Tool == "" {
			best := ""
			var at int64
			for _, m := range crew {
				if !taken[m.ID] && m.Since <= h.Started && h.Started-m.Since < 60_000 && m.Since >= at {
					best, at = m.ID, m.Since
				}
			}
			h.Tool = best
		}
		if h.Tool != "" {
			taken[h.Tool] = true
		}
	}
	state := map[string]string{}
	for _, m := range crew {
		state[m.ID] = m.State
	}
	for i := range hs {
		h := &hs[i]
		switch s, ok := state[h.Tool]; {
		case ok && s == "finished":
			h.State = "finished"
		case ok:
			h.State = "running"
		case now.UnixMilli()-h.Updated < 30_000:
			h.State = "running"
		default:
			h.State = "finished"
		}
	}
}

// ErrNoEntry is a fork point the record doesn't hold.
var ErrNoEntry = errors.New("that message is no longer in the agent's record")

// ForkClaude copies Claude Code's record in path up to and including the
// entry at, as a new conversation beside it, and returns the new one's ID:
// resuming it goes on from that point, the original untouched. Claude Code
// only truncates a resume in print mode, so the copy is the fork.
func ForkClaude(path, at string) (string, error) {
	if !validID(at) {
		return "", ErrNoEntry
	}
	src, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer src.Close()
	id, err := newUUID()
	if err != nil {
		return "", err
	}
	dst := filepath.Join(filepath.Dir(path), id+".jsonl")
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	w := bufio.NewWriterSize(out, 256<<10)
	old := []byte(`"sessionId":"` + strings.TrimSuffix(filepath.Base(path), ".jsonl") + `"`)
	repl := []byte(`"sessionId":"` + id + `"`)
	needle := []byte(`"uuid":"` + at + `"`)
	r := bufio.NewReaderSize(src, 256<<10)
	// Streamed, so a long line (a pasted image) costs no memory; the
	// needle is looked for across the pieces of a line.
	found := false
	var tail []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if len(chunk) > 0 {
			probe := append(tail, chunk...)
			if bytes.Contains(probe, needle) {
				found = true
			}
			if _, werr := w.Write(bytes.ReplaceAll(chunk, old, repl)); werr != nil {
				out.Close()
				return "", werr
			}
			tail = append(tail[:0], probe[max(0, len(probe)-len(needle)):]...)
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		tail = tail[:0]
		if found || err != nil {
			if found && (len(chunk) == 0 || chunk[len(chunk)-1] != '\n') {
				_ = w.WriteByte('\n')
			}
			break
		}
	}
	if err := w.Flush(); err != nil {
		out.Close()
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	if !found {
		return "", ErrNoEntry
	}
	if err := os.Rename(tmp, dst); err != nil {
		return "", err
	}
	return id, nil
}

func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

// rewound drops what a rewind took back: a prompt that picks up where an
// earlier one did (Claude Code's /rewind, or Esc Esc) replaces it and
// everything after it, as the agent's own conversation now does.
func (c *conv) rewound() {
	k, ok := c.prompts[c.lineParent]
	if c.lineParent == "" || !ok || k < c.base || k >= c.base+len(c.items) {
		return
	}
	c.items = c.items[:k-c.base]
	// What was sent is no longer the conversation: the app reads it afresh.
	c.rev++
	for id, i := range c.byTool {
		if i >= k {
			delete(c.byTool, id)
		}
	}
	for p, i := range c.prompts {
		if i >= k {
			delete(c.prompts, p)
		}
	}
	for id, call := range c.artCalls {
		if call.item >= k {
			delete(c.artCalls, id)
		}
	}
}

// prompted notes where the prompt at index i picked up.
func (c *conv) prompted(i int) {
	if c.lineParent == "" {
		return
	}
	if c.prompts == nil {
		c.prompts = map[string]int{}
	}
	for p, j := range c.prompts {
		if j < c.base { // dropped off: forget it
			delete(c.prompts, p)
		}
	}
	c.prompts[c.lineParent] = i
}
