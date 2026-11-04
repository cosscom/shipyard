package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// execution is one run executing: one goroutine (plus one per map item
// running), ending with the run.
type execution struct {
	e   *Engine
	j   *journal
	ctx context.Context
	// cancel ends the run's context: by Cancel, or berthd stopping.
	cancel context.CancelFunc

	mu           sync.Mutex
	run          *Run
	cancelWanted bool
	changed      chan struct{}
	open         map[string]chan Decision

	// From the journal, read once before the run goes on.
	done      map[string]Record
	started   map[string]Record
	decisions map[string]Decision
	opened    map[string]Record
	sleeps    map[string]time.Time
	items     []map[string]any

	agents int // agents this run started
	rounds int // loop rounds this run ran
	usage  Usage
	waived map[string]bool
	maps   map[string][]bool // map path → its items' results
}

// errAbort ends the run as failed, past any step that would handle it.
type errAbort struct{ msg string }

func (e errAbort) Error() string { return e.msg }

// replay reads a run's journal into a new execution.
func (e *Engine) replay(id string) (*execution, error) {
	x := &execution{e: e, changed: make(chan struct{}), open: map[string]chan Decision{}, done: map[string]Record{},
		started: map[string]Record{}, decisions: map[string]Decision{}, opened: map[string]Record{}, sleeps: map[string]time.Time{},
		waived: map[string]bool{}, maps: map[string][]bool{}}
	n, err := scan(journalPath(e.Dir, id), 0, func(_ int, r Record) bool {
		x.apply(r)
		return true
	})
	if err != nil {
		return nil, err
	}
	if x.run == nil {
		return nil, fmt.Errorf("run %s has no journal", id)
	}
	j, err := openJournal(journalPath(e.Dir, id))
	if err != nil {
		return nil, err
	}
	j.n = n
	x.j = j
	return x, nil
}

// apply folds one journal record into the execution's state.
func (x *execution) apply(r Record) {
	switch r.T {
	case recCreated:
		x.run = r.Run
		if x.run.Vars == nil {
			x.run.Vars = map[string]string{}
		}
		if x.run.Steps == nil {
			x.run.Steps = []StepRun{}
		}
		if items, ok := x.run.Params["items"].([]any); ok {
			for _, it := range items {
				if m, ok := it.(map[string]any); ok {
					x.items = append(x.items, m)
				}
			}
		}
		return
	case recCoalesced:
		x.items = append(x.items, r.Item)
		x.run.Coalesced++
	case recStatus:
		x.run.Status = r.Status
		if r.Status == Running {
			x.run.Gate = nil
		}
	case recStarted:
		x.started[r.Path] = r
		if r.Step != nil {
			upsert(&x.run.Steps, *r.Step)
		}
		x.run.Cursor = r.Path
	case recStepDone:
		delete(x.started, r.Path)
		x.done[r.Path] = r
		if r.Step != nil {
			upsert(&x.run.Steps, *r.Step)
		}
		if r.Usage != nil {
			x.usage.Add(r.Usage)
		}
		if r.Cand != nil {
			x.putCandidate(*r.Cand)
		}
	case recCandidate:
		if r.Cand != nil {
			x.putCandidate(*r.Cand)
		}
	case recGateOpen:
		x.opened[r.Path] = r
		x.run.Gate = r.Gate
		x.run.Status = WaitingGate
	case recGateDone:
		if r.Decided != nil {
			x.decisions[r.Path] = *r.Decided
		}
		x.run.Gate = nil
		if !Terminal(x.run.Status) {
			x.run.Status = Running
		}
	case recSleep:
		x.sleeps[r.Path] = r.Until
	case recCancelWant:
		x.cancelWanted = true
	case recFinished:
		x.run.Status, x.run.Error, x.run.Finished = r.Status, r.Error, r.At
		x.run.Gate = nil
	}
	if !r.At.IsZero() {
		x.run.Updated = r.At
	}
	if x.usage.Tokens() > 0 || x.usage.USD > 0 {
		u := x.usage
		x.run.Usage = &u
	}
}

func (x *execution) putCandidate(c Candidate) {
	for i := range x.run.Candidates {
		if x.run.Candidates[i].Index == c.Index {
			x.run.Candidates[i] = c
			return
		}
	}
	x.run.Candidates = append(x.run.Candidates, c)
	sort.Slice(x.run.Candidates, func(i, j int) bool { return x.run.Candidates[i].Index < x.run.Candidates[j].Index })
}

func (x *execution) snapshot() Run {
	x.mu.Lock()
	defer x.mu.Unlock()
	b, _ := json.Marshal(x.run)
	var r Run
	json.Unmarshal(b, &r)
	return r
}

func (x *execution) changedCh() <-chan struct{} {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.changed
}

// record appends to the journal, folds the record in, and wakes followers.
func (x *execution) record(r Record, sync bool) {
	if r.At.IsZero() {
		r.At = x.e.now().UTC()
	}
	if err := x.j.append(r, sync); err != nil {
		x.e.logf("runs: %s: journal: %v", x.run.ID, err)
	}
	x.mu.Lock()
	switch r.T {
	case recStarted, recStepDone:
		// Live, the maps are the replay's: what is done now is never asked
		// about again in this execution.
		if r.Step != nil {
			upsert(&x.run.Steps, *r.Step)
		}
		if r.T == recStarted {
			x.run.Cursor = r.Path
		}
		if r.Usage != nil {
			x.usage.Add(r.Usage)
			u := x.usage
			x.run.Usage = &u
		}
		if r.Cand != nil {
			x.putCandidate(*r.Cand)
		}
		x.run.Updated = r.At
	default:
		x.apply(r)
	}
	close(x.changed)
	x.changed = make(chan struct{})
	x.mu.Unlock()
}

func (x *execution) stopping() bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	return !x.cancelWanted && x.ctx.Err() != nil
}

func (x *execution) summary() Summary {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.run.summary()
}

func (x *execution) setStatus(status string, gate *Gate) {
	x.mu.Lock()
	x.run.Status, x.run.Gate = status, gate
	s := x.run.summary()
	x.mu.Unlock()
	x.e.ix.put(s)
}

// main executes the run to its end, unless berthd stops first.
func (x *execution) main() {
	defer x.e.wg.Done()
	defer x.e.finished(x)
	defer x.j.close()
	defer x.cancel()

	x.mu.Lock()
	resumed := x.run.Status != Queued && len(x.done)+len(x.started) > 0
	if x.run.Status == Queued || x.run.Status == Paused || x.run.Status == "" {
		x.run.Status = Running
	}
	vars := map[string]string{}
	for k, v := range x.run.Vars {
		vars[k] = v
	}
	vars["run.id"] = x.run.ID
	if len(x.items) > 0 && x.e.Items != nil {
		vars["event.items"] = x.e.Items(x.items)
	}
	x.mu.Unlock()
	x.record(Record{T: recStatus, Status: x.run.Status}, false)
	x.setStatus(x.run.Status, x.run.Gate)
	if resumed {
		x.e.publish("run.resumed", x.summary(), nil)
	} else {
		x.e.publish("run.started", x.summary(), nil)
	}

	sc := &scope{vars: vars}
	defer x.release(sc)
	ok, err := x.seq(x.ctx, sc, x.run.Flow, "")
	if x.stopping() {
		// berthd is stopping: the run resumes when it starts again.
		x.setStatus(x.run.Status, x.run.Gate)
		return
	}
	status, msg := Succeeded, ""
	var ab errAbort
	switch {
	case x.cancelled():
		status, msg = Cancelled, "cancelled"
	case errors.As(err, &ab):
		status, msg = Failed, ab.msg
	case err != nil:
		status, msg = Failed, err.Error()
	case !ok:
		status, msg = Failed, x.lastError()
	}
	x.record(Record{T: recFinished, Status: status, Error: msg}, true)
	x.mu.Lock()
	x.run.Status, x.run.Error, x.run.Finished = status, msg, x.e.now().UTC()
	x.run.Gate = nil
	x.mu.Unlock()
	x.setStatus(status, nil)
	x.e.publish("run.finished", x.summary(), nil)
}

func (x *execution) cancelled() bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.cancelWanted
}

// lastError is the error of the last step that failed.
func (x *execution) lastError() string {
	x.mu.Lock()
	defer x.mu.Unlock()
	var last string
	var walk func([]StepRun)
	walk = func(steps []StepRun) {
		for _, s := range steps {
			if s.Status == Failed && s.Error != "" {
				last = s.Error
			}
			walk(s.Children)
		}
	}
	walk(x.run.Steps)
	if last == "" {
		return "a step failed"
	}
	return last
}

// scope is the variables a sequence of steps sees: the run's, or a map
// item's copy.
type scope struct {
	vars map[string]string
	held int // agent slots this scope took (a map item's)
}

func (sc *scope) child(extra map[string]string) *scope {
	v := make(map[string]string, len(sc.vars)+len(extra))
	for k, val := range sc.vars {
		v[k] = val
	}
	for k, val := range extra {
		v[k] = val
	}
	return &scope{vars: v}
}

func joinPath(prefix string, part string) string {
	if prefix == "" {
		return part
	}
	return prefix + "." + part
}

// seq runs steps in order with flows' when rules: a step runs on the
// previous one's success (default), failure, or always. ok is false when a
// step failed and no later step handles it.
func (x *execution) seq(ctx context.Context, sc *scope, steps []Step, prefix string) (bool, error) {
	prevOK, failed := true, false
	for i, s := range steps {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		id := s.ID
		if id == "" {
			id = strconv.Itoa(i + 1)
		}
		path := joinPath(prefix, strconv.Itoa(i))
		when := s.When
		if when == "" {
			when = "success"
		}
		if (when == "success" && !prevOK) || (when == "failure" && prevOK) {
			if _, ok := x.done[path]; !ok {
				x.record(Record{T: recStepDone, Path: path, Step: &StepRun{ID: id, Kind: s.Kind, Path: path, Status: "skipped"}}, false)
			}
			continue
		}
		res, err := x.step(ctx, sc, s, id, path)
		if err != nil {
			return false, err
		}
		if ctx.Err() != nil && res.Status != Succeeded && res.Status != Failed && res.Status != Skipped {
			return false, ctx.Err()
		}
		prevOK = res.ok()
		failed = !prevOK && !handled(steps[i+1:])
		code := strconv.Itoa(res.Code)
		out := tail(res.Out, 4000)
		sc.vars["prev.output"], sc.vars["prev.exit_code"], sc.vars["prev.status"] = out, code, res.Status
		sc.vars["steps."+id+".output"], sc.vars["steps."+id+".exit_code"], sc.vars["steps."+id+".status"] = out, code, res.Status
		sc.vars["prev.feedback"], sc.vars["steps."+id+".feedback"] = res.Feedback, res.Feedback
		for k, v := range res.Set {
			sc.vars[k] = v
		}
	}
	return !failed, nil
}

func handled(rest []Step) bool {
	for _, s := range rest {
		if s.When == "failure" || s.When == "always" {
			return true
		}
	}
	return false
}

// step runs one step of any kind.
func (x *execution) step(ctx context.Context, sc *scope, s Step, id, path string) (Result, error) {
	switch s.Kind {
	case "loop":
		return x.loop(ctx, sc, s, id, path)
	case "map":
		return x.mapStep(ctx, sc, s, id, path)
	case "join":
		return x.join(s, id, path), nil
	case "if":
		return x.ifStep(ctx, sc, s, id, path)
	case "gate":
		return x.gate(ctx, sc, s, id, path)
	case "sleep":
		return x.sleep(ctx, s, id, path), nil
	case "judge":
		return x.judge(ctx, sc, s, id, path)
	}
	return x.leaf(ctx, sc, s, id, path)
}

// structural records a loop's, map's or branch's own start and end, for the
// timeline.
func (x *execution) structural(id, kind, path string, start time.Time, res Result) {
	x.record(Record{T: recStepDone, Path: path, Step: &StepRun{ID: id, Kind: kind, Path: path, Status: res.Status, Started: start,
		Ended: x.e.now().UTC(), Duration: x.e.now().Sub(start).Round(time.Millisecond).String(), Output: tail(res.Out, 4000), ExitCode: res.Code, Error: res.Err}}, false)
}

func (x *execution) structuralStart(id, kind, path string) time.Time {
	if r, ok := x.started[path]; ok && r.Step != nil {
		return r.Step.Started
	}
	if r, ok := x.done[path]; ok && r.Step != nil {
		return r.Step.Started
	}
	now := x.e.now().UTC()
	x.record(Record{T: recStarted, Path: path, Step: &StepRun{ID: id, Kind: kind, Path: path, Status: Running, Started: now}}, false)
	return now
}

func (x *execution) finishStructural(id, kind, path string, start time.Time, res Result) Result {
	if _, ok := x.done[path]; !ok && !x.stopping() {
		x.structural(id, kind, path, start, res)
	}
	return res
}

func (x *execution) loop(ctx context.Context, sc *scope, s Step, id, path string) (Result, error) {
	start := x.structuralStart(id, "loop", path)
	max := s.Max
	if max <= 0 {
		max = 3
	}
	max = min(max, 50)
	sc.vars["loop.max"] = strconv.Itoa(max)
	for r := 1; r <= max; r++ {
		sc.vars["loop.round"] = strconv.Itoa(r)
		x.mu.Lock()
		x.rounds++
		x.mu.Unlock()
		ok, err := x.seq(ctx, sc, s.Steps, joinPath(path, "r"+strconv.Itoa(r)))
		if err != nil {
			return Result{Status: Failed}, err
		}
		until := ok
		if s.Until != "" {
			v, err := Eval(s.Until, sc.vars)
			if err != nil {
				return x.finishStructural(id, "loop", path, start, Result{Status: Failed, Err: "until: " + err.Error()}), nil
			}
			until = v
		}
		if until {
			sc.vars["loop.rounds"] = strconv.Itoa(r)
			return x.finishStructural(id, "loop", path, start, Result{Status: Succeeded, Out: fmt.Sprintf("done in round %d of %d", r, max)}), nil
		}
	}
	sc.vars["loop.rounds"] = strconv.Itoa(max)
	return x.finishStructural(id, "loop", path, start, Result{Status: Failed, Code: 1, Err: fmt.Sprintf("still not done after %d rounds", max)}), nil
}

// maxItems bounds a map's fan-out.
const maxItems = 64

// Items reads a map's items: a JSON list of strings or objects, or text
// (usually one {{variable}}) whose non-empty lines are the items.
func Items(raw json.RawMessage, vars map[string]string) ([]map[string]string, error) {
	if len(raw) == 0 {
		return nil, errors.New("map has no items")
	}
	var list []any
	var text string
	if json.Unmarshal(raw, &text) == nil {
		for _, l := range strings.Split(ExpandText(text, vars), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				list = append(list, l)
			}
		}
	} else if err := json.Unmarshal(raw, &list); err != nil {
		return nil, errors.New("map items must be a list or text")
	}
	if len(list) > maxItems {
		return nil, fmt.Errorf("a map takes at most %d items, not %d", maxItems, len(list))
	}
	out := make([]map[string]string, 0, len(list))
	for i, it := range list {
		m := map[string]string{"item.index": strconv.Itoa(i), "item.n": strconv.Itoa(i + 1)}
		switch v := it.(type) {
		case map[string]any:
			for k, val := range v {
				m["item."+k] = paramString(val)
			}
			b, _ := json.Marshal(v)
			m["item"] = string(b)
		default:
			m["item"] = paramString(v)
		}
		out = append(out, m)
	}
	return out, nil
}

func (x *execution) mapStep(ctx context.Context, sc *scope, s Step, id, path string) (Result, error) {
	start := x.structuralStart(id, "map", path)
	items, err := Items(s.Items, sc.vars)
	if err != nil {
		return x.finishStructural(id, "map", path, start, Result{Status: Failed, Err: err.Error()}), nil
	}
	conc := s.Concurrency
	if conc <= 0 || conc > len(items) {
		conc = len(items)
	}
	conc = min(conc, 16)
	results := make([]bool, len(items))
	outs := make([]string, len(items))
	mctx, stop := context.WithCancel(ctx)
	defer stop()
	sem := make(chan struct{}, max(conc, 1))
	var wg sync.WaitGroup
	var abortMu sync.Mutex
	var abort error
	for i, it := range items {
		select {
		case sem <- struct{}{}:
		case <-mctx.Done():
		}
		if mctx.Err() != nil {
			break
		}
		wg.Add(1)
		go func(i int, it map[string]string) {
			defer wg.Done()
			defer func() { <-sem }()
			child := sc.child(it)
			ok, err := x.seq(mctx, child, s.Steps, joinPath(path, "i"+strconv.Itoa(i)))
			x.release(child)
			if err != nil && mctx.Err() == nil {
				abortMu.Lock()
				abort = err
				abortMu.Unlock()
			}
			results[i] = ok && err == nil
			outs[i] = child.vars["prev.output"]
			if ok && s.Mode == "first_success" {
				stop()
			}
		}(i, it)
	}
	wg.Wait()
	if x.stopping() {
		return Result{Status: Failed}, ctx.Err()
	}
	var ab errAbort
	if errors.As(abort, &ab) {
		return Result{Status: Failed}, abort
	}
	x.mu.Lock()
	x.maps[path] = results
	x.mu.Unlock()
	res := joinResults(s.Mode, results)
	var b strings.Builder
	for i, o := range outs {
		fmt.Fprintf(&b, "%d. %s\n", i+1, firstLine(o, 200))
	}
	res.Out = b.String()
	sc.vars["map.ok"], sc.vars["map.count"] = strconv.Itoa(count(results)), strconv.Itoa(len(results))
	sc.vars["map.last"] = path
	return x.finishStructural(id, "map", path, start, res), nil
}

func count(bs []bool) int {
	n := 0
	for _, b := range bs {
		if b {
			n++
		}
	}
	return n
}

func joinResults(mode string, results []bool) Result {
	n := count(results)
	ok := false
	switch mode {
	case "any", "first_success":
		ok = n > 0
	default:
		ok = n == len(results)
	}
	if ok {
		return Result{Status: Succeeded}
	}
	return Result{Status: Failed, Code: 1, Err: fmt.Sprintf("%d of %d items succeeded", n, len(results))}
}

func (x *execution) join(s Step, id, path string) Result {
	x.mu.Lock()
	var last []bool
	var lastPath string
	for p, r := range x.maps {
		if p > lastPath {
			lastPath, last = p, r
		}
	}
	x.mu.Unlock()
	res := joinResults(s.Mode, last)
	if _, ok := x.done[path]; !ok {
		x.structural(id, "join", path, x.e.now().UTC(), res)
	}
	return res
}

func (x *execution) ifStep(ctx context.Context, sc *scope, s Step, id, path string) (Result, error) {
	v, err := Eval(s.Cond, sc.vars)
	if err != nil {
		return Result{Status: Failed, Err: "cond: " + err.Error()}, nil
	}
	branch, part := s.Steps, "t"
	if !v {
		branch, part = s.Else, "e"
	}
	if len(branch) == 0 {
		return Result{Status: Succeeded, Out: "skipped"}, nil
	}
	start := x.structuralStart(id, "if", path)
	ok, err := x.seq(ctx, sc, branch, joinPath(path, part))
	if err != nil {
		return Result{Status: Failed}, err
	}
	res := Result{Status: Succeeded, Out: map[bool]string{true: "then", false: "else"}[v]}
	if !ok {
		res.Status, res.Err = Failed, "the branch failed"
	}
	return x.finishStructural(id, "if", path, start, res), nil
}

// gate waits for a person to approve or reject, durably.
func (x *execution) gate(ctx context.Context, sc *scope, s Step, id, path string) (Result, error) {
	g := Gate{Path: path, Title: ExpandText(s.Title, sc.vars), Text: ExpandText(s.Text, sc.vars), Pick: s.Pick}
	if g.Title == "" {
		g.Title = "Approve?"
	}
	if s.Pick {
		if w, err := strconv.Atoi(sc.vars["judge.winner"]); err == nil {
			g.Default = w
		}
	}
	d, err := x.await(ctx, g, s.Timeout, s.OnTimeout, id)
	if err != nil {
		return Result{Status: Failed}, err
	}
	res := Result{Status: Succeeded, Out: "approved", Set: map[string]string{}}
	if d.By != "" {
		res.Out += " by " + d.By
	}
	if d.Timeout {
		res.Out += " (timed out)"
	}
	if d.Note != "" {
		res.Set["gate.note"] = d.Note
	}
	if !d.Approve {
		res.Status, res.Out, res.Code = Failed, "rejected", 1
		res.Err = "rejected"
		if d.Note != "" {
			res.Err += ": " + d.Note
		}
		if d.Timeout && s.OnTimeout == "fail" {
			return res, errAbort{"the gate " + strconv.Quote(g.Title) + " timed out"}
		}
		return res, nil
	}
	if s.Pick {
		pick := g.Default
		if d.Pick != nil {
			pick = *d.Pick
		}
		if pick < 0 {
			// None of these: the pick was made elsewhere (another box's
			// attempts, compared in the app). No PR here; all are archived.
			res.Set["pick.none"] = "1"
			res.Out = "none of these was picked"
			return res, nil
		}
		x.pick(sc, pick, res.Set)
	}
	return res, nil
}

// pick marks candidate i the winner and sets pick.* for the steps after.
func (x *execution) pick(sc *scope, i int, set map[string]string) {
	x.mu.Lock()
	var c *Candidate
	for k := range x.run.Candidates {
		x.run.Candidates[k].Picked = x.run.Candidates[k].Index == i
		if x.run.Candidates[k].Index == i {
			c = &x.run.Candidates[k]
		}
	}
	var cc Candidate
	if c != nil {
		cc = *c
	}
	x.mu.Unlock()
	if c == nil {
		return
	}
	set["pick.index"], set["pick.path"], set["pick.branch"] = strconv.Itoa(cc.Index), cc.Path, cc.Branch
	set["pick.worktree"], set["pick.session"], set["pick.location"], set["pick.agent"] = cc.Worktree, cc.Session, cc.Location, cc.Agent
	x.record(Record{T: recCandidate, Cand: &cc}, false)
}

// await opens a gate (or finds it decided in the journal) and waits for its
// decision, a deadline, or the run ending.
func (x *execution) await(ctx context.Context, g Gate, timeout, onTimeout, id string) (Decision, error) {
	path := g.Path
	if d, ok := x.decisions[path]; ok {
		return d, nil
	}
	if op, ok := x.opened[path]; ok && op.Gate != nil {
		g.Deadline = op.Gate.Deadline
	} else if d, err := time.ParseDuration(timeout); err == nil && d > 0 {
		g.Deadline = x.e.now().UTC().Add(d)
	}
	x.mu.Lock()
	ch := x.gateChan(path)
	x.mu.Unlock()
	defer func() {
		x.mu.Lock()
		delete(x.open, path)
		x.mu.Unlock()
	}()
	if _, ok := x.opened[path]; !ok {
		x.record(Record{T: recGateOpen, Path: path, Gate: &g, Step: &StepRun{ID: id, Kind: "gate", Path: path, Status: "waiting", Started: x.e.now().UTC(), Output: g.Title}}, true)
	}
	x.setStatus(WaitingGate, &g)
	x.e.publish("run.gate", x.summary(), map[string]any{"step": path, "gate_title": g.Title, "pick": g.Pick})
	var timer <-chan time.Time
	if !g.Deadline.IsZero() {
		t := time.NewTimer(time.Until(g.Deadline))
		defer t.Stop()
		timer = t.C
	}
	var d Decision
	select {
	case d = <-ch:
	case <-timer:
		d = Decision{Approve: onTimeout == "approve", Timeout: true, By: "timeout"}
	case <-ctx.Done():
		return Decision{}, ctx.Err()
	}
	now := x.e.now().UTC()
	st := StepRun{ID: id, Kind: "gate", Path: path, Status: Succeeded, Ended: now, Output: g.Title}
	if op, ok := x.opened[path]; ok && op.Step != nil {
		st.Started = op.Step.Started
	}
	if g.RejectLabel != "" {
		// A choice between two ways on, not a yes or no: neither failed.
		st.Output = g.RejectLabel
		if d.Approve {
			st.Output = g.ApproveLabel
		}
	} else if !d.Approve {
		st.Status = Failed
	}
	x.record(Record{T: recGateDone, Path: path, Decided: &d, Step: &st}, true)
	x.mu.Lock()
	x.decisions[path] = d
	x.mu.Unlock()
	x.setStatus(Running, nil)
	x.e.publish("run.gate_decided", x.summary(), map[string]any{"step": path, "approve": d.Approve, "by": d.By})
	return d, nil
}

// gateChan is the channel a gate's decision arrives on; x.mu is held.
func (x *execution) gateChan(path string) chan Decision {
	ch := x.open[path]
	if ch == nil {
		ch = make(chan Decision, 1)
		x.open[path] = ch
	}
	return ch
}

func (x *execution) sleep(ctx context.Context, s Step, id, path string) Result {
	if _, ok := x.done[path]; ok {
		return Result{Status: Succeeded}
	}
	until, ok := x.sleeps[path]
	if !ok {
		d, err := time.ParseDuration(s.Duration)
		if err != nil || d <= 0 {
			return Result{Status: Failed, Err: "sleep needs a duration"}
		}
		until = x.e.now().UTC().Add(d)
		x.record(Record{T: recSleep, Path: path, Until: until, Step: &StepRun{ID: id, Kind: "sleep", Path: path, Status: Running, Started: x.e.now().UTC()}}, true)
	}
	t := time.NewTimer(time.Until(until))
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
		return Result{Status: Cancelled}
	}
	res := Result{Status: Succeeded, Out: "slept until " + until.Format(time.RFC3339)}
	x.record(Record{T: recStepDone, Path: path, Step: &StepRun{ID: id, Kind: "sleep", Path: path, Status: Succeeded, Ended: x.e.now().UTC(), Output: res.Out}}, false)
	return res
}

// agentKinds start an agent: they take an agent slot.
var agentKinds = map[string]bool{"start_agent": true, "headless": true}

// syncKinds have side effects a resume must know were attempted.
var syncKinds = map[string]bool{"prompt": true, "start_agent": true, "headless": true, "webhook": true, "notify": true, "pr": true, "archive_worktree": true}

// leaf runs a leaf step through the host: from the journal when it already
// finished, by its re-entry rule when it was in flight, else for real.
func (x *execution) leaf(ctx context.Context, sc *scope, s Step, id, path string) (Result, error) {
	if rec, ok := x.done[path]; ok {
		res := resultOf(rec)
		if res.Candidate != nil {
			x.mu.Lock()
			x.putCandidate(*res.Candidate)
			x.mu.Unlock()
		}
		if agentKinds[s.Kind] && s.Kind == "start_agent" {
			x.mu.Lock()
			x.agents++
			x.mu.Unlock()
		}
		return res, nil
	}
	sctx := &StepCtx{Run: x.summary(), Step: s, Path: path, Attempt: 1, Vars: copyVars(sc.vars), Stopping: x.stopping}
	x.mu.Lock()
	sctx.Candidates = append([]Candidate(nil), x.run.Candidates...)
	x.mu.Unlock()
	if rec, ok := x.started[path]; ok {
		if rec.Attempt > 0 {
			sctx.Attempt = rec.Attempt
		}
		sctx.IdemKey = idemKey(x.run.ID, path, sctx.Attempt)
		if s.Kind == "pr" && rec.Step != nil && rec.Step.Status == Failed {
			// berthd stopped while a person was asked about a pull request
			// that didn't open: the same question, not another try.
			return x.publishFailed(ctx, sc, sctx, id, Result{Status: Failed, Code: rec.Step.ExitCode, Out: rec.Step.Output, Err: rec.Step.Error}, rec.Step)
		}
		if res, ok := x.e.Host.Reenter(ctx, sctx); ok {
			if res.Status == "unknown" {
				arrived, err := x.await(ctx, Gate{Path: path + ".arrived", Title: "Did the prompt arrive?",
					Text: "berthd stopped while it was typing a prompt into " + sctx.Vars["session"] + ". Approve if the agent got it; reject to send it again."}, "", "", id)
				if err != nil {
					return Result{Status: Failed}, err
				}
				if arrived.Approve {
					res = Result{Status: Succeeded, Out: "the prompt arrived (as a person said)", Set: map[string]string{"turn.id": "", "turn.session": sctx.Vars["session"]}}
				} else {
					sctx.Attempt++
					sctx.IdemKey = idemKey(x.run.ID, path, sctx.Attempt)
					return x.execute(ctx, sc, sctx, id)
				}
			}
			x.finish(sc, sctx, id, res, rec.Step)
			return res, nil
		}
	}
	sctx.IdemKey = idemKey(x.run.ID, path, sctx.Attempt)
	return x.execute(ctx, sc, sctx, id)
}

func idemKey(run, path string, attempt int) string {
	return fmt.Sprintf("%s/%s/%d", run, path, attempt)
}

func copyVars(v map[string]string) map[string]string {
	out := make(map[string]string, len(v))
	for k, val := range v {
		out[k] = val
	}
	return out
}

func (x *execution) execute(ctx context.Context, sc *scope, sctx *StepCtx, id string) (Result, error) {
	s, path := sctx.Step, sctx.Path
	if err := x.checkBudget(ctx, sc, s, id, path); err != nil {
		return Result{Status: Failed}, err
	}
	if agentKinds[s.Kind] {
		select {
		case x.e.agents <- struct{}{}:
		case <-ctx.Done():
			return Result{Status: Cancelled}, ctx.Err()
		}
		x.mu.Lock()
		x.agents++
		x.mu.Unlock()
		if s.Kind == "headless" {
			defer func() { <-x.e.agents }()
		} else {
			sc.held++
		}
	}
	started := &StepRun{ID: id, Kind: s.Kind, Path: path, Status: Running, Attempt: sctx.Attempt, Started: x.e.now().UTC(), IdemKey: sctx.IdemKey}
	x.record(Record{T: recStarted, Path: path, Attempt: sctx.Attempt, Step: started}, syncKinds[s.Kind])
	res := x.e.Host.Leaf(ctx, sctx)
	if ctx.Err() != nil && res.Status != Succeeded {
		if x.stopping() {
			// Left started: the resume re-enters it.
			return Result{Status: Cancelled}, ctx.Err()
		}
		res.Status = Cancelled
		if res.Err == "" {
			res.Err = "cancelled"
		}
	}
	if s.Kind == "pr" && res.Status == Failed {
		return x.publishFailed(ctx, sc, sctx, id, res, started)
	}
	x.finish(sc, sctx, id, res, started)
	return res, nil
}

// publishFailed is a pull request that didn't open. That is publishing
// failing, not the agents' work: the pick stays recorded, nothing is
// archived, and the run waits for a person to retry, or to finish without
// a pull request, which the steps after see as a skip and go on.
func (x *execution) publishFailed(ctx context.Context, sc *scope, sctx *StepCtx, id string, res Result, started *StepRun) (Result, error) {
	path := sctx.Path
	g := Gate{Path: fmt.Sprintf("%s.publish%d", path, sctx.Attempt), Title: "The pull request didn't open", Text: publishText(res, sctx.Vars["pick.path"] != ""),
		ApproveLabel: "Retry publishing", RejectLabel: "Finish without a pull request"}
	if _, ok := x.opened[g.Path]; !ok {
		// The step shows its failure while the run waits.
		failed := *started
		failed.Status, failed.Error, failed.Output, failed.ExitCode = Failed, res.Err, tail(res.Out, 4000), res.Code
		failed.Ended = x.e.now().UTC()
		x.record(Record{T: recStarted, Path: path, Attempt: sctx.Attempt, Step: &failed}, true)
	}
	d, err := x.await(ctx, g, "", "", id)
	if err != nil {
		return Result{Status: Failed}, err
	}
	if d.Approve {
		sctx.Attempt++
		sctx.IdemKey = idemKey(x.run.ID, path, sctx.Attempt)
		return x.execute(ctx, sc, sctx, id)
	}
	out := "Finished without a pull request"
	if res.Err != "" {
		out += " (" + res.Err + ")"
	}
	skip := Result{Status: Skipped, Out: out + ".", Set: map[string]string{"pr.skipped": "1"}}
	x.finish(sc, sctx, id, skip, started)
	return skip, nil
}

// publishText is the publish gate's text: what failed, in the tool's own
// words, and what each way on does.
func publishText(res Result, picked bool) string {
	what := res.Err
	if what == "" {
		what = "it failed"
	}
	t := "The agents' work is done and kept; only publishing failed: " + what + "."
	if picked {
		t = "The agents' work is done and your pick is kept; only publishing failed: " + what + "."
	}
	if o := strings.TrimSpace(res.Out); o != "" {
		t += "\n\n" + tail(o, 1200)
	}
	if picked {
		return t + "\n\nRetry once it's fixed, or finish without a pull request: the run goes on and archives the other attempts."
	}
	return t + "\n\nRetry once it's fixed, or finish without a pull request: the run goes on with its next steps."
}

// finish journals a leaf's result.
func (x *execution) finish(sc *scope, sctx *StepCtx, id string, res Result, started *StepRun) {
	if res.Status == "" {
		res.Status = Succeeded
	}
	now := x.e.now().UTC()
	sr := StepRun{ID: id, Kind: sctx.Step.Kind, Path: sctx.Path, Status: res.Status, Attempt: sctx.Attempt, Ended: now,
		Output: tail(res.Out, 4000), ExitCode: res.Code, Error: res.Err, IdemKey: sctx.IdemKey, Usage: res.Usage}
	if started != nil {
		sr.Started = started.Started
		sr.Duration = now.Sub(started.Started).Round(time.Millisecond).String()
	}
	if res.Set != nil {
		sr.Turn, sr.Session = res.Set["turn.id"], res.Set["session"]
		if sr.Session == "" {
			sr.Session = res.Set["turn.session"]
		}
	}
	x.record(Record{T: recStepDone, Path: sctx.Path, Attempt: sctx.Attempt, Step: &sr, Set: res.Set, Usage: res.Usage, Cand: res.Candidate, Feedback: res.Feedback}, false)
	x.e.publish("run.step", x.summary(), map[string]any{"step": sctx.Path, "kind": sctx.Step.Kind, "step_status": res.Status})
}

// resultOf reads a finished step back from its journal record.
func resultOf(r Record) Result {
	res := Result{Set: map[string]string{}, Usage: r.Usage, Candidate: r.Cand, Feedback: r.Feedback}
	if r.Step != nil {
		res.Status, res.Code, res.Out, res.Err = r.Step.Status, r.Step.ExitCode, r.Step.Output, r.Step.Error
	}
	for k, v := range r.Set {
		res.Set[k] = v
	}
	return res
}

// checkBudget pauses the run at a gate when it is over its budget.
func (x *execution) checkBudget(ctx context.Context, sc *scope, s Step, id, path string) error {
	b := x.run.Budget
	if b == nil {
		return nil
	}
	over, cap := "", ""
	x.mu.Lock()
	switch {
	case b.MaxWall != "" && !x.waived["wall"]:
		if d, err := time.ParseDuration(b.MaxWall); err == nil && x.e.now().Sub(x.run.Created) > d {
			over, cap = "it has run longer than its max_wall of "+b.MaxWall, "wall"
		}
	}
	if over == "" && b.MaxRounds > 0 && x.rounds > b.MaxRounds && !x.waived["rounds"] {
		over, cap = fmt.Sprintf("it ran %d rounds, past its max_rounds of %d", x.rounds, b.MaxRounds), "rounds"
	}
	if over == "" && b.MaxAgents > 0 && agentKinds[s.Kind] && x.agents >= b.MaxAgents && !x.waived["agents"] {
		over, cap = fmt.Sprintf("it would start agent %d, past its max_agents of %d", x.agents+1, b.MaxAgents), "agents"
	}
	if over == "" && b.MaxUSD > 0 && x.usage.USD > b.MaxUSD && !x.waived["usd"] {
		over, cap = fmt.Sprintf("its agents spent $%.2f, past its max_usd of $%.2f", x.usage.USD, b.MaxUSD), "usd"
	}
	if over == "" && b.MaxTokens > 0 && x.usage.Tokens() > b.MaxTokens && !x.waived["tokens"] {
		over, cap = fmt.Sprintf("its agents used %d tokens, past its max_tokens of %d", x.usage.Tokens(), b.MaxTokens), "tokens"
	}
	x.mu.Unlock()
	if over == "" {
		return nil
	}
	d, err := x.await(ctx, Gate{Path: path + ".budget", Title: "Over budget", Text: "This run paused because " + over + ". Approve to go on without that cap; reject to stop it."}, "", "", id)
	if err != nil {
		return err
	}
	if !d.Approve {
		return errAbort{"over budget: " + over}
	}
	x.mu.Lock()
	x.waived[cap] = true
	x.mu.Unlock()
	return nil
}

// release gives back the agent slots a map item took.
func (x *execution) release(sc *scope) {
	for ; sc.held > 0; sc.held-- {
		<-x.e.agents
	}
}

func firstLine(s string, n int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > n {
		s = s[:n] + "…"
	}
	return s
}
