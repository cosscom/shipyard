package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// The judge ranks an attempts run's candidates. It never sees transcripts
// or whole diffs: each candidate is one line of diffstat and check status
// and its last commit subjects, and the judge reads the worktrees itself if
// it must. That keeps its prompt near 2 KB for three attempts.

// Verdict is what an agent judge must answer, as JSON.
type Verdict struct {
	Winner  int               `json:"winner"`
	Ranking []int             `json:"ranking"`
	Reasons map[string]string `json:"reasons"`
}

// JudgePrompt is the judge's prompt. Candidates are numbered from 1.
func JudgePrompt(task, criteria string, cands []Candidate) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Judge %d attempts at one task. Read-only: do not edit or run anything that changes files.\n", len(cands))
	if task != "" {
		fmt.Fprintf(&b, "Task: %s\n", clip(task, 300))
	}
	if criteria != "" {
		fmt.Fprintf(&b, "Criteria: %s\n", clip(criteria, 300))
	}
	b.WriteString("Attempts (read a worktree only if the summary is not enough):\n")
	for _, c := range cands {
		check := "check failed"
		if c.Verify.Passed {
			check = "check passed"
		}
		if c.Verify.Rounds > 0 {
			check += fmt.Sprintf(" in %d round(s)", c.Verify.Rounds)
		}
		fmt.Fprintf(&b, "%d. %s at %s: %s; %d files +%d -%d, %d commits.", c.Index+1, c.Agent, c.Path, check, c.Diff.Files, c.Diff.Added, c.Diff.Removed, c.Diff.Commits)
		if c.Summary != "" {
			fmt.Fprintf(&b, " Commits: %s", clip(c.Summary, 300))
		}
		b.WriteString("\n")
	}
	b.WriteString(`Reply with JSON only: {"winner": N, "ranking": [N, ...], "reasons": {"N": "one line"}}`)
	return b.String()
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// ParseVerdict reads a judge's reply: the JSON object in it, checked
// against the schema for n candidates (numbered from 1).
func ParseVerdict(out string, n int) (Verdict, error) {
	i, j := strings.Index(out, "{"), strings.LastIndex(out, "}")
	if i < 0 || j < i {
		return Verdict{}, fmt.Errorf("no JSON object in the reply")
	}
	var raw struct {
		Winner  any            `json:"winner"`
		Ranking []any          `json:"ranking"`
		Reasons map[string]any `json:"reasons"`
	}
	if err := json.Unmarshal([]byte(out[i:j+1]), &raw); err != nil {
		return Verdict{}, fmt.Errorf("the reply is not JSON: %v", err)
	}
	num := func(v any) (int, bool) {
		switch t := v.(type) {
		case float64:
			return int(t), t == float64(int(t))
		case string:
			k, err := strconv.Atoi(strings.TrimSpace(t))
			return k, err == nil
		}
		return 0, false
	}
	var v Verdict
	w, ok := num(raw.Winner)
	if !ok || w < 1 || w > n {
		return Verdict{}, fmt.Errorf("winner must be a number from 1 to %d", n)
	}
	v.Winner = w
	seen := map[int]bool{}
	for _, r := range raw.Ranking {
		k, ok := num(r)
		if !ok || k < 1 || k > n || seen[k] {
			return Verdict{}, fmt.Errorf("ranking must list attempts 1 to %d once each", n)
		}
		seen[k] = true
		v.Ranking = append(v.Ranking, k)
	}
	if len(v.Ranking) == 0 {
		v.Ranking = []int{w}
	}
	v.Reasons = map[string]string{}
	for k, r := range raw.Reasons {
		v.Reasons[k] = clip(fmt.Sprint(r), 300)
	}
	return v, nil
}

// byCheck picks the passing candidate with the smallest diff.
func byCheck(cands []Candidate) (int, bool) {
	best := -1
	for i, c := range cands {
		if !c.Verify.Passed {
			continue
		}
		if best < 0 || c.Diff.Added+c.Diff.Removed < cands[best].Diff.Added+cands[best].Diff.Removed {
			best = i
		}
	}
	if best < 0 {
		return 0, false
	}
	return cands[best].Index, true
}

// judgeBy is how a judge step judges: its by, else an agent when it names
// one, else the checks.
func judgeBy(s Step) string {
	if s.By != "" {
		return s.By
	}
	if s.Agent != "" {
		return "agent"
	}
	return "check"
}

func judgeAgent(s Step) string {
	if s.Agent == "" {
		return "claude"
	}
	return s.Agent
}

// asker asks the judge agent one question at path. The run's own judge
// journals it as a leaf step; a rerun asks beside the waiting gate.
type asker func(q Step, path string) (Result, error)

// evaluate judges cands into ev: by the checks, or by asking the judge
// agent at at+".ask" (once more when its reply is not valid, then the
// checks stand in, and ev says so). The error is the run's own, never the
// judge's.
func evaluate(s Step, prompt string, cands []Candidate, ev *Evaluation, ask asker, at string) error {
	ev.Versions = versionsOf(cands)
	if ev.By == "check" {
		if w, ok := byCheck(cands); ok {
			ev.Status, ev.Source, ev.Winner = Succeeded, "checks", &w
			ev.Output = fmt.Sprintf("attempt %d: its check passed with the smallest diff", w+1)
		} else {
			ev.Status, ev.Error, ev.Output = Failed, "no attempt passed its check", "no attempt passed its check"
		}
		return nil
	}
	q := Step{ID: s.ID, Kind: "headless", Agent: ev.Agent, Text: prompt, Timeout: s.Timeout, Diff: s.Diff}
	if q.ID == "" {
		q.ID = "judge"
	}
	if q.Timeout == "" {
		q.Timeout = "20m"
	}
	var usage Usage
	r, err := ask(q, at+".ask")
	if err != nil {
		return err
	}
	usage.Add(r.Usage)
	v, perr := ParseVerdict(r.Out, len(cands))
	if perr != nil && r.ok() {
		// Once more, saying what was wrong; never the whole prompt again
		// in other words: the agent's own session already has it when
		// it can resume, and the retry is short.
		q.Text = prompt + "\nYour last reply was not valid (" + perr.Error() + "). Reply with the JSON object only."
		if r, err = ask(q, at+".ask2"); err != nil {
			return err
		}
		usage.Add(r.Usage)
		v, perr = ParseVerdict(r.Out, len(cands))
	}
	if usage.Tokens() > 0 || usage.USD > 0 {
		ev.Usage = &usage
	}
	if perr != nil {
		why := "the judge's reply was not valid (" + perr.Error() + ")"
		if !r.ok() {
			why = "the judge gave no answer"
			if r.Err != "" {
				why += " (" + firstLine(r.Err, 200) + ")"
			}
		}
		ev.Status, ev.Error, ev.Output = Failed, why, why
		if w, ok := byCheck(cands); ok {
			// The checks stand in, and say so.
			ev.Source, ev.Winner = "checks", &w
			ev.Output = fmt.Sprintf("%s; by the checks, attempt %d", why, w+1)
		}
		return nil
	}
	w := v.Winner - 1
	ev.Status, ev.Source, ev.Winner = Succeeded, "judge", &w
	for _, k := range v.Ranking {
		ev.Ranking = append(ev.Ranking, k-1)
	}
	for k, reason := range v.Reasons {
		if n, err := strconv.Atoi(strings.TrimSpace(k)); err == nil && n >= 1 && n <= len(cands) {
			if ev.Reasons == nil {
				ev.Reasons = map[int]string{}
			}
			ev.Reasons[n-1] = reason
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Winner: attempt %d.", v.Winner)
	if r := v.Reasons[strconv.Itoa(v.Winner)]; r != "" {
		b.WriteString(" " + r)
	}
	ev.Output = b.String()
	return nil
}

// rank puts an evaluation's ranking and reasons on the candidates, as
// Review shows them: one without a verdict leaves them unranked.
func (x *execution) rank(ev Evaluation) {
	x.mu.Lock()
	for i := range x.run.Candidates {
		c := &x.run.Candidates[i]
		c.Judge.Rank, c.Judge.Reason = 0, ""
		if ev.Source != "judge" {
			continue
		}
		c.Judge.Reason = ev.Reasons[c.Index]
		for rank, k := range ev.Ranking {
			if k == c.Index {
				c.Judge.Rank = rank + 1
			}
		}
	}
	ranked := append([]Candidate(nil), x.run.Candidates...)
	x.mu.Unlock()
	for _, c := range ranked {
		x.record(Record{T: recCandidate, Cand: &c}, false)
	}
}

// candidates is a copy of the run's candidates, by index.
func (x *execution) candidates() []Candidate {
	x.mu.Lock()
	cands := append([]Candidate(nil), x.run.Candidates...)
	x.mu.Unlock()
	sort.Slice(cands, func(i, j int) bool { return cands[i].Index < cands[j].Index })
	return cands
}

// latestWinner is the winner of the last evaluation that ended, if it
// has one.
func (x *execution) latestWinner() (int, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	return latestWinnerOf(x.run.Evaluations)
}

func latestWinnerOf(evs []Evaluation) (int, bool) {
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].Status == Running {
			continue
		}
		if evs[i].Winner == nil {
			return 0, false
		}
		return *evs[i].Winner, true
	}
	return 0, false
}

func (x *execution) judge(ctx context.Context, sc *scope, s Step, id, path string) (Result, error) {
	start := x.structuralStart(id, "judge", path)
	cands := x.candidates()
	if len(cands) == 0 {
		return x.finishStructural(id, "judge", path, start, Result{Status: Failed, Err: "no candidates to judge"}), nil
	}
	by := judgeBy(s)
	set := map[string]string{}
	res := Result{Status: Succeeded, Set: set}
	if by == "human" {
		res.Out = "a person picks"
		return x.finishStructural(id, "judge", path, start, res), nil
	}
	// Replayed after a restart, the judge's answers come from the journal,
	// and its evaluation (and any reruns after it) is already there.
	x.mu.Lock()
	replayed := len(x.run.Evaluations) > 0
	x.mu.Unlock()
	ev := Evaluation{N: 1, Path: path, Status: Running, By: by, Started: start}
	if by == "agent" {
		ev.Agent = judgeAgent(s)
	}
	prompt := JudgePrompt(sc.vars["params.prompt"], ExpandText(s.Text, sc.vars), cands)
	err := evaluate(s, prompt, cands, &ev, func(q Step, p string) (Result, error) {
		return x.leaf(ctx, sc, q, id, p)
	}, path)
	if err != nil {
		return Result{Status: Failed}, err
	}
	ev.Ended = x.e.now().UTC()
	if !replayed && !x.stopping() {
		x.record(Record{T: recEval, Eval: &ev}, false)
		x.rank(ev)
	}
	winner := -1
	if ev.Winner != nil {
		winner = *ev.Winner
		res.Out = ev.Output
	} else {
		res.Status, res.Err, res.Out = Failed, ev.Error, ev.Output
	}
	if winner >= 0 {
		set["judge.winner"] = strconv.Itoa(winner)
		var wc Candidate
		for _, c := range cands {
			if c.Index == winner {
				wc = c
			}
		}
		// Taken without a person only when its check passed.
		if s.Pick && wc.Verify.Passed {
			x.pick(sc, winner, set)
		}
	}
	return x.finishStructural(id, "judge", path, start, res), nil
}
