// Package transcript reads a coding agent's own record of its conversation
// (Claude Code's transcript, Codex's session file) and turns it into the
// short items the app's Conversation view draws: what was asked, what the
// agent said, its tool calls in groups, its edits, and the helpers it
// started. Tool output and the agent's thinking are never read out: only
// that a call finished. Nothing is stored; a file is read as it grows, and
// only the last items are kept.
package transcript

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Item is one entry in the conversation. Kind is user, text, tools, edit,
// crew, command, notice, artifact, question, report, agent-message or
// ping; the fields each kind uses are as in app/src/lib/transcript.ts. An
// app that doesn't know a kind draws nothing for it.
type Item struct {
	Kind    string     `json:"kind"`
	ID      string     `json:"id"`
	Text    string     `json:"text,omitempty"`
	Verb    string     `json:"verb,omitempty"`
	Items   []ToolCall `json:"items,omitempty"`
	Done    bool       `json:"done,omitempty"`
	File    string     `json:"file,omitempty"`
	Added   int        `json:"added,omitempty"`
	Removed int        `json:"removed,omitempty"`
	Names   []string   `json:"names,omitempty"`
	// Tool is the call behind an edit, for its exact change.
	Tool string `json:"tool,omitempty"`
	// A notice (an API error, a usage limit, a failed hook, an interrupted
	// turn): its type, error, warning or info, and when a limit resets.
	Notice string `json:"notice,omitempty"`
	Level  string `json:"level,omitempty"`
	Resets int64  `json:"resets,omitempty"`
	// Off is where the line that made this item starts in the file: older
	// items are paged by it (?before=Off).
	Off int64 `json:"off,omitempty"`
	// UUID and Parent are a prompt's own entry in Claude Code's record and
	// the entry before it, where a fork from this prompt picks up.
	UUID   string `json:"uuid,omitempty"`
	Parent string `json:"parent,omitempty"`
	// Command is a command item's command: "/model", or "!" for a shell
	// command typed to the agent; Args what followed it, and Text its
	// output (Markdown when the agent wrote it so, Error when it failed).
	Command  string `json:"command,omitempty"`
	Args     string `json:"args,omitempty"`
	Markdown bool   `json:"markdown,omitempty"`
	Error    bool   `json:"error,omitempty"`
	// An artifact item (artifacts.go): the page's link once published, what
	// the agent said it is, and whether it was published before. Text is
	// its title and File the file published; Error, a publish that failed.
	URL         string `json:"url,omitempty"`
	Description string `json:"description,omitempty"`
	Updated     bool   `json:"updated,omitempty"`
	// Local is an artifact kept on the box (`berthd artifact add`,
	// localartifacts.go) instead of a page: its id, and Version the
	// version the command made.
	Local   string `json:"local,omitempty"`
	Version int    `json:"version,omitempty"`
	// A question item (questions.go): the questions the agent asked with
	// its own form, and once answered, the answer to each (Done; Error when
	// it was not answered).
	Questions []Question `json:"questions,omitempty"`
	Answers   []string   `json:"answers,omitempty"`
	// A report item (report.go): work the agent started that berth said
	// ended, waits for a person, or reached a gate.
	Report *Report `json:"report,omitempty"`
	// An agent-message or ping item (peer.go): a message from another
	// agent or from Claude Code, not the person.
	Msg *Message `json:"msg,omitempty"`
	// MidTurn: a prompt the person typed while the agent worked.
	MidTurn bool `json:"midTurn,omitempty"`

	// pending are the tool calls in a group still waiting for a result.
	pending map[string]bool
	// confirmed: a hand-back's card that its helper's notification
	// folded into already (peer.go).
	confirmed bool
	// resolved is the index the next item would take when an artifact's
	// publish settled: a reader asking from it or earlier gets it again.
	resolved int
}

// ToolCall is one call in a group: "Read webhook.ts", "Run pnpm test".
type ToolCall struct {
	Verb   string `json:"verb"`
	Target string `json:"target"`
	File   bool   `json:"file,omitempty"`
	// ID names the call for its details (GET …/transcript/tool/{id}).
	ID string `json:"id,omitempty"`
	// At is when the agent made the call (Unix ms): a call still running
	// is timed from it.
	At int64 `json:"at,omitempty"`
}

// CrewMember is a helper the agent started: a subagent.
type CrewMember struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Agent string `json:"agent"`
	State string `json:"state"`
	Doing string `json:"doing"`
	Since int64  `json:"since"`
	Until int64  `json:"until,omitempty"`
}

// Result answers GET /v1/sessions/{name}/transcript?since=N: the items at
// index N and after (an open tool group is sent again until it is done, so
// the app replaces items by ID), the index to ask from next, and the crew.
type Result struct {
	Source    string       `json:"source"`
	Items     []Item       `json:"items"`
	Next      int          `json:"next"`
	Crew      []CrewMember `json:"crew"`
	Truncated bool         `json:"truncated,omitempty"`
	// Last is when the agent last wrote to its record (Unix ms): what it
	// has been thinking since.
	Last int64 `json:"last,omitempty"`
	// More, on a page of older items (?before=), says earlier ones remain.
	More bool `json:"more,omitempty"`
	// Reason says why there is nothing to show, when Source is "none".
	Reason string `json:"reason,omitempty"`
	// Gen names this reading of the file: it changes when the box reads it
	// afresh (a restart, a conversation idle long enough to be let go, a
	// rewind), and then `since` no longer counts the same items. An answer
	// to ?gen= that no longer holds is Reset: the whole window, from Start,
	// the offset of its first item, so the app keeps what it holds before
	// Start and takes the rest from here. Items are named by where their
	// line starts, so a window read afresh names them as before.
	Gen   string `json:"gen,omitempty"`
	Reset bool   `json:"reset,omitempty"`
	Start int64  `json:"start,omitempty"`
	// File is the record read: Claude Code's conversation ID, or the Codex
	// session file's name. Another file is another conversation.
	File string `json:"file,omitempty"`
	// Signals are the agent's mode, model, context, task list and
	// background work (signals.go).
	Signals *Signals `json:"signals,omitempty"`
	// Artifacts are the pages the agent published on claude.ai, one per
	// page, newest last (artifacts.go). Every answer has them all.
	Artifacts []Artifact `json:"artifacts,omitempty"`
}

const (
	// keep is how many items a conversation holds; older ones drop off.
	keep = 300
	// maxStart is how much of a long file is read when it is first opened:
	// its end, where the recent conversation is.
	maxStart = 4 << 20
	// maxText is the most of one reply kept: a long answer, its tables and
	// code included, reads whole.
	maxText = 32 << 10
	// maxLine skips absurd lines (a pasted image's data) without reading
	// them into memory.
	maxLine = 1 << 20
	// idle is how long an unread conversation stays cached.
	idle    = 10 * time.Minute
	maxOpen = 32
)

// parser turns one line of a file into changes to the conversation.
type parser interface {
	line(c *conv, b []byte)
}

// conv is one file being followed.
type conv struct {
	source   string
	dir      string
	items    []Item
	base     int            // index of items[0]
	byTool   map[string]int // tool call ID → absolute index of its group
	crew     []CrewMember
	crewByID map[string]int
	// agentIDs are helpers' agent IDs → the call that started each.
	agentIDs map[string]string
	// via is how each recent message arrived, and when (peer.go).
	via map[string][2]int
	// background are helpers started in the background, still out.
	background map[string]bool
	offset     int64
	partial    []byte
	truncated  bool
	used       time.Time
	p          parser
	// gen names this reading (see Result.Gen); rev counts its rewinds.
	gen int64
	rev int
	// queued are messages shown from a mid-turn queued_command, so their
	// user line (if Claude Code writes one later) isn't shown twice.
	queued map[string]bool
	// sig is what the conversation says about the agent (signals.go).
	sig signals
	// lineAt is when the last line the agent wrote was written (Unix ms).
	lineAt int64

	// The line being read: where it starts, and its entry's IDs.
	lineOff    int64
	lineUUID   string
	lineParent string
	// A paged conv reads older items (see Before): it keeps limit items
	// and names each by its line's offset, so a page reads the same
	// wherever its reading began.
	paged bool
	limit int
	// side reads a helper's own record, whose every line is a sidechain.
	side bool
	// prompts are where each kept prompt picks up (its parent entry) →
	// its item: a prompt picking up at the same point was sent after a
	// rewind, and replaces it and all after it.
	prompts map[string]int
	idLine  int64
	lineSeq int
	// arts are the pages published, newest last; artCalls the publishes
	// still waiting for their result (artifacts.go).
	arts     []Artifact
	artCalls map[string]artCall
	// askCalls are the questions still waiting for their answer, by call
	// → absolute index of their item (questions.go).
	askCalls map[string]int
}

// id names an item by where its line starts, and its place among the
// items that line made: the same wherever reading began, so a window read
// afresh (after a restart, or once let go) and a page of older items name
// an item as the live chat did.
func (c *conv) id() string {
	if c.idLine != c.lineOff || c.lineSeq == 0 {
		c.idLine, c.lineSeq = c.lineOff, 0
	}
	c.lineSeq++
	return c.source[:2] + "@" + itoa(int(c.lineOff)) + "." + itoa(c.lineSeq)
}

// gens numbers readings, from when berthd started, so a reading after a
// restart never takes an earlier one's name.
var gens atomic.Int64

func init() { gens.Store(time.Now().UnixNano() / 1e6 * 1000) }

func (c *conv) generation() string { return itoa(int(c.gen)) + "." + itoa(c.rev) }

func (c *conv) add(it Item) int {
	// A new item closes the tool group before it.
	if n := len(c.items); n > 0 && c.items[n-1].Kind == "tools" {
		c.items[n-1].Done = true
		c.items[n-1].pending = nil
	}
	it.Off = c.lineOff
	n := keep
	if c.limit > 0 {
		n = c.limit
	}
	// The window slides along a backing array with room for n more: the
	// oldest item drops off by reslicing, and only when the array is full
	// do the kept items move to a fresh one. Copying the whole window for
	// every item past n made opening a long conversation quadratic.
	if len(c.items) == cap(c.items) && len(c.items) >= n {
		c.items = append(make([]Item, 0, 2*n), c.items...)
	}
	c.items = append(c.items, it)
	if over := len(c.items) - n; over > 0 {
		clear(c.items[:over]) // let what they hold go
		c.items = c.items[over:]
		c.base += over
	}
	return c.base + len(c.items) - 1
}

// at returns the item at an absolute index, if it is still kept.
func (c *conv) at(i int) *Item {
	if i < c.base || i >= c.base+len(c.items) {
		return nil
	}
	return &c.items[i-c.base]
}

// call adds a tool call to the open group of the same verb, or starts one.
func (c *conv) call(toolID string, tc ToolCall) {
	tc.ID = toolID
	if tc.At == 0 {
		tc.At = c.lineAt
	}
	if n := len(c.items); n > 0 {
		last := &c.items[n-1]
		// The last group takes more calls of its kind, even once its earlier
		// ones have finished.
		if last.Kind == "tools" && last.Verb == tc.Verb && last.pending != nil {
			last.Done = false
			last.Items = append(last.Items, tc)
			if toolID != "" {
				last.pending[toolID] = true
				c.byTool[toolID] = c.base + n - 1
			}
			return
		}
	}
	it := Item{Kind: "tools", ID: c.id(), Verb: tc.Verb, Items: []ToolCall{tc}, pending: map[string]bool{}}
	if toolID != "" {
		it.pending[toolID] = true
	}
	i := c.add(it)
	if toolID != "" {
		c.byTool[toolID] = i
	}
}

// launched marks a helper as running in the background: its tool call
// answers at once, and it is back only when its notification says so.
func (c *conv) launched(toolID string) {
	if c.background == nil {
		c.background = map[string]bool{}
	}
	c.background[toolID] = true
}

// back marks a helper finished.
func (c *conv) back(toolID string, at int64) {
	if i, ok := c.crewByID[toolID]; ok && c.crew[i].State != "finished" {
		c.crew[i].State = "finished"
		c.crew[i].Until = at
	}
	delete(c.background, toolID)
}

// result marks a tool call finished; a group is done when all its calls are.
func (c *conv) result(toolID string, at int64) {
	if !c.background[toolID] {
		c.back(toolID, at)
	}
	i, ok := c.byTool[toolID]
	if !ok {
		return
	}
	delete(c.byTool, toolID)
	if it := c.at(i); it != nil && it.pending != nil {
		delete(it.pending, toolID)
		if len(it.pending) == 0 {
			it.Done = true
		}
	}
}

func (c *conv) helper(m CrewMember) {
	if _, ok := c.crewByID[m.ID]; ok {
		return
	}
	c.crewByID[m.ID] = len(c.crew)
	c.crew = append(c.crew, m)
	// Only the latest helpers matter.
	if len(c.crew) > 20 {
		c.crew = c.crew[len(c.crew)-20:]
		c.crewByID = map[string]int{}
		for i, h := range c.crew {
			c.crewByID[h.ID] = i
		}
	}
}

// read follows the file from where it left off.
func (c *conv) read(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.Size() < c.offset { // replaced or truncated: start again
		*c = conv{source: c.source, dir: c.dir, p: c.p, side: c.side, byTool: map[string]int{}, crewByID: map[string]int{}, gen: gens.Add(1)}
	}
	if c.offset == 0 && st.Size() > maxStart {
		c.offset = st.Size() - maxStart
		c.truncated = true
	}
	if _, err := f.Seek(c.offset, io.SeekStart); err != nil {
		return err
	}
	r := bufio.NewReaderSize(f, 64<<10)
	skipFirst := c.truncated && c.offset > 0 && len(c.items) == 0 && c.partial == nil
	for {
		if len(c.partial) == 0 {
			c.lineOff = c.offset
		}
		chunk, err := r.ReadSlice('\n')
		c.offset += int64(len(chunk))
		if len(c.partial)+len(chunk) <= maxLine {
			c.partial = append(c.partial, chunk...)
		} else {
			c.partial = c.partial[:0]
			c.partial = append(c.partial, '!') // too long: dropped at its newline
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil { // EOF: keep the incomplete line for next time
			if err == io.EOF {
				return nil
			}
			return err
		}
		line := bytes.TrimSpace(c.partial)
		c.partial = c.partial[:0]
		if skipFirst {
			skipFirst = false // the middle of a line
			continue
		}
		if len(line) > 0 && line[0] == '{' {
			c.p.line(c, line)
		}
	}
}

// Reader keeps the conversations being looked at.
type Reader struct {
	mu    sync.Mutex
	convs map[string]*conv
}

func NewReader() *Reader { return &Reader{convs: map[string]*conv{}} }

// Read returns the conversation in path from index since.
func (r *Reader) Read(source, path, dir string, since int) (Result, error) {
	return r.Follow(source, path, dir, since, "")
}

// Follow returns the conversation in path from index since, counted in the
// reading gen names (Result.Gen): when that reading is gone, or since is
// before the items it still keeps, the answer is the whole window, Reset.
func (r *Reader) Follow(source, path, dir string, since int, gen string) (Result, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	for k, c := range r.convs {
		if now.Sub(c.used) > idle {
			delete(r.convs, k)
		}
	}
	c := r.convs[path]
	if c == nil {
		if len(r.convs) >= maxOpen {
			r.evictOldest()
		}
		c = &conv{source: source, dir: dir, side: isHelper(path), byTool: map[string]int{}, crewByID: map[string]int{}, gen: gens.Add(1)}
		switch source {
		case "codex":
			c.p = &codexParser{}
		default:
			c.p = &claudeParser{}
		}
		r.convs[path] = c
	}
	c.used = now
	if err := c.read(path); err != nil {
		return Result{}, err
	}
	reset := (gen != "" && gen != c.generation()) || (since > 0 && since < c.base)
	if reset {
		since = 0
	}
	from := max(since, c.base)
	// A tool group can change after it was sent (more calls, or done), so
	// the one just before `since` comes again, as does an open one at the
	// end; the app replaces items by ID.
	// A command's output is written after it, so it comes again too.
	if it := c.at(from - 1); it != nil && (it.Kind == "tools" || it.Kind == "command") {
		from--
	}
	if n := len(c.items); n > 0 && c.items[n-1].Kind == "tools" && !c.items[n-1].Done {
		from = min(from, c.base+n-1)
	}
	from = min(from, c.base+len(c.items))
	out := Result{Source: source, Next: c.base + len(c.items), Truncated: c.truncated || c.base > 0, Last: c.lineAt,
		Gen: c.generation(), Reset: reset, Start: c.offset, File: strings.TrimSuffix(filepath.Base(path), ".jsonl")}
	if len(c.items) > 0 {
		out.Start = c.items[0].Off
	}
	// A publish or a question settles after its item was sent: it comes
	// again, as a tool group does.
	out.Items = append(c.artifactsSince(from, since), c.items[from-c.base:]...)
	out.Artifacts = c.artifacts()
	out.Crew = append([]CrewMember{}, c.crew...)
	out.Signals = c.sig.snapshot()
	return out, nil
}

func (r *Reader) evictOldest() {
	var oldest string
	var at time.Time
	for k, c := range r.convs {
		if oldest == "" || c.used.Before(at) {
			oldest, at = k, c.used
		}
	}
	delete(r.convs, oldest)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
