// Package runs is berth's durable orchestration: a run is a flow of steps
// (a loop, a fan-out, a gate, a judge) that the box executes and journals,
// so it keeps going while the laptop sleeps and picks up where it was after
// berthd restarts.
//
// A run's journal ($BERTH_HOME/box/runs/<id>.jsonl) records each step's
// start and result. Resuming re-executes the run's steps from the top: a
// step with a recorded result returns it without running again, so control
// flow (loops, branches, map items) replays exactly, and only the step that
// was in flight follows its kind's re-entry rule (see Reenter in Host).
//
// The package knows nothing about tmux, git or agents. Leaf steps (run a
// command, prompt an agent, start one) are done by a Host, which the box
// implements; the engine owns control flow, the journal, admission,
// concurrency, budgets, gates and timers.
package runs

import (
	"encoding/json"
	"time"
)

// Step is one step of a run. It is the flow step of flows.json, extended:
// every field a flow step had keeps its meaning, so existing flows run
// unchanged. Kind picks which fields matter:
//
//   - run, check: Command (in the scope's worktree), Timeout
//   - prompt: Text, sent to Session or the scope's session; When "idle"
//     holds it until the agent is idle (Deliver)
//   - wait: For, Timeout, Session (waits on the last prompt's turn)
//   - start_agent: Agent, Text, NewWorktree + Name + Base, Location,
//     Headless, Handoff
//   - headless: Agent, Text, Timeout: one non-interactive agent turn in
//     tmux, returning its final message (judges, reviewers)
//   - notify: Title, Text; webhook: URL, Text
//   - loop: Max, Steps, Until
//   - map: Items, Concurrency, Mode, Steps; join: Mode
//   - if: Cond, Steps, Else
//   - gate: Title, Text, Timeout, OnTimeout, Who, Pick
//   - sleep: Duration
//   - judge: By, Agent, Text (criteria), Diff
//   - collect: what an attempt did (diffstat, check, turns)
//   - handoff: builds a handoff packet for the next start_agent
//   - pr: Draft, Title, Text (body)
//   - cleanup: Mode archive-losers
type Step struct {
	ID          string   `json:"id,omitempty"`
	Kind        string   `json:"kind"`
	When        string   `json:"when,omitempty"`
	Command     string   `json:"command,omitempty"`
	Text        string   `json:"text,omitempty"`
	Title       string   `json:"title,omitempty"`
	Session     string   `json:"session,omitempty"`
	For         []string `json:"for,omitempty"`
	Agent       string   `json:"agent,omitempty"`
	NewWorktree bool     `json:"new_worktree,omitempty"`
	// Model and Effort, for start_agent: the agent's model and effort by
	// the CLI's own names; empty is its default.
	Model   string `json:"model,omitempty"`
	Effort  string `json:"effort,omitempty"`
	Name    string `json:"name,omitempty"`
	URL     string `json:"url,omitempty"`
	Timeout string `json:"timeout,omitempty"`

	// Deliver "idle" holds a prompt in the agent's inbox until it is idle.
	Deliver string `json:"deliver,omitempty"`
	// Base and Location place a new worktree.
	Base     string `json:"base,omitempty"`
	Location string `json:"location,omitempty"`
	// Headless runs the agent non-interactively, inside tmux.
	Headless bool `json:"headless,omitempty"`
	// Handoff writes the handoff packet into the new worktree first.
	Handoff bool `json:"handoff,omitempty"`
	// Native forks or resumes the source agent's own conversation when it
	// is the same vendor on the same box.
	Native bool `json:"native,omitempty"`

	Max   int    `json:"max,omitempty"`
	Steps []Step `json:"steps,omitempty"`
	Else  []Step `json:"else,omitempty"`
	Until string `json:"until,omitempty"`
	Cond  string `json:"cond,omitempty"`

	// Items is a list (strings or objects) or a {{var}} whose lines are
	// the items.
	Items       json.RawMessage `json:"items,omitempty"`
	Concurrency int             `json:"concurrency,omitempty"`
	Mode        string          `json:"mode,omitempty"`

	OnTimeout string `json:"on_timeout,omitempty"`
	Who       string `json:"who,omitempty"`
	Pick      bool   `json:"pick,omitempty"`
	Duration  string `json:"duration,omitempty"`

	By   string `json:"by,omitempty"`
	Diff bool   `json:"diff,omitempty"`

	Draft bool `json:"draft,omitempty"`
}

// Budget caps a run. Over budget, the run pauses at a gate: approving goes
// on without that cap, rejecting fails the run.
type Budget struct {
	MaxRounds int     `json:"max_rounds,omitempty"`
	MaxAgents int     `json:"max_agents,omitempty"`
	MaxWall   string  `json:"max_wall,omitempty"`
	MaxUSD    float64 `json:"max_usd,omitempty"`
	MaxTokens int64   `json:"max_tokens,omitempty"`
}

// Usage is what agents spent, where their adapter reports it.
type Usage struct {
	Input      int64   `json:"input,omitempty"`
	Output     int64   `json:"output,omitempty"`
	CacheRead  int64   `json:"cache_read,omitempty"`
	CacheWrite int64   `json:"cache_write,omitempty"`
	USD        float64 `json:"usd,omitempty"`
}

// Tokens is every token counted.
func (u *Usage) Tokens() int64 {
	if u == nil {
		return 0
	}
	return u.Input + u.Output + u.CacheRead + u.CacheWrite
}

// Add adds o to u.
func (u *Usage) Add(o *Usage) {
	if o == nil {
		return
	}
	u.Input += o.Input
	u.Output += o.Output
	u.CacheRead += o.CacheRead
	u.CacheWrite += o.CacheWrite
	u.USD += o.USD
}

// Candidate is one attempt of an attempts run.
type Candidate struct {
	Index    int    `json:"index"`
	Agent    string `json:"agent,omitempty"`
	Location string `json:"location,omitempty"`
	Worktree string `json:"worktree,omitempty"`
	Path     string `json:"path,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Session  string `json:"session,omitempty"`
	Verify   struct {
		Passed   bool   `json:"passed"`
		Rounds   int    `json:"rounds,omitempty"`
		ExitCode int    `json:"exit_code"`
		Tail     string `json:"tail,omitempty"`
	} `json:"verify"`
	Diff struct {
		Files   int `json:"files"`
		Added   int `json:"added"`
		Removed int `json:"removed"`
		Commits int `json:"commits"`
	} `json:"diff"`
	Summary string `json:"summary,omitempty"`
	// Head and Dirty are the worktree's version when Diff was counted: its
	// HEAD commit, and whether it had changes not committed yet.
	Head   string `json:"head,omitempty"`
	Dirty  bool   `json:"dirty,omitempty"`
	Turns  int    `json:"turns,omitempty"`
	Tokens *Usage `json:"tokens,omitempty"`
	Judge  struct {
		Rank   int    `json:"rank,omitempty"`
		Reason string `json:"reason,omitempty"`
	} `json:"judge"`
	Picked bool `json:"picked,omitempty"`
}

// Evaluation is one time an attempts run's attempts were judged.
type Evaluation struct {
	N int `json:"n"`
	// Path is where its steps are in the run's step tree.
	Path string `json:"path,omitempty"`
	// Status is running, succeeded (it has a winner) or failed: the judge
	// gave no valid verdict, or no attempt could win.
	Status string `json:"status"`
	// By is agent (a judge agent) or check (the checks alone).
	By    string `json:"by"`
	Agent string `json:"agent,omitempty"`
	// Rerun is set when someone asked for it after the run's own judge.
	Rerun   bool      `json:"rerun,omitempty"`
	Started time.Time `json:"started"`
	Ended   time.Time `json:"ended,omitzero"`
	// Source is where Winner came from: "judge", the agent's verdict, or
	// "checks", the passing attempt with the smallest diff (by check, or
	// standing in for a judge whose reply was not valid).
	Source string `json:"source,omitempty"`
	// Winner is a candidate index; Ranking is candidate indexes, best
	// first; Reasons is the judge's line for each candidate index.
	Winner  *int           `json:"winner,omitempty"`
	Ranking []int          `json:"ranking,omitempty"`
	Reasons map[int]string `json:"reasons,omitempty"`
	// Output is the line Review shows; Error is what went wrong.
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
	// Versions are the worktrees as the judge saw them.
	Versions []Version `json:"versions,omitempty"`
	Usage    *Usage    `json:"usage,omitempty"`
}

// Fallback reports whether the winner is the checks' pick standing in for
// a judge whose reply was not valid.
func (ev Evaluation) Fallback() bool { return ev.By == "agent" && ev.Source == "checks" }

// Version is one attempt's worktree as a judge saw it.
type Version struct {
	Index   int    `json:"index"`
	Head    string `json:"head,omitempty"`
	Dirty   bool   `json:"dirty,omitempty"`
	Files   int    `json:"files"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Commits int    `json:"commits"`
	Passed  bool   `json:"passed"`
}

func versionsOf(cands []Candidate) []Version {
	out := make([]Version, 0, len(cands))
	for _, c := range cands {
		out = append(out, Version{Index: c.Index, Head: c.Head, Dirty: c.Dirty, Files: c.Diff.Files, Added: c.Diff.Added,
			Removed: c.Diff.Removed, Commits: c.Diff.Commits, Passed: c.Verify.Passed})
	}
	return out
}

// Gate is a gate a run waits at.
type Gate struct {
	Path     string    `json:"path"`
	Title    string    `json:"title"`
	Text     string    `json:"text,omitempty"`
	Deadline time.Time `json:"deadline,omitzero"`
	Pick     bool      `json:"pick,omitempty"`
	// Default is the candidate a pick approves without naming one.
	Default int `json:"default,omitempty"`
	// ApproveLabel and RejectLabel name the two ways on when they are not
	// approve and reject: "Retry publishing" and "Finish without a pull
	// request" at a pull request that didn't open.
	ApproveLabel string `json:"approve_label,omitempty"`
	RejectLabel  string `json:"reject_label,omitempty"`
}

// Decision decides a gate.
type Decision struct {
	Approve bool   `json:"approve"`
	Note    string `json:"note,omitempty"`
	By      string `json:"by,omitempty"`
	// Pick names the winning candidate (0-based) at a pick gate.
	Pick *int `json:"pick,omitempty"`
	// Timeout is set when the gate's deadline decided it.
	Timeout bool `json:"timeout,omitempty"`
}

// Run is one run.
type Run struct {
	ID       string            `json:"id"`
	Template string            `json:"template"`
	Title    string            `json:"title,omitempty"`
	Flow     []Step            `json:"flow"`
	Params   map[string]any    `json:"params,omitempty"`
	Scope    string            `json:"scope,omitempty"`
	FlowID   string            `json:"flow_id,omitempty"`
	Trigger  map[string]any    `json:"trigger,omitempty"`
	IdemKey  string            `json:"idem_key,omitempty"`
	Key      string            `json:"key,omitempty"`
	Group    string            `json:"group,omitempty"`
	Parent   string            `json:"parent,omitempty"`
	Status   string            `json:"status"`
	Cursor   string            `json:"cursor,omitempty"`
	Vars     map[string]string `json:"vars,omitempty"`
	Steps    []StepRun         `json:"steps"`
	Budget   *Budget           `json:"budget,omitempty"`
	Origin   string            `json:"origin,omitempty"`
	Path     string            `json:"path,omitempty"`
	Test     bool              `json:"test,omitempty"`
	Created  time.Time         `json:"created"`
	Updated  time.Time         `json:"updated"`
	Finished time.Time         `json:"finished,omitzero"`
	Error    string            `json:"error,omitempty"`
	Usage    *Usage            `json:"usage,omitempty"`
	Gate     *Gate             `json:"gate,omitempty"`
	// Candidates are an attempts run's attempts.
	Candidates []Candidate `json:"candidates,omitempty"`
	// Evaluations are each time the judge ranked the attempts, oldest
	// first: the judge step's, then each rerun's. The last is current.
	Evaluations []Evaluation `json:"evaluations,omitempty"`
	// Coalesced counts trigger items merged into this run while queued.
	Coalesced int `json:"coalesced,omitempty"`
}

// StepRun is what one step did. Loop rounds and map items are Children.
type StepRun struct {
	ID       string    `json:"id"`
	Kind     string    `json:"kind"`
	Path     string    `json:"path"`
	Status   string    `json:"status"` // running, succeeded, failed, skipped, waiting, unknown, cancelled
	Attempt  int       `json:"attempt,omitempty"`
	Started  time.Time `json:"started,omitzero"`
	Ended    time.Time `json:"ended,omitzero"`
	Duration string    `json:"duration,omitempty"`
	Output   string    `json:"output,omitempty"`
	ExitCode int       `json:"exit_code"`
	Error    string    `json:"error,omitempty"`
	Turn     string    `json:"turn,omitempty"`
	Session  string    `json:"session,omitempty"`
	IdemKey  string    `json:"idem_key,omitempty"`
	Usage    *Usage    `json:"usage,omitempty"`
	Children []StepRun `json:"children,omitempty"`
}

// Statuses.
const (
	Queued      = "queued"
	Running     = "running"
	WaitingGate = "waiting_gate"
	Paused      = "paused"
	Succeeded   = "succeeded"
	Failed      = "failed"
	Cancelled   = "cancelled"
	// Skipped, for a leaf step, is one that chose not to act (a pull
	// request on a host without them): the run goes on as on success.
	Skipped     = "skipped"
	Interrupted = "interrupted"
)

// Terminal reports whether a run with status s is over.
func Terminal(s string) bool {
	switch s {
	case Succeeded, Failed, Cancelled, Interrupted:
		return true
	}
	return false
}

// Summary is a run as the index and lists keep it.
type Summary struct {
	ID       string    `json:"id"`
	Template string    `json:"template"`
	Title    string    `json:"title,omitempty"`
	FlowID   string    `json:"flow_id,omitempty"`
	Scope    string    `json:"scope,omitempty"`
	Status   string    `json:"status"`
	Key      string    `json:"key,omitempty"`
	IdemKey  string    `json:"idem_key,omitempty"`
	Group    string    `json:"group,omitempty"`
	Parent   string    `json:"parent,omitempty"`
	Origin   string    `json:"origin,omitempty"`
	Path     string    `json:"path,omitempty"`
	Session  string    `json:"session,omitempty"`
	Cursor   string    `json:"cursor,omitempty"`
	Test     bool      `json:"test,omitempty"`
	Created  time.Time `json:"created"`
	Updated  time.Time `json:"updated"`
	Finished time.Time `json:"finished,omitzero"`
	Error    string    `json:"error,omitempty"`
	Usage    *Usage    `json:"usage,omitempty"`
	Gate     *Gate     `json:"gate,omitempty"`
	Steps    int       `json:"steps,omitempty"`
	// Candidates is how many attempts an attempts run has.
	Candidates int `json:"candidates,omitempty"`
}

func (r *Run) summary() Summary {
	s := Summary{ID: r.ID, Template: r.Template, Title: r.Title, FlowID: r.FlowID, Scope: r.Scope, Status: r.Status, Key: r.Key,
		IdemKey: r.IdemKey, Group: r.Group, Parent: r.Parent, Origin: r.Origin, Path: r.Path, Cursor: r.Cursor, Test: r.Test,
		Created: r.Created, Updated: r.Updated, Finished: r.Finished, Error: r.Error, Gate: r.Gate, Steps: len(r.Steps), Candidates: len(r.Candidates)}
	if r.Usage != nil {
		u := *r.Usage
		s.Usage = &u
	}
	if r.Vars != nil {
		s.Session = r.Vars["session"]
	}
	return s
}
