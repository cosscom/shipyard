package box

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/statefile"
)

// The turn ledger: what every agent session is doing, turn by turn, kept
// from the box's events in Seq order. A turn is one prompt to the end of
// the agent's reply. Waits, loops, flows, the guard, Review and the phone
// all read it, so none of them depends on clocks, on which directory an
// agent runs in, or on catching an event live.

// Turn is one prompt-to-end-of-turn of one agent session.
type Turn struct {
	ID      string `json:"id"` // "<session>#<n>"
	Session string `json:"session"`
	Agent   string `json:"agent,omitempty"`
	N       int    `json:"n"`
	// Origin says who prompted: laptop:<peer>, flow:<id>, phone, terminal.
	Origin string `json:"origin,omitempty"`
	// SentSeq is the journal Seq of the send (0 if typed by a person),
	// Sent its time.
	SentSeq int64     `json:"sent_seq,omitempty"`
	Sent    time.Time `json:"sent,omitzero"`
	EndSeq  int64     `json:"end_seq,omitempty"`
	// State is queued (held in the inbox), pending (sent, not started),
	// running, waiting, finished, exited or lost.
	State   string    `json:"state"`
	Queued  time.Time `json:"queued,omitzero"`
	Started time.Time `json:"started,omitzero"`
	Ended   time.Time `json:"ended,omitzero"`
	// Waits are the spans it spent waiting for a person.
	Waits []Span `json:"waits,omitempty"`
	// Fidelity is how well berth knows its edges: hooks (the agent said),
	// partial (it started when sent, as the agent cannot say) or screen.
	Fidelity string `json:"fidelity,omitempty"`
	IdemKey  string `json:"idem_key,omitempty"`
	// Status is "error" for a turn the agent ended on a failure.
	Status string `json:"status,omitempty"`
}

// Span is a time the agent waited for someone.
type Span struct {
	Start  time.Time `json:"start"`
	End    time.Time `json:"end,omitzero"`
	Reason string    `json:"reason,omitempty"`
	// Ask is what the agent asked for, from its own hooks, when it said.
	Ask *Ask `json:"ask,omitempty"`
}

// Ask is a waiting agent's request, from its hooks rather than its screen:
// the tool it wants to use, a short summary of the input (the command, or
// the file's path; never what it would write), its reason, and the
// message it showed. Each is at most adapters.AskLimit long. It is kept
// only here, in the ledger's private file: never in events.
type Ask struct {
	Tool    string `json:"tool,omitempty"`
	Input   string `json:"input,omitempty"`
	Why     string `json:"why,omitempty"`
	Message string `json:"message,omitempty"`
}

// SessionState is what an agent session is doing now.
type SessionState struct {
	Session  string    `json:"session"`
	Agent    string    `json:"agent,omitempty"`
	State    string    `json:"state"`
	Since    time.Time `json:"since,omitzero"`
	Turn     string    `json:"turn,omitempty"`
	Seq      int64     `json:"seq,omitempty"`
	Fidelity string    `json:"fidelity,omitempty"`
	// AgentSessionID is the agent's own conversation ID, from its hooks.
	AgentSessionID string `json:"agent_session_id,omitempty"`
	// Queued is how many prompts the inbox holds for it; Ask what it asks
	// for while it waits, when its hooks said.
	Queued int  `json:"queued,omitempty"`
	Ask    *Ask `json:"ask,omitempty"`
}

func (t Turn) open() bool {
	return t.State == "pending" || t.State == "running" || t.State == "waiting"
}

func (t Turn) ended() bool {
	return t.State == "finished" || t.State == "exited" || t.State == "lost"
}

// Bounds: memory never grows with how long the box runs.
const (
	maxTurnsKept   = 50  // per session in memory; older ones only in the archive
	maxInbox       = 16  // prompts held per session
	maxDirStates   = 256 // agents berth did not start, by directory
	maxGoneTurns   = 64  // last turns of sessions that ended
	maxArchiveSize = 4 << 20
	inboxTextLimit = 64 << 10
)

// Turns is the ledger. It follows the bus synchronously (Attach), so it
// never misses an event, and writes itself at most every 100 ms.
type Turns struct {
	// Path keeps the ledger across restarts; LegacyPath is the old per-
	// directory agent-states.json, imported once and still written for one
	// release so a downgrade keeps its states. InboxPath holds prompts
	// waiting for an idle agent (they are never put in events);
	// ArchivePath the turns that no longer fit in memory.
	Path, LegacyPath, InboxPath, ArchivePath string

	mu      sync.Mutex
	sess    map[string]*sessTrack
	dirs    map[string]dirState
	gone    []Turn
	changed chan struct{}
	dirty   bool
	inboxD  bool
	archive []Turn
	applied int64
	// Ambiguous counts cwd-only events that matched more than one session.
	Ambiguous atomic.Uint64
	kick      chan struct{}
	saveSoon  chan struct{}
	loaded    bool
	stop      func()

	// writeMu orders the ledger's writes; legacyOut is what LegacyPath
	// was last written with.
	writeMu   sync.Mutex
	legacyOut []byte
}

type sessTrack struct {
	Name     string    `json:"name"`
	Agent    string    `json:"agent,omitempty"`
	Dir      string    `json:"dir,omitempty"`
	State    string    `json:"state,omitempty"`
	Since    time.Time `json:"since,omitzero"`
	Seq      int64     `json:"seq,omitempty"`
	Fidelity string    `json:"fidelity,omitempty"`
	N        int       `json:"n"`
	// AgentSessionID is the agent's own conversation ID.
	AgentSessionID string  `json:"agent_session_id,omitempty"`
	Turns          []*Turn `json:"turns,omitempty"`
	// Hooked is set once the agent's own hooks reported here; SawStart once
	// they said a prompt started, so its sends can wait for that.
	Hooked   bool `json:"hooked,omitempty"`
	SawStart bool `json:"saw_start,omitempty"`
	// Prompted is set once the ledger has seen a prompt for the session,
	// sent or typed: the first one may name it (see Box.nameAfter).
	Prompted bool `json:"prompted,omitempty"`
	// Reconcile marks a turn left open across a restart, for the screen to
	// settle if no hook does.
	Reconcile bool `json:"reconcile,omitempty"`

	inbox []inboxItem
	// screen polling, owned by the poller
	lastScreen string
	sameFor    int
}

type inboxItem struct {
	Session string    `json:"session"`
	Turn    string    `json:"turn"`
	Text    string    `json:"text"`
	Enter   bool      `json:"enter"`
	Origin  string    `json:"origin,omitempty"`
	At      time.Time `json:"at"`
}

type dirState struct {
	State string    `json:"state"`
	At    time.Time `json:"at"`
}

type savedTurns struct {
	Version  int                   `json:"version"`
	Applied  int64                 `json:"applied"`
	Sessions map[string]*sessTrack `json:"sessions"`
	Dirs     map[string]dirState   `json:"dirs,omitempty"`
}

func (t *Turns) init() {
	if t.sess == nil {
		t.sess = map[string]*sessTrack{}
		t.dirs = map[string]dirState{}
		t.changed = make(chan struct{})
		t.kick = make(chan struct{}, 1)
		t.saveSoon = make(chan struct{}, 1)
	}
}

// markDirty says the ledger has changes to write, and wakes Run to write
// them (within 100ms, with whatever else changes meanwhile); the caller
// holds t.mu.
func (t *Turns) markDirty() {
	t.dirty = true
	select {
	case t.saveSoon <- struct{}{}:
	default:
	}
}

// Attach loads the ledger, catches up on what the journal holds past it,
// and follows the bus from then on, synchronously.
func (t *Turns) Attach(bus *events.Bus) {
	t.mu.Lock()
	t.init()
	t.load()
	if head := bus.Head(); head < t.applied {
		// The journal started over (it was removed): its Seqs are new.
		t.applied = head
	}
	applied := t.applied
	t.mu.Unlock()
	if bus.Journal != nil && applied > 0 && applied < bus.Journal.Head() {
		it := bus.Journal.Iter(applied, 0)
		for {
			e, ok := it.Next()
			if !ok {
				break
			}
			t.Observe(e)
		}
		it.Close()
	}
	t.mu.Lock()
	// Turns open now were open when berthd stopped: if no spooled hook
	// settles them, the screen does.
	for _, s := range t.sess {
		if tr := s.current(); tr != nil && tr.open() {
			s.Reconcile = true
		}
	}
	t.mu.Unlock()
	t.stop = bus.Observe(t.Observe)
}

// load reads turns.json, or imports agent-states.json once; the caller
// holds t.mu.
func (t *Turns) load() {
	if t.loaded {
		return
	}
	t.loaded = true
	if t.Path != "" {
		if b, err := os.ReadFile(t.Path); err == nil {
			var saved savedTurns
			if json.Unmarshal(b, &saved) == nil {
				t.applied = saved.Applied
				for name, s := range saved.Sessions {
					if s == nil {
						continue
					}
					s.Name = name
					t.sess[name] = s
				}
				for d, st := range saved.Dirs {
					t.dirs[d] = st
				}
			}
			t.loadInbox()
			return
		}
	}
	if t.LegacyPath == "" {
		return
	}
	b, err := os.ReadFile(t.LegacyPath)
	if err != nil {
		return
	}
	var legacy map[string]dirState
	if json.Unmarshal(b, &legacy) != nil {
		return
	}
	// Synthetic signals: a session in one of these directories starts
	// from its state, until its own hooks say more.
	for path, st := range legacy {
		if time.Since(st.At) < agentStateTTL && (st.State == "finished" || st.State == "idle" || st.State == "waiting") {
			t.dirs[filepath.Clean(path)] = st
		}
	}
	t.trimDirs()
	t.markDirty()
}

func (t *Turns) loadInbox() {
	if t.InboxPath == "" {
		return
	}
	b, err := os.ReadFile(t.InboxPath)
	if err != nil {
		return
	}
	var items []inboxItem
	if json.Unmarshal(b, &items) != nil {
		return
	}
	for _, it := range items {
		if s := t.sess[it.Session]; s != nil && len(s.inbox) < maxInbox {
			s.inbox = append(s.inbox, it)
		}
	}
}

// agentStateTTL is how long a directory's state is kept for an agent that
// never reports again; its worktree is most likely gone.
const agentStateTTL = 14 * 24 * time.Hour

func (t *Turns) trimDirs() {
	for len(t.dirs) > maxDirStates {
		var oldest string
		var at time.Time
		for d, st := range t.dirs {
			if oldest == "" || st.At.Before(at) {
				oldest, at = d, st.At
			}
		}
		delete(t.dirs, oldest)
	}
}

// bump wakes waiters; the caller holds t.mu.
func (t *Turns) bump() {
	t.markDirty()
	close(t.changed)
	t.changed = make(chan struct{})
}

func (s *sessTrack) current() *Turn {
	for i := len(s.Turns) - 1; i >= 0; i-- {
		if st := s.Turns[i].State; st == "running" || st == "waiting" {
			return s.Turns[i]
		}
	}
	return nil
}

func (s *sessTrack) oldest(state string) *Turn {
	for _, tr := range s.Turns {
		if tr.State == state {
			return tr
		}
	}
	return nil
}

func (s *sessTrack) find(id string) *Turn {
	for _, tr := range s.Turns {
		if tr.ID == id {
			return tr
		}
	}
	return nil
}

// newTurn adds a turn, moving the oldest ended one to the archive past
// maxTurnsKept; the caller holds t.mu.
func (t *Turns) newTurn(s *sessTrack, state, origin string) *Turn {
	s.N++
	tr := &Turn{ID: s.Name + "#" + strconv.Itoa(s.N), Session: s.Name, Agent: s.Agent, N: s.N, Origin: origin, State: state}
	s.Turns = append(s.Turns, tr)
	for len(s.Turns) > maxTurnsKept {
		i := 0
		for i < len(s.Turns)-1 && !s.Turns[i].ended() {
			i++
		}
		t.archive = append(t.archive, *s.Turns[i])
		s.Turns = append(s.Turns[:i], s.Turns[i+1:]...)
	}
	return tr
}

func (s *sessTrack) set(state string, e events.Event) {
	s.State, s.Since, s.Seq = state, e.Time, e.Seq
}

func (s *sessTrack) end(tr *Turn, state string, e events.Event) {
	tr.State, tr.Ended, tr.EndSeq = state, e.Time, e.Seq
	if n := len(tr.Waits); n > 0 && tr.Waits[n-1].End.IsZero() {
		tr.Waits[n-1].End = e.Time
	}
}

func str(d map[string]any, k string) string {
	s, _ := d[k].(string)
	return s
}

// Observe applies one event. It runs inside Publish, so it only touches
// memory.
func (t *Turns) Observe(e events.Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	if e.Seq != 0 {
		if e.Seq <= t.applied {
			return
		}
		t.applied = e.Seq
	}
	switch e.Type {
	case "session.started":
		name := str(e.Data, "name")
		if name == "" {
			return
		}
		s := t.track(name, str(e.Data, "agent"), str(e.Data, "path"), e.Time)
		if s.Agent == "" {
			s.Agent = agentOf(str(e.Data, "command"))
		}
		t.bump()
	case "session.stopped":
		t.drop(str(e.Data, "name"), e)
	case "session.sent":
		t.sent(e)
	case adapters.Ready, adapters.Started, adapters.Waiting, adapters.Finished, adapters.Exited:
		t.agentEvent(e)
	}
}

// track finds or starts a session's record. born, when known, is when the
// session began: a folder's state from before then is another agent's.
func (t *Turns) track(name, agent, dir string, born time.Time) *sessTrack {
	s := t.sess[name]
	if s == nil {
		s = &sessTrack{Name: name}
		// A name used again numbers on, so its turn IDs stay unique.
		for _, g := range t.gone {
			if g.Session == name && g.N > s.N {
				s.N = g.N
			}
		}
		t.sess[name] = s
	}
	if agent != "" && s.Agent == "" {
		s.Agent = agent
	}
	if dir != "" && s.Dir == "" {
		s.Dir = filepath.Clean(dir)
		if s.State == "" {
			for _, d := range []string{s.Dir, strings.TrimPrefix(s.Dir, "/private"), "/private" + s.Dir} {
				if st, ok := t.dirs[d]; ok && (born.IsZero() || !st.At.Before(born)) {
					s.State, s.Since = st.State, st.At
					break
				}
			}
		}
	}
	return s
}

// drop forgets a session that ended, keeping its last turn for waiters.
func (t *Turns) drop(name string, e events.Event) {
	s := t.sess[name]
	if s == nil {
		return
	}
	for _, tr := range s.Turns {
		if tr.open() || tr.State == "queued" {
			s.end(tr, "exited", e)
		}
	}
	if n := len(s.Turns); n > 0 {
		t.gone = append(t.gone, *s.Turns[n-1])
		if len(t.gone) > maxGoneTurns {
			t.gone = t.gone[len(t.gone)-maxGoneTurns:]
		}
	}
	t.archive = append(t.archive, derefAll(s.Turns)...)
	if len(s.inbox) > 0 {
		t.inboxD = true
	}
	delete(t.sess, name)
	t.bump()
}

func derefAll(ts []*Turn) []Turn {
	out := make([]Turn, 0, len(ts))
	for _, tr := range ts {
		out = append(out, *tr)
	}
	return out
}

// startsAtSend says whether a send starts a turn at once: for agents that
// cannot say when a prompt starts, or have not yet said so here.
func startsAtSend(s *sessTrack) bool {
	caps := adapters.CapsFor(s.Agent)
	if !caps.Started || !s.Hooked {
		return true
	}
	return s.Agent != "claude" && !s.SawStart
}

func (t *Turns) sent(e events.Event) {
	name := str(e.Data, "name")
	s := t.sess[name]
	if s == nil {
		if name == "" {
			return
		}
		s = t.track(name, str(e.Data, "agent"), "", time.Time{})
	}
	if e.Data["answer"] == true {
		// An answer to the question the agent waits on: its turn goes on.
		t.bump()
		return
	}
	if c, _ := e.Data["command"].(string); c != "" {
		// The agent's own command (/cost, /model) starts no turn: its hooks
		// never say it started, so a pending one would take the next
		// prompt's start. One held in the inbox ends as it is typed.
		if tr := s.find(str(e.Data, "turn")); tr != nil && tr.State == "queued" {
			tr.SentSeq, tr.Sent, tr.Started = e.Seq, e.Time, e.Time
			s.end(tr, "finished", e)
		}
		t.bump()
		return
	}
	var tr *Turn
	if id := str(e.Data, "turn"); id != "" {
		tr = s.find(id) // a queued prompt, delivered now
	}
	if tr == nil {
		origin := str(e.Data, "from")
		if origin == "" {
			origin = e.Origin
		}
		tr = t.newTurn(s, "pending", origin)
		tr.IdemKey = str(e.Data, "idem_key")
	}
	tr.SentSeq, tr.Sent = e.Seq, e.Time
	if startsAtSend(s) {
		// The send is the only start this agent gives: anything still
		// running ended unseen.
		if cur := s.current(); cur != nil && cur != tr {
			s.end(cur, "finished", e)
		}
		tr.State, tr.Started = "running", e.Time
		tr.Fidelity = "partial"
		if !s.Hooked || !adapters.CapsFor(s.Agent).Finished {
			tr.Fidelity = "screen"
		}
		s.set("running", e)
		s.Fidelity = tr.Fidelity
	} else {
		tr.State = "pending"
	}
	t.bump()
}

// resolve finds the session an agent event is about: the one it names, or
// the single live agent session in its directory (of its agent, when the
// directory has several). ok is false when it cannot tell.
func (t *Turns) resolve(e events.Event) (s *sessTrack, ambiguous bool) {
	if name := str(e.Data, "session"); name != "" {
		return t.track(name, str(e.Data, "agent"), str(e.Data, "path"), time.Time{}), false
	}
	path := str(e.Data, "path")
	if path == "" {
		return nil, false
	}
	path = filepath.Clean(path)
	var match []*sessTrack
	for _, s := range t.sess {
		if s.Agent != "" && s.State != "exited" && sameDir(s.Dir, path) {
			match = append(match, s)
		}
	}
	if len(match) > 1 {
		agent := str(e.Data, "agent")
		var same []*sessTrack
		for _, s := range match {
			if s.Agent == agent {
				same = append(same, s)
			}
		}
		match = same
		if len(match) != 1 {
			return nil, true
		}
	}
	if len(match) == 1 {
		return match[0], false
	}
	return nil, false
}

func sameDir(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return a == b || strings.TrimPrefix(a, "/private") == strings.TrimPrefix(b, "/private")
}

var stateOf = map[string]string{adapters.Ready: "idle", adapters.Started: "running", adapters.Waiting: "waiting", adapters.Finished: "finished", adapters.Exited: "exited"}

func (t *Turns) agentEvent(e events.Event) {
	s, ambiguous := t.resolve(e)
	if s == nil {
		if ambiguous {
			// Recorded in the journal, but it ends no one's wait.
			t.Ambiguous.Add(1)
			return
		}
		if path := str(e.Data, "path"); path != "" {
			t.dirs[filepath.Clean(path)] = dirState{stateOf[e.Type], e.Time}
			t.trimDirs()
			t.bump()
		}
		return
	}
	source := str(e.Data, "source")
	if source == "" {
		s.Hooked = true
	}
	if id := str(e.Data, "agent_session_id"); id != "" {
		s.AgentSessionID = id
	}
	if s.Agent == "" {
		s.Agent = str(e.Data, "agent")
	}
	cur := s.current()
	switch e.Type {
	case adapters.Ready:
		if cur == nil {
			s.set("idle", e)
		}
	case adapters.Started:
		signal := str(e.Data, "signal")
		switch {
		case source == "send":
			// Said by berth for an agent that cannot: the turn exists.
		case signal == "tool":
			// Working again, after an approval: the wait is over.
			if cur != nil && cur.State == "waiting" {
				cur.State = "running"
				if n := len(cur.Waits); n > 0 && cur.Waits[n-1].End.IsZero() {
					cur.Waits[n-1].End = e.Time
				}
			}
		default:
			if source == "" {
				s.SawStart = true
			}
			pending := s.oldest("pending")
			switch {
			case pending != nil:
				// The oldest prompt sent starts now. A turn still open
				// ended without saying so.
				if cur != nil {
					s.end(cur, "finished", e)
				}
				pending.State, pending.Started, pending.Fidelity = "running", e.Time, "hooks"
				if source == "screen" {
					pending.Fidelity = "screen"
				}
			case cur == nil:
				// Typed by a person at the terminal.
				tr := t.newTurn(s, "running", "terminal")
				tr.Started, tr.Fidelity = e.Time, "hooks"
				if source == "screen" {
					tr.Fidelity = "screen"
				}
			case cur.State == "waiting":
				cur.State = "running"
				if n := len(cur.Waits); n > 0 && cur.Waits[n-1].End.IsZero() {
					cur.Waits[n-1].End = e.Time
				}
			}
		}
		s.set("running", e)
	case adapters.Waiting:
		if cur != nil {
			if cur.State != "waiting" {
				cur.Waits = append(cur.Waits, Span{Start: e.Time, Reason: str(e.Data, "reason")})
				if len(cur.Waits) > 20 {
					cur.Waits = cur.Waits[len(cur.Waits)-20:]
				}
			}
			cur.State = "waiting"
		}
		s.set("waiting", e)
	case adapters.Finished:
		if cur != nil {
			if source == "screen" || source == "reconcile" {
				cur.Fidelity = "screen" // its end was read off the screen
			}
			s.end(cur, "finished", e)
			cur.Status = str(e.Data, "status")
			if cur.Status != "error" {
				cur.Status = ""
			}
		}
		s.Reconcile = false
		s.set("finished", e)
		t.kickInbox()
	case adapters.Exited:
		for _, tr := range s.Turns {
			if tr.open() {
				s.end(tr, "exited", e)
			}
		}
		s.Reconcile = false
		s.set("exited", e)
	}
	if tr := s.current(); tr != nil {
		s.Fidelity = tr.Fidelity
	}
	if s.State == "idle" {
		t.kickInbox()
	}
	t.bump()
}

// FirstPrompt says whether this is the first prompt the ledger has seen for
// the session, and remembers that it has seen one. Only whether: the text
// never comes here.
func (t *Turns) FirstPrompt(name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s := t.sess[name]
	if s == nil || s.Prompted {
		return false
	}
	s.Prompted = true
	return true
}

// SessionOf names the session an agent event's data is about, as the
// ledger resolved it, or "" when it cannot tell.
func (t *Turns) SessionOf(data map[string]any) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	if name := str(data, "session"); name != "" {
		if _, ok := t.sess[name]; ok {
			return name
		}
		return ""
	}
	path := str(data, "path")
	if path == "" {
		return ""
	}
	var found string
	for _, s := range t.sess {
		if s.Agent != "" && s.State != "exited" && sameDir(s.Dir, filepath.Clean(path)) {
			if found != "" {
				return ""
			}
			found = s.Name
		}
	}
	return found
}

func (t *Turns) kickInbox() {
	select {
	case t.kick <- struct{}{}:
	default:
	}
}

// Redundant says whether an agent event would change nothing: a tool use
// while the agent is already working. Those are frequent, so the box does
// not publish them.
func (t *Turns) Redundant(typ string, data map[string]any) bool {
	if typ != adapters.Started || str(data, "signal") != "tool" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	name := str(data, "session")
	s := t.sess[name]
	if s == nil {
		return false
	}
	return s.State == "running"
}

// Track makes sure a live session is in the ledger and returns its state.
func (t *Turns) Track(sess Session) SessionState {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s := t.track(sess.Name, sess.Agent, sess.Dir, sess.Created)
	if s.Agent == "" {
		s.Agent = sess.Agent
	}
	return s.snapshot()
}

func (s *sessTrack) snapshot() SessionState {
	out := SessionState{Session: s.Name, Agent: s.Agent, State: s.State, Since: s.Since, Seq: s.Seq, Fidelity: s.Fidelity, AgentSessionID: s.AgentSessionID, Queued: len(s.inbox)}
	if tr := s.current(); tr != nil {
		out.Turn = tr.ID
		if n := len(tr.Waits); tr.State == "waiting" && n > 0 && tr.Waits[n-1].End.IsZero() && tr.Waits[n-1].Ask != nil {
			ask := *tr.Waits[n-1].Ask
			out.Ask = &ask
		}
	} else if p := s.oldest("pending"); p != nil {
		out.Turn = p.ID
	} else if n := len(s.Turns); n > 0 {
		out.Turn = s.Turns[n-1].ID
	}
	return out
}

// State is a session's state, if the ledger knows it.
func (t *Turns) State(name string) (SessionState, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s := t.sess[name]
	if s == nil {
		return SessionState{}, false
	}
	return s.snapshot(), true
}

// DirState is the last state reported from a directory, for agents berth
// did not start (Stats): the session's own when one agent session runs
// there.
func (t *Turns) DirState(path string) (state string, at time.Time, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	path = filepath.Clean(path)
	var match *sessTrack
	for _, s := range t.sess {
		if sameDir(s.Dir, path) && s.State != "" {
			if match != nil {
				match = nil
				break
			}
			match = s
		}
	}
	if match != nil {
		return match.State, match.Since, true
	}
	st, ok := t.dirs[path]
	return st.State, st.At, ok
}

// Exited records that a session's program has ended.
func (t *Turns) Exited(name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s := t.sess[name]
	if s == nil || s.State == "exited" {
		return
	}
	e := events.Event{Time: time.Now().UTC(), Seq: t.applied}
	for _, tr := range s.Turns {
		if tr.open() {
			s.end(tr, "exited", e)
		}
	}
	s.State, s.Since = "exited", e.Time
	t.bump()
}

// Prune forgets sessions that no longer exist.
func (t *Turns) Prune(live []Session) {
	names := make(map[string]bool, len(live))
	for _, s := range live {
		names[s.Name] = true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	for name := range t.sess {
		if !names[name] {
			t.drop(name, events.Event{Time: time.Now().UTC(), Seq: t.applied})
		}
	}
}

// Get returns a turn by ID.
func (t *Turns) Get(id string) (Turn, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.getLocked(id)
}

func (t *Turns) getLocked(id string) (Turn, bool) {
	t.init()
	name, _, _ := strings.Cut(id, "#")
	if s := t.sess[name]; s != nil {
		if tr := s.find(id); tr != nil {
			return *tr, true
		}
	}
	for i := len(t.gone) - 1; i >= 0; i-- {
		if t.gone[i].ID == id {
			return t.gone[i], true
		}
	}
	return Turn{}, false
}

// ForSent is the turn a send with this Seq made.
func (t *Turns) ForSent(name string, seq int64) (Turn, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	if s := t.sess[name]; s != nil {
		for i := len(s.Turns) - 1; i >= 0; i-- {
			if s.Turns[i].SentSeq == seq {
				return *s.Turns[i], true
			}
		}
	}
	return Turn{}, false
}

// ByIdem finds a turn a caller already asked for with the same key, so a
// resumed caller never sends the same prompt twice.
func (t *Turns) ByIdem(name, key string) (Turn, bool) {
	if key == "" {
		return Turn{}, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	if s := t.sess[name]; s != nil {
		for _, tr := range s.Turns {
			if tr.IdemKey == key {
				return *tr, true
			}
		}
	}
	return Turn{}, false
}

// List returns a session's turns, oldest first: the ones in memory, then
// older ones from the archive when more are asked for.
func (t *Turns) List(name string, limit int) []Turn {
	if limit <= 0 {
		limit = 20
	}
	t.mu.Lock()
	t.init()
	var mem []Turn
	if s := t.sess[name]; s != nil {
		mem = derefAll(s.Turns)
	}
	t.mu.Unlock()
	if len(mem) >= limit {
		return mem[len(mem)-limit:]
	}
	older := t.readArchive(name, limit-len(mem), mem)
	return append(older, mem...)
}

// readArchive streams the archive for a session's last n turns not in
// skip, holding at most n.
func (t *Turns) readArchive(name string, n int, skip []Turn) []Turn {
	if t.ArchivePath == "" || n <= 0 {
		return nil
	}
	have := map[string]bool{}
	for _, tr := range skip {
		have[tr.ID] = true
	}
	var ring []Turn
	for _, p := range []string{t.ArchivePath + ".1", t.ArchivePath} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
		prefix := []byte(`{"id":"` + name + `#`)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) < len(prefix) || string(line[:len(prefix)]) != string(prefix) {
				continue
			}
			var tr Turn
			if json.Unmarshal(line, &tr) != nil || have[tr.ID] {
				continue
			}
			ring = append(ring, tr)
			if len(ring) > n {
				ring = ring[1:]
			}
		}
		f.Close()
	}
	return ring
}

// ErrInboxFull is returned when a session already holds maxInbox prompts.
var ErrInboxFull = httpError{429, fmt.Sprintf("this session already holds %d prompts; wait for some to be sent", maxInbox)}

// Queue holds a prompt in the session's inbox until its agent is idle, and
// returns the queued turn.
func (t *Turns) Queue(name, text string, enter bool, origin, idem string) (Turn, error) {
	if len(text) > inboxTextLimit {
		return Turn{}, badRequest("a queued prompt holds at most %d KB", inboxTextLimit>>10)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s := t.sess[name]
	if s == nil {
		return Turn{}, ErrUnknownSession
	}
	if len(s.inbox) >= maxInbox {
		return Turn{}, ErrInboxFull
	}
	tr := t.newTurn(s, "queued", origin)
	tr.IdemKey, tr.Queued = idem, time.Now().UTC()
	s.inbox = append(s.inbox, inboxItem{Session: name, Turn: tr.ID, Text: text, Enter: enter, Origin: origin, At: tr.Queued})
	t.inboxD = true
	t.bump()
	if s.idle() {
		t.kickInbox()
	}
	return *tr, nil
}

// NoteAsk records what a waiting agent asks for on its turn's open wait.
// data is the agent event it came with, already applied, which names the
// session; an ask for an agent that no longer waits is dropped. A
// permission request replaces the ask; a notification's message only
// fills in what it lacks.
func (t *Turns) NoteAsk(data map[string]any, raw any) {
	m, _ := raw.(map[string]any)
	if len(m) == 0 {
		return
	}
	ask := Ask{Tool: askStr(m, "tool"), Input: askStr(m, "input"), Why: askStr(m, "why"), Message: askStr(m, "message")}
	if ask == (Ask{}) {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s, _ := t.resolve(events.Event{Data: data})
	if s == nil {
		return
	}
	cur := s.current()
	if cur == nil || cur.State != "waiting" {
		return
	}
	n := len(cur.Waits)
	if n == 0 || !cur.Waits[n-1].End.IsZero() {
		return
	}
	w := &cur.Waits[n-1]
	switch {
	case w.Ask == nil:
		w.Ask = &ask
	case ask.Tool != "":
		if ask.Message == "" {
			ask.Message = w.Ask.Message
		}
		w.Ask = &ask
	case w.Ask.Message == "":
		w.Ask.Message = ask.Message
	}
	t.bump()
}

// askStr reads one of an ask's strings, capped again: the API takes them
// from any local caller.
func askStr(m map[string]any, k string) string {
	s, _ := m[k].(string)
	if len(s) > adapters.AskLimit {
		cut := adapters.AskLimit
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut]
	}
	return s
}

// QueuedPrompt is one prompt the inbox holds, as the app shows it: the
// start of its text, never the whole of a long one.
type QueuedPrompt struct {
	Turn    string `json:"turn"`
	Preview string `json:"preview"`
	// Length is the whole prompt's, in characters.
	Length int       `json:"length"`
	Origin string    `json:"origin,omitempty"`
	At     time.Time `json:"at"`
}

// queuePreview is how much of a held prompt the queue shows.
const queuePreview = 280

// Queued lists the prompts held for a session, oldest first.
func (t *Turns) Queued(name string) []QueuedPrompt {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s := t.sess[name]
	if s == nil {
		return nil
	}
	out := make([]QueuedPrompt, 0, len(s.inbox))
	for _, it := range s.inbox {
		p := it.Text
		if len(p) > queuePreview {
			cut := queuePreview
			for cut > 0 && !utf8.RuneStart(p[cut]) {
				cut--
			}
			p = p[:cut] + "…"
		}
		out = append(out, QueuedPrompt{Turn: it.Turn, Preview: p, Length: utf8.RuneCountInString(it.Text), Origin: it.Origin, At: it.At})
	}
	return out
}

var errNotQueued = httpError{404, "that prompt is no longer queued: it was sent or cancelled"}

// takeQueued removes a held prompt from the inbox and returns it; its turn
// stays queued until it is typed (or cancelled).
func (t *Turns) takeQueued(name, turn string) (inboxItem, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s := t.sess[name]
	if s == nil {
		return inboxItem{}, ErrUnknownSession
	}
	for i, it := range s.inbox {
		if it.Turn == turn {
			s.inbox = append(s.inbox[:i:i], s.inbox[i+1:]...)
			t.inboxD = true
			t.bump()
			return it, nil
		}
	}
	return inboxItem{}, errNotQueued
}

// putBack returns a held prompt that could not be typed to the front of
// the inbox.
func (t *Turns) putBack(it inboxItem) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if s := t.sess[it.Session]; s != nil {
		s.inbox = append([]inboxItem{it}, s.inbox...)
		t.inboxD = true
		t.bump()
	}
}

// Cancel drops a held prompt: its turn ends lost, "cancelled".
func (t *Turns) Cancel(name, turn string) error {
	if _, err := t.takeQueued(name, turn); err != nil {
		return err
	}
	t.endQueued(name, turn, "cancelled")
	return nil
}

// Ready says whether a prompt can be typed into the session now: its agent
// is idle or finished (or has never said), and nothing is held before it.
func (t *Turns) Ready(name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	s := t.sess[name]
	if s == nil {
		return true
	}
	if len(s.inbox) > 0 {
		return false
	}
	// A held prompt being delivered right now is still queued: wait for it.
	for _, tr := range s.Turns {
		if tr.State == "queued" {
			return false
		}
	}
	return s.State == "" || s.idle()
}

// idle says whether the agent can take a prompt: idle or finished, with no
// turn open.
func (s *sessTrack) idle() bool {
	if s.State != "idle" && s.State != "finished" {
		return false
	}
	for _, tr := range s.Turns {
		if tr.open() {
			return false
		}
	}
	return true
}

// nextDeliveries takes the first held prompt of every idle session.
func (t *Turns) nextDeliveries() []inboxItem {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []inboxItem
	for _, s := range t.sess {
		if len(s.inbox) > 0 && s.idle() {
			out = append(out, s.inbox[0])
			s.inbox = s.inbox[1:]
			t.inboxD = true
			t.markDirty()
		}
	}
	return out
}

// failQueued ends a held turn that could not be typed.
func (t *Turns) failQueued(it inboxItem, why string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if s := t.sess[it.Session]; s != nil {
		if tr := s.find(it.Turn); tr != nil && tr.State == "queued" {
			tr.State, tr.Ended, tr.Status = "lost", time.Now().UTC(), why
			t.bump()
		}
	}
}

// Changed returns a channel closed at the ledger's next change.
func (t *Turns) Changed() <-chan struct{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	return t.changed
}

// WaitTurn blocks until the turn ends, or also until it waits for someone
// when untilWaiting, or ctx ends (timedOut).
func (t *Turns) WaitTurn(ctx context.Context, id string, untilWaiting bool) (tr Turn, timedOut bool, err error) {
	for {
		t.mu.Lock()
		t.init()
		tr, ok := t.getLocked(id)
		ch := t.changed
		t.mu.Unlock()
		if !ok {
			return Turn{}, false, errUnknownTurn
		}
		if tr.ended() || (untilWaiting && tr.State == "waiting") {
			return tr, false, nil
		}
		select {
		case <-ctx.Done():
			return tr, true, nil
		case <-ch:
		}
	}
}

var errUnknownTurn = httpError{404, "no turn with that ID"}

// openForScreen lists sessions whose open turn the screen must settle.
func (t *Turns) openForScreen() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []string
	for name, s := range t.sess {
		tr := s.current()
		if tr == nil {
			if p := s.oldest("pending"); p != nil && s.Reconcile {
				out = append(out, name)
			}
			continue
		}
		caps := adapters.CapsFor(s.Agent)
		if tr.Fidelity == "screen" || s.Reconcile || !caps.Waiting {
			out = append(out, name)
		}
	}
	return out
}

// screenSeen records a capture and says how many polls it has been the
// same.
func (t *Turns) screenSeen(name, screen string) (same int, state string, fidelity string, reconcile bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.sess[name]
	if s == nil {
		return 0, "", "", false
	}
	if screen == s.lastScreen {
		s.sameFor++
	} else {
		s.lastScreen, s.sameFor = screen, 0
	}
	fid := ""
	if tr := s.current(); tr != nil {
		fid = tr.Fidelity
	}
	return s.sameFor, s.State, fid, s.Reconcile
}

func (t *Turns) forgetScreen(name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if s := t.sess[name]; s != nil {
		s.lastScreen, s.sameFor = "", 0
	}
}

// save writes the ledger, the inbox, the legacy states and the archive.
func (t *Turns) save() {
	t.mu.Lock()
	if !t.dirty {
		t.mu.Unlock()
		return
	}
	t.dirty = false
	saved := savedTurns{Version: 1, Applied: t.applied, Sessions: t.sess, Dirs: t.dirs}
	b, err := json.Marshal(saved)
	legacy := map[string]dirState{}
	for d, st := range t.dirs {
		legacy[d] = st
	}
	for _, s := range t.sess {
		if s.Dir != "" && s.State != "" && s.State != "exited" {
			if cur, ok := legacy[s.Dir]; !ok || s.Since.After(cur.At) {
				legacy[s.Dir] = dirState{s.State, s.Since}
			}
		}
	}
	var inbox []byte
	if t.inboxD {
		var items []inboxItem
		for _, s := range t.sess {
			items = append(items, s.inbox...)
		}
		inbox, _ = json.Marshal(items)
		if items == nil {
			inbox = []byte("[]")
		}
		t.inboxD = false
	}
	archive := t.archive
	t.archive = nil
	t.mu.Unlock()
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if err == nil && t.Path != "" {
		statefile.Write(t.Path, b)
	}
	if t.LegacyPath != "" {
		// Its states change far less often than the ledger: each write
		// is a full fsync, so one that would write the same bytes is
		// left out.
		if lb, err := json.Marshal(legacy); err == nil && !bytes.Equal(lb, t.legacyOut) {
			if statefile.Write(t.LegacyPath, lb) == nil {
				t.legacyOut = lb
			}
		}
	}
	if inbox != nil && t.InboxPath != "" {
		statefile.Write(t.InboxPath, inbox)
	}
	if len(archive) > 0 && t.ArchivePath != "" {
		t.appendArchive(archive)
	}
}

func (t *Turns) appendArchive(turns []Turn) {
	if info, err := os.Stat(t.ArchivePath); err == nil && info.Size() > maxArchiveSize {
		os.Rename(t.ArchivePath, t.ArchivePath+".1")
	}
	f, err := os.OpenFile(t.ArchivePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, tr := range turns {
		if b, err := json.Marshal(tr); err == nil {
			w.Write(append(b, '\n'))
		}
	}
	w.Flush()
}

// Run writes the ledger at most every 100 ms, keeps it to the sessions
// that exist, types held prompts once their agent is idle, and reads the
// screens of sessions whose agent has no hooks, until ctx ends.
func (t *Turns) Run(ctx context.Context, b *Box) {
	t.mu.Lock()
	t.init()
	kick, saveSoon := t.kick, t.saveSoon
	t.mu.Unlock()
	// The ledger is written 100ms after it changes, with whatever else
	// changes meanwhile; nothing wakes for it while nothing changes (a
	// 100ms ticker woke an idle box ten times a second).
	var flush <-chan time.Time
	refresh := time.NewTicker(10 * time.Second)
	defer refresh.Stop()
	screen := time.NewTicker(2 * time.Second)
	defer screen.Stop()
	defer t.save()
	if b != nil {
		b.refreshTurns(ctx)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-saveSoon:
			if flush == nil {
				flush = time.After(100 * time.Millisecond)
			}
		case <-flush:
			flush = nil
			t.save()
		case <-refresh.C:
			if b != nil {
				b.refreshTurns(ctx)
			}
			t.kickInbox()
		case <-screen.C:
			if b != nil {
				b.pollScreens(ctx)
			}
		case <-kick:
			if b != nil {
				b.deliverInbox(ctx)
			}
		}
	}
}

// refreshTurns tells the ledger which sessions exist and which ended.
func (b *Box) refreshTurns(ctx context.Context) {
	if b.Sessions == nil || b.Turns == nil {
		return
	}
	all, err := b.Sessions.List(ctx)
	if err != nil {
		return
	}
	b.enrich(ctx, all)
	b.Turns.Prune(all)
	b.Turns.Expire(time.Now())
}

// PendingExpiry is how long a sent prompt may stay pending, its agent idle,
// before the ledger gives up on it.
const PendingExpiry = 2 * time.Minute

// Expire ends pending turns that never started: sent more than
// PendingExpiry ago to an agent that is idle or finished with nothing
// running (it read two pastes as one, or dropped the prompt). They end
// "lost", so a wait on one returns and the inbox moves on.
func (t *Turns) Expire(now time.Time) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.init()
	n := 0
	for _, s := range t.sess {
		if s.State != "idle" && s.State != "finished" {
			continue
		}
		if s.current() != nil {
			continue
		}
		for _, tr := range s.Turns {
			if tr.State != "pending" || tr.Sent.IsZero() || now.Sub(tr.Sent) < PendingExpiry {
				continue
			}
			tr.State, tr.Ended, tr.Status = "lost", now.UTC(), "never started"
			n++
		}
	}
	if n > 0 {
		t.bump()
	}
	return n
}

// deliverInbox types each idle session's next held prompt.
func (b *Box) deliverInbox(ctx context.Context) {
	for _, it := range b.Turns.nextDeliveries() {
		if b.startupHeld(ctx, it.Session) {
			// Still starting, or at its startup question: typed now, it
			// would be lost. The watch kicks the inbox once it is ready.
			b.Turns.putBack(it)
			continue
		}
		unlock := b.lockSend(it.Session)
		if err := b.Sessions.Send(ctx, it.Session, it.Text, it.Enter); err != nil {
			b.Turns.failQueued(it, err.Error())
			unlock()
			continue
		}
		data := map[string]any{"name": it.Session, "turn": it.Turn, "when": "idle"}
		if sess, err := b.Sessions.Get(ctx, it.Session); err == nil && it.Enter {
			if c, local := localCommand(sessionAgent(sess), it.Text); local {
				data["command"] = c
			}
		}
		b.Events.Publish(events.Event{Type: "session.sent", Box: b.Name, Origin: it.Origin, Data: data})
		unlock()
		if it.Enter && commandName(it.Text) == "" {
			b.nameAfter(ctx, it.Session, adapters.Title(it.Text))
		}
	}
}

// sendLocks serializes typing into one session, from the inbox and from
// sends: two prompts typed at once into an idle agent would be read as one,
// leaving a turn that never starts.
var sendLocks sync.Map // session name → *sync.Mutex

func (b *Box) lockSend(name string) func() {
	m, _ := sendLocks.LoadOrStore(name, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// screenQuiet is how many 2-second polls of an unchanged screen end a turn
// the agent cannot report.
const screenQuiet = 3

// pollScreens is the screen adapter: for open turns no hook will settle, it
// reads the pane and reports what it sees, as events like any adapter's.
func (b *Box) pollScreens(ctx context.Context) {
	names := b.Turns.openForScreen()
	if len(names) == 0 {
		return
	}
	all, err := b.Sessions.List(ctx)
	if err != nil {
		return
	}
	live := map[string]Session{}
	for _, s := range all {
		live[s.Name] = s
	}
	for _, name := range names {
		sess, ok := live[name]
		if !ok {
			continue // Prune ends it
		}
		if sess.Exited {
			b.Turns.Exited(name)
			continue
		}
		if b.startingState(name) == startAsking {
			// Its startup watch reads it: a question that sits still is
			// not a turn that ended.
			continue
		}
		// Found in the list just read: capture it without listing again.
		screen, err := b.Sessions.capture(ctx, name, 0)
		if err != nil {
			continue
		}
		same, state, fidelity, reconcile := b.Turns.screenSeen(name, screen)
		data := map[string]any{"session": name, "path": sess.Dir, "source": "screen"}
		publish := func(typ string) {
			b.Turns.forgetScreen(name)
			b.Events.Publish(events.Event{Type: typ, Box: b.Name, Origin: "screen", Data: data})
		}
		switch seen := adapters.ScreenState(screen); {
		case seen == "waiting" && state != "waiting":
			data["reason"] = "screen"
			publish(adapters.Waiting)
		case seen != "waiting" && state == "waiting" && same == 0 && fidelity == "screen":
			data["signal"] = "tool"
			publish(adapters.Started)
		case same >= screenQuiet && (fidelity == "screen" || reconcile):
			if reconcile {
				data["source"] = "reconcile"
			}
			publish(adapters.Finished)
		}
	}
}

// waitSessionState blocks until the session reports one of want with a Seq
// of at least afterSeq (or, when the journal cannot place after, a time
// after it), its program exits, or ctx ends.
func (t *Turns) waitSessionState(ctx context.Context, name string, want map[string]bool, afterSeq int64, after time.Time) (SessionState, bool, error) {
	var last SessionState
	for {
		ch := t.Changed()
		ss, ok := t.State(name)
		if ok {
			last = ss
			fresh := (afterSeq > 0 && ss.Seq >= afterSeq) || (afterSeq <= 0 && ss.Since.After(after))
			if ss.State == "exited" {
				return ss, false, nil
			}
			if want[ss.State] && fresh {
				return ss, false, nil
			}
		}
		select {
		case <-ctx.Done():
			return last, true, nil
		case <-ch:
		}
	}
}
