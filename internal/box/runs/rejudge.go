package runs

import (
	"context"
	"errors"
	"strconv"
	"strings"
)

// Rerunning the judge: an attempts run waiting for a person to pick can
// have its attempts judged again, as they are now (an agent may have
// changed one since, or the judge's reply was not valid). The coding
// agents are not touched, the run stays at its gate, and each evaluation
// is kept, so Review can show what changed.

// Rerun errors.
var (
	ErrNotPicking = errors.New("that run is not waiting for you to pick an attempt")
	ErrJudging    = errors.New("the judge is already looking at that run's attempts")
	ErrNoJudge    = errors.New("that run has no judge to ask again")
)

// Refresher is a Host that can read an attempts run's worktrees again:
// each candidate's diff, commits and version as they are now. Refresh
// returns the candidates with those filled in.
type Refresher interface {
	Refresh(ctx context.Context, run Summary, vars map[string]string, cands []Candidate) []Candidate
}

// judging is a rerun of the judge in flight.
type judging struct {
	n      int // its evaluation
	cancel context.CancelFunc
}

// Rejudge judges an attempts run's attempts again while it waits at its
// pick gate. It returns the evaluation as it starts; the rest happens in
// the background, one rerun at a time per run.
func (e *Engine) Rejudge(id string) (Evaluation, error) {
	if err := e.Open(); err != nil {
		return Evaluation{}, err
	}
	e.mu.Lock()
	x := e.active[id]
	e.mu.Unlock()
	if x == nil {
		s, ok := e.ix.get(id)
		if !ok {
			return Evaluation{}, ErrNotFound
		}
		if Terminal(s.Status) {
			return Evaluation{}, ErrDone
		}
		return Evaluation{}, ErrNotPicking
	}
	return x.rejudge()
}

// judgeStep is the run's judge step and its path.
func judgeStep(flow []Step) (Step, string, bool) {
	for i, s := range flow {
		if s.Kind == "judge" {
			return s, strconv.Itoa(i), true
		}
	}
	return Step{}, "", false
}

func (x *execution) rejudge() (Evaluation, error) {
	x.mu.Lock()
	if Terminal(x.run.Status) {
		x.mu.Unlock()
		return Evaluation{}, ErrDone
	}
	if x.run.Gate == nil || !x.run.Gate.Pick || x.holdJudging {
		x.mu.Unlock()
		return Evaluation{}, ErrNotPicking
	}
	// Busy until its evaluation has ended (it then only tidies up).
	if j := x.judging; j != nil && x.evalRunning(j.n) {
		x.mu.Unlock()
		return Evaluation{}, ErrJudging
	}
	s, path, ok := judgeStep(x.run.Flow)
	by := judgeBy(s)
	if !ok || by == "human" || len(x.run.Candidates) == 0 {
		x.mu.Unlock()
		return Evaluation{}, ErrNoJudge
	}
	n := 1
	for _, ev := range x.run.Evaluations {
		n = max(n, ev.N+1)
	}
	ev := Evaluation{N: n, Path: path + ".v" + strconv.Itoa(n), Status: Running, By: by, Rerun: true, Started: x.e.now().UTC()}
	if by == "agent" {
		ev.Agent = judgeAgent(s)
	}
	vars := copyVars(x.run.Vars)
	vars["run.id"] = x.run.ID
	ctx, cancel := context.WithCancel(x.ctx)
	j := &judging{n: n, cancel: cancel}
	x.judging = j
	x.judges.Add(1)
	// Kept at once, so a second request sees it running.
	x.putEvaluation(ev)
	x.mu.Unlock()

	x.record(Record{T: recEval, Eval: &ev}, true)
	x.putIndexAtGate()
	x.e.publish("run.judging", x.summary(), map[string]any{"evaluation": ev.N})
	go func() {
		defer x.judges.Done()
		x.runRejudge(ctx, s, vars, ev)
		cancel()
		x.mu.Lock()
		if x.judging == j {
			x.judging = nil
		}
		x.mu.Unlock()
	}()
	return ev, nil
}

// putIndexAtGate puts the run's summary in the index while it waits at its
// gate. Under x.mu, so it never lands after the gate's own status change.
func (x *execution) putIndexAtGate() {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.run.Status == WaitingGate && x.run.Gate != nil {
		x.e.ix.put(x.run.summary())
	}
}

// evalRunning reports whether evaluation n has not ended; x.mu is held.
func (x *execution) evalRunning(n int) bool {
	for _, ev := range x.run.Evaluations {
		if ev.N == n {
			return ev.Status == Running
		}
	}
	return false
}

// stopJudging ends a rerun in flight and waits for every one to return: a
// pick was made, or the run is ending (final: none may start after).
func (x *execution) stopJudging(final bool) {
	x.mu.Lock()
	x.holdJudging = true
	j := x.judging
	x.mu.Unlock()
	if j != nil {
		j.cancel()
	}
	x.judges.Wait()
	if !final {
		x.mu.Lock()
		x.holdJudging = false
		x.mu.Unlock()
	}
}

func (x *execution) runRejudge(ctx context.Context, s Step, vars map[string]string, ev Evaluation) {
	cands := x.candidates()
	if rf, ok := x.e.Host.(Refresher); ok {
		fresh := rf.Refresh(ctx, x.summary(), vars, cands)
		x.mu.Lock()
		for _, f := range fresh {
			for i := range x.run.Candidates {
				if c := &x.run.Candidates[i]; c.Index == f.Index {
					c.Diff, c.Summary, c.Head, c.Dirty = f.Diff, f.Summary, f.Head, f.Dirty
				}
			}
		}
		x.mu.Unlock()
		cands = x.candidates()
		for _, c := range cands {
			x.record(Record{T: recCandidate, Cand: &c}, false)
		}
	}
	prompt := JudgePrompt(vars["params.prompt"], ExpandText(s.Text, vars), cands)
	evaluate(s, prompt, cands, &ev, func(q Step, p string) (Result, error) {
		return x.ask(ctx, q, p, vars, cands), nil
	}, ev.Path)
	ev.Ended = x.e.now().UTC()
	if ctx.Err() != nil {
		ev.Status, ev.Source, ev.Winner, ev.Ranking, ev.Reasons = Failed, "", nil, nil, nil
		ev.Error, ev.Output = "stopped before the judge answered", "stopped before the judge answered"
	} else if ev.Status == Running {
		ev.Status = Succeeded
	}
	// The ranking first: an evaluation that has ended shows with it.
	if ctx.Err() == nil {
		x.rank(ev)
	}
	x.record(Record{T: recEval, Eval: &ev}, true)
	x.putIndexAtGate()
	x.e.publish("run.judged", x.summary(), map[string]any{"evaluation": ev.N, "evaluation_status": ev.Status, "source": ev.Source})
}

// ask asks a rerun's judge one question: a headless leaf, journaled for
// the timeline, outside the run's own steps (no budget gate opens while
// the pick gate is open).
func (x *execution) ask(ctx context.Context, q Step, path string, vars map[string]string, cands []Candidate) Result {
	select {
	case x.e.agents <- struct{}{}:
	case <-ctx.Done():
		return Result{Status: Cancelled, Err: "stopped"}
	}
	defer func() { <-x.e.agents }()
	x.mu.Lock()
	x.agents++
	x.mu.Unlock()
	sctx := &StepCtx{Run: x.summary(), Step: q, Path: path, Attempt: 1, IdemKey: idemKey(x.run.ID, path, 1), Vars: copyVars(vars),
		Candidates: append([]Candidate(nil), cands...)}
	started := &StepRun{ID: q.ID, Kind: q.Kind, Path: path, Status: Running, Attempt: 1, Started: x.e.now().UTC(), IdemKey: sctx.IdemKey}
	x.record(Record{T: recStarted, Path: path, Attempt: 1, Step: started}, true)
	res := x.e.Host.Leaf(ctx, sctx)
	if ctx.Err() != nil && res.Status != Succeeded {
		res.Status = Cancelled
		if res.Err == "" {
			res.Err = "stopped"
		}
	}
	if res.Status == "" {
		res.Status = Succeeded
	}
	x.finish(nil, sctx, q.ID, res, started)
	return res
}

// endStaleEvaluations ends the reruns berthd stopped in the middle of, as
// a run resumes: they failed, and can be run again.
func (x *execution) endStaleEvaluations() {
	x.mu.Lock()
	var stale []Evaluation
	for _, ev := range x.run.Evaluations {
		if ev.Status == Running {
			stale = append(stale, ev)
		}
	}
	x.mu.Unlock()
	now := x.e.now().UTC()
	for _, ev := range stale {
		for p, rec := range x.started {
			if ev.Path != "" && strings.HasPrefix(p, ev.Path+".") && rec.Step != nil {
				st := *rec.Step
				st.Status, st.Ended, st.Error = Cancelled, now, "berthd restarted"
				x.record(Record{T: recStepDone, Path: p, Step: &st}, false)
			}
		}
		ev.Status, ev.Ended = Failed, now
		ev.Error, ev.Output = "berthd restarted before the judge answered", "berthd restarted before the judge answered"
		x.record(Record{T: recEval, Eval: &ev}, true)
	}
}
