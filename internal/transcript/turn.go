package transcript

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// The files an agent changed in its latest turn, for the app's ⌘P picker
// and File tab: which files, when, and, where the agent's record keeps it,
// each file as the turn found it, so the app can mark what the turn
// changed rather than everything since the last commit.
//
// Claude Code keeps the file as it was before each edit beside the edit's
// result (toolUseResult.originalFile; a Write that made the file says
// type "create"). The first edit of a file in the turn holds the file as
// the turn found it. Codex's record has no such copy: its files are listed
// with the counts its patches give, and Original stays nil.

// TurnFile is one file the agent changed in the turn.
type TurnFile struct {
	// Path is as the record names it: absolute (Claude Code), or relative
	// to the session's directory.
	Path string
	// Added and Removed are what the edits themselves count, summed: an
	// estimate, since two edits can touch the same lines.
	Added, Removed int
	// Created: the turn made the file (its first write created it).
	Created bool
	// Original is the file before the turn's first edit to it, when the
	// record kept it. Nil for a file the turn created, and for records that
	// don't keep it.
	Original *string
	// At is when the last edit to it finished (Unix ms), when known.
	At int64
}

// Turn is the agent's latest turn: since the last prompt.
type Turn struct {
	// Off is where the prompt's line starts in the record; Started when it
	// was sent (Unix ms, when known).
	Off     int64
	Started int64
	Files   []TurnFile
}

// maxTurnPages bounds how far back the prompt that began the turn is
// looked for, in pages of older items.
const maxTurnPages = 8

// LastTurn reads the agent's latest turn from its record.
func LastTurn(source, path, dir string) (Turn, error) {
	off, err := lastPrompt(source, path, dir)
	if err != nil {
		return Turn{}, err
	}
	if source == "codex" {
		return codexTurn(path, dir, off)
	}
	return claudeTurn(path, off)
}

// lastPrompt is where the latest prompt's line starts: 0 when the record
// has none (or none recent enough to find).
func lastPrompt(source, path, dir string) (int64, error) {
	before := int64(0)
	for range maxTurnPages {
		page, err := Before(source, path, dir, before, 80)
		if err != nil {
			return 0, err
		}
		for i := len(page.Items) - 1; i >= 0; i-- {
			if page.Items[i].Kind == "user" {
				return page.Items[i].Off, nil
			}
		}
		if !page.More || len(page.Items) == 0 {
			return 0, nil
		}
		before = page.Items[0].Off
	}
	return 0, nil
}

func isEditTool(name string) bool {
	return name == "Edit" || name == "MultiEdit" || name == "Write" || name == "NotebookEdit"
}

// claudeTurn reads Claude Code's record from the prompt at off: each edit
// call's file, and from its result whether it worked, when, and the file
// as it found it.
func claudeTurn(path string, off int64) (Turn, error) {
	f, err := os.Open(path)
	if err != nil {
		return Turn{}, err
	}
	defer f.Close()
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return Turn{}, err
	}
	t := Turn{Off: off}
	calls := map[string]editCall{}
	byFile := map[string]int{}
	r := bufio.NewReaderSize(f, 256<<10)
	first := true
	var line []byte
	for {
		var err error
		line, err = readLineInto(r, line)
		if len(line) > 0 {
			if first {
				var l struct {
					Timestamp string `json:"timestamp"`
				}
				if json.Unmarshal(line, &l) == nil {
					t.Started = parseTime(l.Timestamp)
				}
				first = false
			}
			if bytes.Contains(line, []byte(`"tool_use`)) {
				claudeTurnLine(line, &t, calls, byFile)
			}
		}
		if err != nil {
			break
		}
	}
	return t, nil
}

// editCall is an edit the turn asked for, until its result says how it went.
type editCall struct {
	file           string
	added, removed int
}

// claudeTurnLine reads one line of the turn: an edit call, or an edit's
// result.
func claudeTurnLine(line []byte, t *Turn, calls map[string]editCall, byFile map[string]int) {
	var l struct {
		Timestamp string `json:"timestamp"`
		Message   struct {
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
		IsError   bool            `json:"is_error"`
	}
	if json.Unmarshal(l.Message.Content, &blocks) != nil {
		return
	}
	for _, b := range blocks {
		switch {
		case b.Type == "tool_use" && isEditTool(b.Name):
			var in map[string]any
			_ = json.Unmarshal(b.Input, &in)
			str := func(k string) string { v, _ := in[k].(string); return v }
			file := firstNonEmpty(str("file_path"), str("notebook_path"))
			if file == "" || strings.Contains(file, "/.claude/plans/") {
				continue
			}
			added, removed := 0, 0
			switch b.Name {
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
			calls[b.ID] = editCall{file: filepath.Clean(file), added: added, removed: removed}
		case b.Type == "tool_result":
			c, ok := calls[b.ToolUseID]
			if !ok || b.IsError {
				continue
			}
			var res struct {
				Type         string          `json:"type"`
				OriginalFile json.RawMessage `json:"originalFile"`
			}
			if len(l.ToolUseResult) > 0 && l.ToolUseResult[0] == '{' {
				_ = json.Unmarshal(l.ToolUseResult, &res)
			}
			i, seen := byFile[c.file]
			if !seen {
				tf := TurnFile{Path: c.file}
				var orig string
				switch {
				case res.Type == "create":
					tf.Created = true
				case len(res.OriginalFile) > 0 && res.OriginalFile[0] == '"' && json.Unmarshal(res.OriginalFile, &orig) == nil:
					tf.Original = &orig
				}
				t.Files = append(t.Files, tf)
				i = len(t.Files) - 1
				byFile[c.file] = i
			}
			t.Files[i].Added += c.added
			t.Files[i].Removed += c.removed
			if at := parseTime(l.Timestamp); at > 0 {
				t.Files[i].At = at
			}
		}
	}
}

// codexTurn is the turn's edits as the conversation's items have them:
// Codex keeps no copy of a file before its patch.
func codexTurn(path, dir string, off int64) (Turn, error) {
	f, err := os.Open(path)
	if err != nil {
		return Turn{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return Turn{}, err
	}
	c := &conv{source: "codex", dir: dir, paged: true, limit: keep, p: parserFor("codex"), byTool: map[string]int{}, crewByID: map[string]int{}}
	if err := c.scan(f, off, st.Size()); err != nil {
		return Turn{}, err
	}
	t := Turn{Off: off}
	byFile := map[string]int{}
	for _, it := range c.items {
		if it.Kind != "edit" || it.File == "" {
			continue
		}
		i, ok := byFile[it.File]
		if !ok {
			t.Files = append(t.Files, TurnFile{Path: it.File})
			i = len(t.Files) - 1
			byFile[it.File] = i
		}
		t.Files[i].Added += it.Added
		t.Files[i].Removed += it.Removed
	}
	return t, nil
}
