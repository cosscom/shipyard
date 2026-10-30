package box

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/wire"
)

// Reporting back: when an agent starts work through berth (a task, a
// prompt, a run, a detached command) it names itself as the caller, and the
// box remembers it as a watch on that work. When the work ends, stops for a
// person, or reaches a gate, the box types a short <berth-notification>
// into the caller's session the next time it is idle, the way Claude Code
// tells an agent a background task is done. So an agent can end its turn
// instead of polling, and still hear back.
//
// The watches, the reports not yet delivered and what was already said
// live in one private file, so a restart loses none of them. Reports are
// read off the turn ledger and the runs engine, never off a live event, so
// one missed while berthd was down is still made. The one exception is
// the answer to a secret request (secretrequests.go), which is said with
// Tell when the request ends, and kept in the same file until it is.

// CallerHeader names the agent session that asks for work, from its
// BERTH_SESSION: the box reports back to it. Only callers on the box's own
// socket may name one, and only an agent session is reported to.
const CallerHeader = "X-Berth-Caller"

// Watch is one piece of work a session asked to hear back about.
type Watch struct {
	// ID is what is watched: "turn:<id>", "task:<session>" or "run:<id>".
	ID     string `json:"id"`
	Kind   string `json:"kind"` // turn, task or run
	Parent string `json:"parent"`
	// Session is the child session (turn and task); Turn the turn reported
	// on, once there is one. A task's first turn is the first numbered
	// above After.
	Session string    `json:"session,omitempty"`
	Turn    string    `json:"turn,omitempty"`
	After   int       `json:"after,omitempty"`
	Run     string    `json:"run,omitempty"`
	Created time.Time `json:"created"`
	// Rearmed counts the turns that ended while the child still waited on
	// work of its own: it reports when that is back and its next turn ends.
	Rearmed int `json:"rearmed,omitempty"`
}

// Report is one thing to tell a parent.
type Report struct {
	// Key says what it is about, so it is said once: "turn:<id>:end",
	// "turn:<id>:wait2", "run:<id>:gate:<step>".
	Key    string    `json:"key"`
	Parent string    `json:"parent"`
	Kind   string    `json:"kind"` // task, turn or run
	At     time.Time `json:"at"`
	// Status is finished, failed, exited, lost or waiting for a session;
	// a run's own status (succeeded, failed, cancelled, interrupted) or
	// waiting_gate.
	Status   string        `json:"status"`
	Session  string        `json:"session,omitempty"`
	Turn     string        `json:"turn,omitempty"`
	Run      string        `json:"run,omitempty"`
	Template string        `json:"template,omitempty"`
	Title    string        `json:"title,omitempty"`
	Duration time.Duration `json:"duration,omitempty"`
	// Where it ran: location/worktree, branch, the worktree's folder and the
	// repository's main checkout.
	Worktree string `json:"worktree,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Path     string `json:"path,omitempty"`
	Repo     string `json:"repo,omitempty"`
	Base     string `json:"base,omitempty"`
	Ahead    int    `json:"ahead,omitempty"`
	// Files changed, committed on the branch and not; Uncommitted counts
	// the latter.
	Files       []ReviewFile `json:"files,omitempty"`
	Added       int          `json:"added,omitempty"`
	Removed     int          `json:"removed,omitempty"`
	Uncommitted int          `json:"uncommitted,omitempty"`
	// Answer is the child's last words, trimmed; Needs what it waits for.
	Answer     string `json:"answer,omitempty"`
	Needs      string `json:"needs,omitempty"`
	Error      string `json:"error,omitempty"`
	Transcript string `json:"transcript,omitempty"`
	// Ref is a saved secret's reference (kind secret).
	Ref string `json:"ref,omitempty"`
}

// Limits. A parent hears at most once every MinGap and PerHour times an
// hour; what comes in between waits and goes as one message.
const (
	notifySettle      = 1500 * time.Millisecond // an agent's record catches up with its end
	notifyCoalesce    = 2 * time.Second         // reports this close together go as one
	notifyMinGap      = 15 * time.Second
	notifyPerHour     = 30
	maxPendingReports = 20
	maxWatchesPer     = 64
	maxWatches        = 1000
	watchTTL          = 7 * 24 * time.Hour
	maxRearm          = 20
	maxDoneKeys       = 1000
)

// ErrReportCycle refuses a watch that would have work report to itself.
var ErrReportCycle = errors.New("that session already reports to this one: reporting back would go round in a circle")

// notifyHost is what the notifier reads and does; the box is the real one.
type notifyHost interface {
	turn(id string) (Turn, bool)
	turns(session string) []Turn
	state(session string) (SessionState, bool)
	sessions(ctx context.Context) (map[string]liveSession, error)
	ready(session string) bool
	run(id string) (runs.Run, bool)
	// describe fills in where the work ran and what it changed and said.
	describe(ctx context.Context, r *Report)
	deliver(ctx context.Context, parent, text string) error
}

type liveSession struct {
	Agent  bool
	Exited bool
}

// Notifier keeps the watches and reports back.
type Notifier struct {
	// Path keeps its state across restarts.
	Path string
	// Now is its clock; nil is time.Now.
	Now func() time.Time

	mu     sync.Mutex
	st     notifyState
	loaded bool
	dirty  bool
	kick   chan struct{}
	host   notifyHost
}

type notifyState struct {
	Version int      `json:"version"`
	Watches []*Watch `json:"watches,omitempty"`
	// Pending are the reports not yet delivered, by parent.
	Pending map[string][]Report `json:"pending,omitempty"`
	// Dropped counts reports let go when a parent held too many.
	Dropped map[string]int `json:"dropped,omitempty"`
	// Sent are the times of the last hour's deliveries, by parent.
	Sent map[string][]time.Time `json:"sent,omitempty"`
	// Lineage is which session a task's session reports to, for cycles and
	// for the app.
	Lineage map[string]string `json:"lineage,omitempty"`
	// Done are the keys already reported, newest last.
	Done []string `json:"done,omitempty"`
	// Failures counts failed deliveries in a row, by parent.
	Failures map[string]int `json:"failures,omitempty"`
}

func (n *Notifier) now() time.Time {
	if n.Now != nil {
		return n.Now().UTC()
	}
	return time.Now().UTC()
}

// load reads the state once; the caller holds n.mu.
func (n *Notifier) load() {
	if n.loaded {
		return
	}
	n.loaded = true
	if n.kick == nil {
		n.kick = make(chan struct{}, 1)
	}
	if n.Path != "" {
		if b, err := os.ReadFile(n.Path); err == nil {
			json.Unmarshal(b, &n.st)
		}
	}
	if n.st.Pending == nil {
		n.st.Pending = map[string][]Report{}
	}
	if n.st.Dropped == nil {
		n.st.Dropped = map[string]int{}
	}
	if n.st.Sent == nil {
		n.st.Sent = map[string][]time.Time{}
	}
	if n.st.Lineage == nil {
		n.st.Lineage = map[string]string{}
	}
	if n.st.Failures == nil {
		n.st.Failures = map[string]int{}
	}
}

// save writes the state if it changed; the caller holds n.mu.
func (n *Notifier) save() {
	if !n.dirty || n.Path == "" {
		n.dirty = false
		return
	}
	n.dirty = false
	n.st.Version = 1
	if b, err := json.Marshal(n.st); err == nil {
		statefile.Write(n.Path, b)
	}
}

// Kick asks for a look at the watches soon.
func (n *Notifier) Kick() {
	n.mu.Lock()
	n.load()
	k := n.kick
	n.mu.Unlock()
	select {
	case k <- struct{}{}:
	default:
	}
}

// Tell queues a report that is not read off a watch (a secret request's
// answer), to be said once at the parent's next idle.
func (n *Notifier) Tell(r Report) {
	n.mu.Lock()
	n.load()
	if r.Key != "" && r.Parent != "" && !n.done(r.Key) && !n.pendingKey(r.Key) {
		n.st.Pending[r.Parent] = append(n.st.Pending[r.Parent], r)
		n.dirty = true
		n.save()
	}
	n.mu.Unlock()
	n.Kick()
}

// Add records a watch. One already kept (the same work for the same
// parent) is kept as it is. A watch that would make a cycle is refused.
func (n *Notifier) Add(w Watch) error {
	if w.Parent == "" {
		return errors.New("a watch needs a parent")
	}
	switch w.Kind {
	case "turn":
		w.ID = "turn:" + w.Turn
	case "task":
		w.ID = "task:" + w.Session
	case "run":
		w.ID = "run:" + w.Run
	default:
		return fmt.Errorf("unknown watch kind %q", w.Kind)
	}
	if w.Session != "" && w.Session == w.Parent {
		return ErrReportCycle
	}
	if w.Created.IsZero() {
		w.Created = n.now()
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.load()
	per := 0
	for _, x := range n.st.Watches {
		if x.ID == w.ID && x.Parent == w.Parent {
			return nil
		}
		if x.Parent == w.Parent {
			per++
		}
	}
	if w.Session != "" && n.reportsTo(w.Parent, w.Session) {
		return ErrReportCycle
	}
	if per >= maxWatchesPer || len(n.st.Watches) >= maxWatches {
		return httpError{http.StatusTooManyRequests, "too many watches for this session: it hears back about at most " + fmt.Sprint(maxWatchesPer) + " pieces of work at once"}
	}
	n.st.Watches = append(n.st.Watches, &w)
	if w.Kind == "task" {
		n.st.Lineage[w.Session] = w.Parent
	}
	n.dirty = true
	n.save()
	return nil
}

// reportsTo says whether from reports, directly or through others, to to;
// the caller holds n.mu.
func (n *Notifier) reportsTo(from, to string) bool {
	seen := map[string]bool{}
	next := []string{from}
	for len(next) > 0 {
		s := next[0]
		next = next[1:]
		if s == to {
			return true
		}
		if seen[s] {
			continue
		}
		seen[s] = true
		if p, ok := n.st.Lineage[s]; ok {
			next = append(next, p)
		}
		for _, w := range n.st.Watches {
			if w.Session == s {
				next = append(next, w.Parent)
			}
		}
	}
	return false
}

// Forget drops the watches on a turn, run or session for parent (any
// parent when empty), and the reports about it not yet delivered: the
// parent saw it end itself (berth_wait_turn).
func (n *Notifier) Forget(parent, id string) int {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.load()
	dropped := 0
	keep := n.st.Watches[:0]
	for _, w := range n.st.Watches {
		if (parent == "" || w.Parent == parent) && (w.Turn == id || w.Run == id || (w.Kind == "task" && w.Session == id)) {
			dropped++
			continue
		}
		keep = append(keep, w)
	}
	n.st.Watches = keep
	for p, reps := range n.st.Pending {
		if parent != "" && p != parent {
			continue
		}
		left := reps[:0]
		for _, r := range reps {
			if r.Turn == id || r.Run == id || (r.Kind == "task" && r.Session == id && r.Turn == "") || r.Key == "secret:"+id {
				n.markDone(r.Key)
				continue
			}
			left = append(left, r)
		}
		if len(left) == 0 {
			delete(n.st.Pending, p)
		} else {
			n.st.Pending[p] = left
		}
	}
	n.dirty = true
	n.save()
	return dropped
}

// Watches lists the watches, for the API.
func (n *Notifier) Watches() []Watch {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.load()
	out := make([]Watch, 0, len(n.st.Watches))
	for _, w := range n.st.Watches {
		out = append(out, *w)
	}
	return out
}

func (n *Notifier) done(key string) bool {
	for i := len(n.st.Done) - 1; i >= 0; i-- {
		if n.st.Done[i] == key {
			return true
		}
	}
	return false
}

func (n *Notifier) markDone(key string) {
	if n.done(key) {
		return
	}
	n.st.Done = append(n.st.Done, key)
	if len(n.st.Done) > maxDoneKeys {
		n.st.Done = n.st.Done[len(n.st.Done)-maxDoneKeys:]
	}
}

func (n *Notifier) pendingKey(key string) bool {
	for _, reps := range n.st.Pending {
		for _, r := range reps {
			if r.Key == key {
				return true
			}
		}
	}
	return false
}

// Run looks at the watches whenever an agent, a session or a run changes,
// and every few seconds, until ctx ends.
func (n *Notifier) Run(ctx context.Context, b *Box) {
	n.run(ctx, &boxNotifyHost{b}, b.Events)
}

func (n *Notifier) run(ctx context.Context, h notifyHost, bus *events.Bus) {
	n.mu.Lock()
	n.load()
	n.host = h
	kick := n.kick
	n.mu.Unlock()
	if bus != nil {
		stop := bus.Observe(func(e events.Event) {
			if strings.HasPrefix(e.Type, "agent.") || strings.HasPrefix(e.Type, "session.") || strings.HasPrefix(e.Type, "run.") || e.Type == "worktree.removed" {
				select {
				case kick <- struct{}{}:
				default:
				}
			}
		})
		defer stop()
	}
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		if next := n.Step(ctx); next > 0 {
			timer.Reset(next)
		}
		select {
		case <-ctx.Done():
			return
		case <-kick:
		case <-tick.C:
		case <-timer.C:
		}
	}
}

// found is what one look at a watch found.
type found struct {
	w       *Watch
	reports []Report
	drop    bool
	rearm   int // a turn's N to watch past
	turn    string
	later   bool
}

// Step looks at every watch once and delivers what is due. It returns how
// soon it wants to look again, 0 for no sooner than usual.
func (n *Notifier) Step(ctx context.Context) time.Duration {
	n.mu.Lock()
	n.load()
	h := n.host
	ws := make([]*Watch, len(n.st.Watches))
	copy(ws, n.st.Watches)
	idle := len(ws) == 0 && len(n.st.Pending) == 0 && len(n.st.Lineage) == 0
	n.mu.Unlock()
	if h == nil || idle {
		return 0
	}
	live, err := h.sessions(ctx)
	if err != nil {
		return 0
	}
	now := n.now()
	var soon time.Duration
	later := func(d time.Duration) {
		if d > 0 && (soon == 0 || d < soon) {
			soon = d
		}
	}
	// Which sessions still wait on work of their own: their ended turn is
	// not the end of what they were asked.
	n.mu.Lock()
	waitingOn := map[string]bool{}
	for _, w := range n.st.Watches {
		waitingOn[w.Parent] = true
	}
	for p := range n.st.Pending {
		waitingOn[p] = true
	}
	n.mu.Unlock()

	var results []found
	for _, w := range ws {
		var f found
		if w.Kind == "run" {
			f = checkRun(h, w)
		} else {
			f = checkSession(h, w, live, waitingOn, now)
		}
		if f.later {
			later(notifySettle)
		}
		if now.Sub(w.Created) > watchTTL && len(f.reports) == 0 {
			f.drop = true
		}
		f.w = w
		results = append(results, f)
	}
	// What a report says is read now, outside the lock: git and the
	// agent's record.
	for i := range results {
		for j := range results[i].reports {
			r := &results[i].reports[j]
			n.mu.Lock()
			skip := n.done(r.Key) || n.pendingKey(r.Key)
			n.mu.Unlock()
			if skip {
				r.Key = ""
				continue
			}
			h.describe(ctx, r)
		}
	}
	n.mu.Lock()
	for _, f := range results {
		for _, r := range f.reports {
			if r.Key == "" || n.done(r.Key) || n.pendingKey(r.Key) {
				continue
			}
			reps := append(n.st.Pending[r.Parent], r)
			if len(reps) > maxPendingReports {
				n.st.Dropped[r.Parent] += len(reps) - maxPendingReports
				for _, old := range reps[:len(reps)-maxPendingReports] {
					n.markDone(old.Key)
				}
				reps = reps[len(reps)-maxPendingReports:]
			}
			n.st.Pending[r.Parent] = reps
			n.dirty = true
		}
		switch {
		case f.drop:
			n.removeWatch(f.w)
		case f.rearm > 0:
			if w := n.findWatch(f.w); w != nil {
				w.Turn, w.After, w.Rearmed = "", f.rearm, w.Rearmed+1
				n.dirty = true
			}
		case f.turn != "" && f.w.Turn == "":
			if w := n.findWatch(f.w); w != nil {
				w.Turn = f.turn
				n.dirty = true
			}
		}
	}
	// Lineage of sessions that are gone is let go.
	for child := range n.st.Lineage {
		if _, ok := live[child]; !ok {
			delete(n.st.Lineage, child)
			n.dirty = true
		}
	}
	parents := make([]string, 0, len(n.st.Pending))
	for p := range n.st.Pending {
		parents = append(parents, p)
	}
	n.save()
	n.mu.Unlock()

	sort.Strings(parents)
	for _, p := range parents {
		later(n.deliver(ctx, h, p, live, now))
	}
	n.mu.Lock()
	n.save()
	n.mu.Unlock()
	return soon
}

func (n *Notifier) findWatch(w *Watch) *Watch {
	for _, x := range n.st.Watches {
		if x == w {
			return x
		}
	}
	return nil
}

func (n *Notifier) removeWatch(w *Watch) {
	for i, x := range n.st.Watches {
		if x == w {
			n.st.Watches = append(n.st.Watches[:i], n.st.Watches[i+1:]...)
			n.dirty = true
			return
		}
	}
}

// dropParent forgets everything for a parent that is gone: it is never
// typed into again.
func (n *Notifier) dropParent(p string) {
	keep := n.st.Watches[:0]
	for _, w := range n.st.Watches {
		if w.Parent != p {
			keep = append(keep, w)
		}
	}
	n.st.Watches = keep
	for _, r := range n.st.Pending[p] {
		n.markDone(r.Key)
	}
	delete(n.st.Pending, p)
	delete(n.st.Dropped, p)
	delete(n.st.Sent, p)
	delete(n.st.Failures, p)
	for c, q := range n.st.Lineage {
		if q == p {
			delete(n.st.Lineage, c)
		}
	}
	n.dirty = true
}

// deliver types a parent's reports as one message, if it is idle and its
// limits allow. It returns how soon to try again (0: when it next changes).
func (n *Notifier) deliver(ctx context.Context, h notifyHost, p string, live map[string]liveSession, now time.Time) time.Duration {
	n.mu.Lock()
	reps := append([]Report(nil), n.st.Pending[p]...)
	if len(reps) == 0 {
		delete(n.st.Pending, p)
		n.mu.Unlock()
		return 0
	}
	if s, ok := live[p]; !ok || s.Exited || !s.Agent {
		n.dropParent(p)
		n.mu.Unlock()
		return 0
	}
	// Several close together go as one.
	newest := reps[0].At
	for _, r := range reps {
		if r.At.After(newest) {
			newest = r.At
		}
	}
	if wait := notifyCoalesce - now.Sub(newest); wait > 0 {
		n.mu.Unlock()
		return wait
	}
	// The rate limit: a gap after each, and so many an hour.
	sent := n.st.Sent[p][:0]
	for _, t := range n.st.Sent[p] {
		if now.Sub(t) < time.Hour {
			sent = append(sent, t)
		}
	}
	n.st.Sent[p] = sent
	if k := len(sent); k > 0 {
		if wait := notifyMinGap - now.Sub(sent[k-1]); wait > 0 {
			n.mu.Unlock()
			return wait
		}
		if k >= notifyPerHour {
			n.mu.Unlock()
			return time.Hour - now.Sub(sent[0])
		}
	}
	dropped := n.st.Dropped[p]
	n.mu.Unlock()
	if !h.ready(p) {
		return 0 // its turn ending kicks the next look
	}
	text := NotificationText(reps, dropped)
	err := h.deliver(ctx, p, text)
	n.mu.Lock()
	defer n.mu.Unlock()
	switch {
	case errors.Is(err, ErrSessionExited) || errors.Is(err, ErrUnknownSession):
		n.dropParent(p)
		return 0
	case err != nil:
		n.st.Failures[p]++
		n.dirty = true
		if n.st.Failures[p] >= 5 {
			n.dropParent(p)
			return 0
		}
		return 10 * time.Second
	}
	delivered := map[string]bool{}
	for _, r := range reps {
		n.markDone(r.Key)
		delivered[r.Key] = true
	}
	left := n.st.Pending[p][:0]
	for _, r := range n.st.Pending[p] {
		if !delivered[r.Key] {
			left = append(left, r)
		}
	}
	if len(left) == 0 {
		delete(n.st.Pending, p)
	} else {
		n.st.Pending[p] = left
	}
	delete(n.st.Dropped, p)
	delete(n.st.Failures, p)
	n.st.Sent[p] = append(n.st.Sent[p], now)
	n.dirty = true
	return 0
}

// checkRun looks at a run: a gate opened, or the run ended.
func checkRun(h notifyHost, w *Watch) found {
	r, ok := h.run(w.Run)
	if !ok {
		return found{drop: true}
	}
	base := Report{Parent: w.Parent, Kind: "run", Run: r.ID, Template: r.Template, Title: r.Title, Status: r.Status, Path: r.Path}
	switch {
	case runs.Terminal(r.Status):
		base.Key, base.At = "run:"+r.ID+":end", r.Finished
		if base.At.IsZero() {
			base.At = r.Updated
		}
		base.Duration = base.At.Sub(r.Created)
		return found{reports: []Report{base}, drop: true}
	case r.Status == runs.WaitingGate && r.Gate != nil:
		base.Key, base.At = "run:"+r.ID+":gate:"+r.Gate.Path, r.Updated
		return found{reports: []Report{base}}
	}
	return found{}
}

// checkSession looks at a session's turn: it ended, it waits for a person,
// or the session is gone.
func checkSession(h notifyHost, w *Watch, live map[string]liveSession, waitingOn map[string]bool, now time.Time) found {
	sess, alive := live[w.Session]
	if alive && sess.Exited {
		alive = false
	}
	var tr Turn
	ok := false
	if w.Turn != "" {
		tr, ok = h.turn(w.Turn)
	} else {
		for _, t := range h.turns(w.Session) {
			if t.N > w.After && t.State != "queued" {
				tr, ok = t, true
				break
			}
		}
	}
	base := Report{Parent: w.Parent, Kind: w.Kind, Session: w.Session}
	if !ok {
		if w.Turn != "" && alive {
			return found{drop: true} // a turn the ledger no longer has
		}
		if !alive {
			base.Key, base.Status, base.At = "session:"+w.Session+":gone", "exited", now
			return found{reports: []Report{base}, drop: true}
		}
		// No turn yet: an agent that cannot say a prompt started says
		// only that it finished or waits.
		st, known := h.state(w.Session)
		if !known || !st.Since.After(w.Created) {
			return found{}
		}
		switch st.State {
		case "waiting":
			base.Key, base.Status, base.At = fmt.Sprintf("session:%s:wait:%d", w.Session, st.Since.Unix()), "waiting", st.Since
			if st.Ask != nil {
				base.Needs = askText(*st.Ask)
			}
			return found{reports: []Report{base}}
		case "finished":
			if now.Sub(st.Since) < notifySettle {
				return found{later: true}
			}
			base.Key, base.Status, base.At = fmt.Sprintf("session:%s:end:%d", w.Session, st.Since.Unix()), "finished", st.Since
			return found{reports: []Report{base}, drop: true}
		}
		return found{}
	}
	base.Turn = tr.ID
	f := found{turn: tr.ID}
	start := firstTime(tr.Started, tr.Sent, tr.Queued)
	switch {
	case tr.ended():
		if now.Sub(tr.Ended) < notifySettle {
			f.later = true
			return f
		}
		if tr.State == "finished" && tr.Status != "error" && waitingOn[w.Session] && w.Rearmed < maxRearm && alive {
			// It ended its turn to wait for work it started: it reports
			// once that is back and it is done with it.
			f.rearm = tr.N
			return f
		}
		base.Key, base.At = "turn:"+tr.ID+":end", tr.Ended
		base.Status = tr.State
		if tr.Status == "error" {
			base.Status = "failed"
		}
		if tr.State == "lost" && tr.Status != "" {
			base.Error = tr.Status
		}
		if !start.IsZero() {
			base.Duration = tr.Ended.Sub(start)
		}
		f.reports, f.drop = []Report{base}, true
	case !alive:
		base.Key, base.Status, base.At = "turn:"+tr.ID+":end", "exited", now
		if !start.IsZero() {
			base.Duration = now.Sub(start)
		}
		f.reports, f.drop = []Report{base}, true
	case tr.State == "waiting":
		k := len(tr.Waits)
		base.Key, base.Status, base.At = fmt.Sprintf("turn:%s:wait%d", tr.ID, k), "waiting", now
		if k > 0 {
			base.At = tr.Waits[k-1].Start
			if a := tr.Waits[k-1].Ask; a != nil {
				base.Needs = askText(*a)
			} else if why := tr.Waits[k-1].Reason; why != "" {
				base.Needs = why
			}
		}
		if !start.IsZero() {
			base.Duration = now.Sub(start)
		}
		f.reports = []Report{base}
	}
	return f
}

func firstTime(ts ...time.Time) time.Time {
	for _, t := range ts {
		if !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}

func askText(a Ask) string {
	var parts []string
	if a.Tool != "" {
		s := "permission to use " + a.Tool
		if a.Input != "" {
			s += ": " + a.Input
		}
		parts = append(parts, s)
	}
	if a.Why != "" {
		parts = append(parts, "why: "+a.Why)
	}
	if a.Message != "" {
		parts = append(parts, a.Message)
	}
	return strings.Join(parts, " · ")
}

// watchCaller records a watch for the session that made a request, when it
// named itself (CallerHeader) on the box's own socket and runs an agent.
func (b *Box) watchCaller(r *http.Request, w Watch) {
	caller := strings.TrimSpace(r.Header.Get(CallerHeader))
	if caller == "" || b.Reports == nil || !wire.IsLocal(r.Context()) || !sessionName.MatchString(caller) {
		return
	}
	sess, err := b.Sessions.Get(r.Context(), caller)
	if err != nil || sess.Exited || agentFor(sess) == "" {
		return
	}
	w.Parent = caller
	if w.Kind == "task" && b.Turns != nil {
		if ts := b.Turns.List(w.Session, 1); len(ts) > 0 {
			w.After = ts[len(ts)-1].N
		}
	}
	if err := b.Reports.Add(w); err == nil {
		b.Reports.Kick()
	}
}

// The notify API: GET /v1/notify lists the watches; DELETE
// /v1/notify/{id} drops the caller's watch on a turn, run or session, and
// what was about to be said about it.
func (b *Box) mountNotify(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("GET /v1/notify", b.listWatches)
	route("GET /v1/notify/caller", b.callerOfPid)
	route("DELETE /v1/notify/{id}", b.forgetWatch)
}

// callerOfPid answers GET /v1/notify/caller?pid=N: the berth session whose
// pane runs that process, or one of its ancestors. An MCP server whose agent
// didn't pass BERTH_SESSION on (Codex starts its MCP servers with a bare
// environment) asks it with its parent's pid, so it still names its caller.
func (b *Box) callerOfPid(w http.ResponseWriter, r *http.Request) error {
	if !wire.IsLocal(r.Context()) {
		return httpError{http.StatusForbidden, "only programs on the box itself ask which session they run in"}
	}
	pid, err := strconv.Atoi(r.URL.Query().Get("pid"))
	if err != nil || pid <= 1 {
		return badRequest("pid must be a process ID")
	}
	writeJSON(w, map[string]string{"session": b.sessionOfPid(r.Context(), pid)})
	return nil
}

// sessionOfPid walks up from pid to a pane's own process.
func (b *Box) sessionOfPid(ctx context.Context, pid int) string {
	out, err := b.Sessions.tmux(ctx, "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}")
	if err != nil {
		return ""
	}
	panes := map[int]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, p, ok := strings.Cut(line, "\t")
		if n, err := strconv.Atoi(strings.TrimSpace(p)); ok && err == nil {
			panes[n] = name
		}
	}
	ps, err := exec.CommandContext(ctx, "ps", "-A", "-o", "pid=,ppid=").Output()
	if err != nil {
		return ""
	}
	parent := map[int]int{}
	for _, line := range strings.Split(string(ps), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		c, _ := strconv.Atoi(f[0])
		p, _ := strconv.Atoi(f[1])
		parent[c] = p
	}
	for i := 0; i < 32 && pid > 1; i++ {
		if name, ok := panes[pid]; ok {
			return name
		}
		pid = parent[pid]
	}
	return ""
}

func (b *Box) listWatches(w http.ResponseWriter, r *http.Request) error {
	if b.Reports == nil {
		writeJSON(w, []Watch{})
		return nil
	}
	writeJSON(w, b.Reports.Watches())
	return nil
}

func (b *Box) forgetWatch(w http.ResponseWriter, r *http.Request) error {
	if b.Reports == nil {
		writeJSON(w, map[string]int{"forgot": 0})
		return nil
	}
	if !wire.IsLocal(r.Context()) {
		return httpError{http.StatusForbidden, "only agents on the box itself drop their watches"}
	}
	caller := strings.TrimSpace(r.Header.Get(CallerHeader))
	if caller == "" {
		return badRequest("name the session the watch reports to (%s)", CallerHeader)
	}
	writeJSON(w, map[string]int{"forgot": b.Reports.Forget(caller, r.PathValue("id"))})
	return nil
}
