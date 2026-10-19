package runs

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Host does a run's leaf steps; the box implements it.
type Host interface {
	// Leaf does one leaf step: run, check, prompt, wait, start_agent,
	// headless, notify, webhook, collect, handoff, pr or cleanup.
	Leaf(ctx context.Context, x *StepCtx) Result
	// Reenter is asked about a leaf step the journal shows started but not
	// finished: berthd stopped in the middle of it. ok false runs it again;
	// a Result with Status "unknown" pauses the run for a person to say.
	Reenter(ctx context.Context, x *StepCtx) (Result, bool)
	// Before asks the box's before: gates whether an action may happen.
	Before(ctx context.Context, origin, typ string, data map[string]any) error
	// Publish puts an event on the box's bus.
	Publish(typ string, data map[string]any)
	// Done is told when a run stops running, to drop what it cached.
	Done(runID string)
}

// StepCtx is a leaf step as the host sees it.
type StepCtx struct {
	Run        Summary
	Step       Step
	Path       string
	Attempt    int
	IdemKey    string
	Vars       map[string]string
	Candidates []Candidate
}

// Result is what a leaf step did.
type Result struct {
	Status    string // succeeded, failed, skipped, unknown, cancelled
	Code      int
	Out       string
	Err       string
	Feedback  string
	Set       map[string]string
	Usage     *Usage
	Candidate *Candidate
}

func (r Result) ok() bool { return r.Status == Succeeded || r.Status == Skipped }

// Request starts a run.
type Request struct {
	Template string
	Title    string
	Flow     []Step
	Params   map[string]any
	Vars     map[string]string
	Scope    string
	FlowID   string
	Trigger  map[string]any
	IdemKey  string
	// Key admits one run at a time per key: a flow and a worktree.
	Key    string
	Group  string
	Parent string
	Budget *Budget
	Origin string
	Path   string
	Test   bool
	// QueueLimit bounds the runs waiting behind an active one with the
	// same Key (default 5). Coalesce merges Item into the run already
	// waiting instead of queueing another.
	QueueLimit int
	Coalesce   bool
	Item       map[string]any
}

// Admission errors.
var (
	ErrQueueFull = errors.New("too many runs already wait for this one to finish")
	ErrNotFound  = errors.New("no run with that id")
	ErrNoGate    = errors.New("that run is not waiting at a gate")
	ErrDone      = errors.New("that run has finished")
)

// Engine executes runs.
type Engine struct {
	// Dir holds the journals and index.json.
	Dir  string
	Host Host
	// MaxRuns runs at once (default 10); more wait queued. MaxAgents
	// agents started by runs work at once (default 6).
	MaxRuns   int
	MaxAgents int
	Now       func() time.Time
	Log       func(format string, args ...any)
	// Items renders coalesced trigger items for a prompt.
	Items func([]map[string]any) string

	mu       sync.Mutex
	ix       *index
	idem     map[string]string
	active   map[string]*execution
	agents   chan struct{}
	base     context.Context
	stopping bool
	wg       sync.WaitGroup
	opened   bool
}

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *Engine) logf(format string, args ...any) {
	if e.Log != nil {
		e.Log(format, args...)
	}
}

// Open loads the index. Resume starts executing.
func (e *Engine) Open() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.opened {
		return nil
	}
	if err := os.MkdirAll(e.Dir, 0o700); err != nil {
		return err
	}
	if e.MaxRuns <= 0 {
		e.MaxRuns = 10
	}
	if e.MaxAgents <= 0 {
		e.MaxAgents = 6
	}
	e.agents = make(chan struct{}, e.MaxAgents)
	e.ix = loadIndex(filepath.Join(e.Dir, "index.json"))
	e.idem = map[string]string{}
	for _, s := range e.ix.runs {
		if s.IdemKey != "" {
			e.idem[s.IdemKey] = s.ID
		}
	}
	e.active = map[string]*execution{}
	e.opened = true
	return nil
}

// Resume continues every run that was going when berthd stopped, and
// starts queued ones as slots allow. ctx ends them all (without marking
// them finished: they resume next time).
func (e *Engine) Resume(ctx context.Context) {
	if err := e.Open(); err != nil {
		e.logf("runs: %v", err)
		return
	}
	e.mu.Lock()
	e.base = ctx
	var resume []Summary
	for _, s := range e.ix.list(Filter{Status: "active", Limit: maxIndex}) {
		if s.Status != Queued {
			resume = append(resume, s)
		}
	}
	// Oldest first.
	sort.Slice(resume, func(i, j int) bool { return resume[i].Created.Before(resume[j].Created) })
	for _, s := range resume {
		if err := e.launchLocked(s.ID); err != nil {
			e.logf("runs: could not resume %s: %v", s.ID, err)
		}
	}
	e.scheduleLocked()
	e.mu.Unlock()
	if len(resume) > 0 {
		e.logf("runs: resumed %d runs", len(resume))
	}
	go e.compactLoop(ctx)
	go func() {
		<-ctx.Done()
		e.mu.Lock()
		e.stopping = true
		for _, x := range e.active {
			x.cancel()
		}
		e.mu.Unlock()
	}()
}

// Wait waits for every run's goroutines to return after Resume's context
// ends.
func (e *Engine) Wait() { e.wg.Wait() }

func (e *Engine) compactLoop(ctx context.Context) {
	e.compact()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.compact()
		}
	}
}

func (e *Engine) compact() {
	for _, id := range e.ix.compact(e.now()) {
		os.Remove(journalPath(e.Dir, id))
		e.mu.Lock()
		for k, v := range e.idem {
			if v == id {
				delete(e.idem, k)
			}
		}
		e.mu.Unlock()
	}
}

const idChars = "0123456789abcdefghijklmnopqrstuvwxyz"

// NewID makes a run ID: r_ then the time and four random characters.
func NewID() string {
	b := make([]byte, 4)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(idChars))))
		b[i] = idChars[n.Int64()]
	}
	return "r_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + string(b)
}

// Start admits a run: it starts now, waits queued for a slot or for the
// run with the same Key, or merges into the run already queued for it.
// dup is true when IdemKey named a run that exists, which is returned.
func (e *Engine) Start(req Request) (s Summary, dup bool, err error) {
	if err := e.Open(); err != nil {
		return Summary{}, false, err
	}
	steps, title, budget := req.Flow, req.Title, req.Budget
	params := req.Params
	if len(steps) == 0 {
		t, err := Expand(req.Template, req.Params)
		if err != nil {
			return Summary{}, false, err
		}
		steps, params = t.Steps, t.Params
		if title == "" {
			title = t.Title
		}
		if budget == nil {
			budget = t.Budget
		}
	}
	if err := ValidateSteps(steps); err != nil {
		return Summary{}, false, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if req.IdemKey != "" {
		if id, ok := e.idem[req.IdemKey]; ok {
			if s, ok := e.ix.get(id); ok {
				return s, true, nil
			}
		}
	}
	queued := false
	if req.Key != "" {
		var waiting []Summary
		busy := false
		for _, s := range e.ix.list(Filter{Status: "active", Key: req.Key, Limit: maxIndex}) {
			if s.Status == Queued {
				waiting = append(waiting, s)
			} else {
				busy = true
			}
		}
		if busy || len(waiting) > 0 {
			if req.Coalesce && len(waiting) > 0 && req.Item != nil {
				// The newest waiting run takes the item.
				q := waiting[0]
				if err := e.coalesceLocked(q.ID, req.Item, req.IdemKey); err != nil {
					return Summary{}, false, err
				}
				s, _ := e.ix.get(q.ID)
				return s, false, nil
			}
			limit := req.QueueLimit
			if limit == 0 {
				limit = 5
			}
			if limit < 0 || len(waiting) >= limit {
				return Summary{}, false, ErrQueueFull
			}
			queued = true
		}
	}
	if e.runningLocked() >= e.MaxRuns {
		queued = true
	}
	now := e.now().UTC()
	vars := map[string]string{}
	for k, v := range req.Vars {
		vars[k] = v
	}
	for k, v := range Flatten(params) {
		vars["params."+k] = v
	}
	if params == nil {
		params = map[string]any{}
	}
	if req.Item != nil {
		params["items"] = []map[string]any{req.Item}
	}
	run := &Run{ID: NewID(), Template: req.Template, Title: title, Flow: steps, Params: params, Scope: req.Scope, FlowID: req.FlowID,
		Trigger: req.Trigger, IdemKey: req.IdemKey, Key: req.Key, Group: req.Group, Parent: req.Parent, Status: Running, Vars: vars,
		Steps: []StepRun{}, Budget: budget, Origin: req.Origin, Path: req.Path, Test: req.Test, Created: now, Updated: now}
	if run.Template == "" {
		run.Template = "flow"
	}
	if queued {
		run.Status = Queued
	}
	j, err := openJournal(journalPath(e.Dir, run.ID))
	if err != nil {
		return Summary{}, false, err
	}
	err = j.append(Record{T: recCreated, At: now, Run: run}, true)
	j.close()
	if err != nil {
		return Summary{}, false, err
	}
	if run.IdemKey != "" {
		e.idem[run.IdemKey] = run.ID
	}
	e.ix.put(run.summary())
	e.publish("run.created", run.summary(), nil)
	if !queued {
		if err := e.launchLocked(run.ID); err != nil {
			return Summary{}, false, err
		}
	} else {
		e.publish("run.queued", run.summary(), nil)
	}
	s, _ = e.ix.get(run.ID)
	return s, false, nil
}

func (e *Engine) coalesceLocked(id string, item map[string]any, idem string) error {
	j, err := openJournal(journalPath(e.Dir, id))
	if err != nil {
		return err
	}
	defer j.close()
	if err := j.append(Record{T: recCoalesced, At: e.now().UTC(), Item: item}, true); err != nil {
		return err
	}
	if idem != "" {
		e.idem[idem] = id
	}
	return nil
}

func (e *Engine) runningLocked() int {
	return len(e.active)
}

// scheduleLocked starts queued runs while there are slots, oldest first,
// never two with the same key.
func (e *Engine) scheduleLocked() {
	if e.stopping || e.base == nil {
		return
	}
	queued := e.ix.list(Filter{Status: Queued, Limit: maxIndex})
	sort.Slice(queued, func(i, j int) bool { return queued[i].Created.Before(queued[j].Created) })
	for _, s := range queued {
		if e.runningLocked() >= e.MaxRuns {
			return
		}
		if s.Key != "" && e.keyBusyLocked(s.Key) {
			continue
		}
		if err := e.launchLocked(s.ID); err != nil {
			e.logf("runs: could not start %s: %v", s.ID, err)
		}
	}
}

func (e *Engine) keyBusyLocked(key string) bool {
	for _, x := range e.active {
		if x.run.Key == key {
			return true
		}
	}
	return false
}

// launchLocked replays a run's journal and starts its goroutine.
func (e *Engine) launchLocked(id string) error {
	if e.base == nil {
		return nil // Resume starts it
	}
	if _, ok := e.active[id]; ok {
		return nil
	}
	x, err := e.replay(id)
	if err != nil {
		return err
	}
	if Terminal(x.run.Status) {
		x.j.close()
		return nil
	}
	// Before anyone can ask for another rerun of the judge.
	x.endStaleEvaluations()
	ctx, cancel := context.WithCancel(e.base)
	x.ctx, x.cancel = ctx, cancel
	e.active[id] = x
	e.wg.Add(1)
	go x.main()
	return nil
}

// Get returns a run with its steps: from memory while it runs, otherwise
// read back from its journal.
func (e *Engine) Get(id string) (Run, error) {
	if err := e.Open(); err != nil {
		return Run{}, err
	}
	e.mu.Lock()
	x := e.active[id]
	e.mu.Unlock()
	if x != nil {
		return x.snapshot(), nil
	}
	if _, ok := e.ix.get(id); !ok {
		return Run{}, ErrNotFound
	}
	x, err := e.replay(id)
	if err != nil {
		return Run{}, err
	}
	x.j.close()
	return x.snapshot(), nil
}

// List lists runs, newest first.
func (e *Engine) List(f Filter) []Summary {
	if e.Open() != nil {
		return []Summary{}
	}
	return e.ix.list(f)
}

// Active is how many runs execute now.
func (e *Engine) Active() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.active)
}

// Cancel stops a run.
func (e *Engine) Cancel(id string) error {
	if err := e.Open(); err != nil {
		return err
	}
	e.mu.Lock()
	x := e.active[id]
	if x == nil {
		s, ok := e.ix.get(id)
		if !ok {
			e.mu.Unlock()
			return ErrNotFound
		}
		if Terminal(s.Status) {
			e.mu.Unlock()
			return ErrDone
		}
		// Queued: it never started.
		defer e.mu.Unlock()
		now := e.now().UTC()
		j, err := openJournal(journalPath(e.Dir, id))
		if err != nil {
			return err
		}
		j.append(Record{T: recFinished, At: now, Status: Cancelled, Error: "cancelled before it started"}, true)
		j.close()
		s.Status, s.Finished, s.Updated, s.Error = Cancelled, now, now, "cancelled before it started"
		e.ix.put(s)
		e.publish("run.finished", s, nil)
		return nil
	}
	e.mu.Unlock()
	x.mu.Lock()
	x.cancelWanted = true
	x.mu.Unlock()
	x.j.append(Record{T: recCancelWant, At: e.now().UTC()}, true)
	x.cancel()
	return nil
}

// Decide decides the gate at path, or the one the run waits at when path
// is empty.
func (e *Engine) Decide(id, path string, d Decision) error {
	if err := e.Open(); err != nil {
		return err
	}
	e.mu.Lock()
	x := e.active[id]
	e.mu.Unlock()
	if x == nil {
		if _, ok := e.ix.get(id); !ok {
			return ErrNotFound
		}
		return ErrNoGate
	}
	x.mu.Lock()
	if path == "" && x.run.Gate != nil {
		path = x.run.Gate.Path
	}
	if x.run.Gate == nil || x.run.Gate.Path != path {
		x.mu.Unlock()
		return ErrNoGate
	}
	ch := x.gateChan(path)
	x.mu.Unlock()
	select {
	case ch <- d:
		return nil
	default:
		return ErrNoGate
	}
}

// Follow streams a run's journal records from record since, then follows
// new ones until the run finishes or ctx ends.
func (e *Engine) Follow(ctx context.Context, id string, since int, fn func(int, Record) bool) error {
	if err := e.Open(); err != nil {
		return err
	}
	if _, ok := e.ix.get(id); !ok {
		return ErrNotFound
	}
	for {
		e.mu.Lock()
		x := e.active[id]
		e.mu.Unlock()
		var changed <-chan struct{}
		if x != nil {
			changed = x.changedCh()
		}
		stop := false
		n, err := scan(journalPath(e.Dir, id), since, func(i int, r Record) bool {
			if !fn(i, r) {
				stop = true
				return false
			}
			return true
		})
		if err != nil {
			return err
		}
		since = n
		if stop || x == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-changed:
		}
	}
}

// Import records runs that happened elsewhere (the old flow-runs.json) as
// finished runs. Runs it already has are skipped.
func (e *Engine) Import(runs []Run) (int, error) {
	if err := e.Open(); err != nil {
		return 0, err
	}
	n := 0
	for _, r := range runs {
		if _, ok := e.ix.get(r.ID); ok {
			continue
		}
		j, err := openJournal(journalPath(e.Dir, r.ID))
		if err != nil {
			return n, err
		}
		r := r
		j.append(Record{T: recCreated, At: r.Created, Run: &r}, false)
		j.append(Record{T: recFinished, At: r.Finished, Status: r.Status, Error: r.Error}, true)
		j.close()
		e.ix.put(r.summary())
		n++
	}
	return n, nil
}

func (e *Engine) publish(typ string, s Summary, extra map[string]any) {
	if e.Host == nil {
		return
	}
	data := map[string]any{"run": s.ID, "template": s.Template, "status": s.Status}
	if s.FlowID != "" {
		data["flow"] = s.FlowID
	}
	if s.Scope != "" {
		data["scope"] = s.Scope
	}
	if s.Path != "" {
		data["path"] = s.Path
	}
	if s.Title != "" {
		data["title"] = s.Title
	}
	if s.Group != "" {
		data["group"] = s.Group
	}
	for k, v := range extra {
		data[k] = v
	}
	e.Host.Publish(typ, data)
}

// finished is called by an execution as it returns.
func (e *Engine) finished(x *execution) {
	e.mu.Lock()
	delete(e.active, x.run.ID)
	e.scheduleLocked()
	e.mu.Unlock()
	// Followers read the rest from the journal and stop.
	x.mu.Lock()
	close(x.changed)
	x.changed = make(chan struct{})
	x.mu.Unlock()
	if e.Host != nil {
		e.Host.Done(x.run.ID)
	}
}

// paramString is a parameter as a variable.
func paramString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// Expand substitutes {{name}} with vars, as plain text.
func ExpandText(s string, vars map[string]string) string {
	if !strings.Contains(s, "{{") {
		return s
	}
	var out strings.Builder
	for {
		i := strings.Index(s, "{{")
		if i < 0 {
			out.WriteString(s)
			break
		}
		j := strings.Index(s[i:], "}}")
		if j < 0 {
			out.WriteString(s)
			break
		}
		out.WriteString(s[:i])
		out.WriteString(vars[strings.TrimSpace(s[i+2:i+j])])
		s = s[i+j+2:]
	}
	return out.String()
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

func errText(format string, args ...any) string { return fmt.Sprintf(format, args...) }
