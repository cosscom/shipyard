package box

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/statefile"
)

// Flows are automations built from steps rather than shell scripts: when an
// event happens, run a check, prompt an agent, wait for it, start another,
// notify someone, or call a webhook, each step on the previous one's success
// or failure. They run on the box, so they keep going while the laptop
// sleeps. A box has its own flows, and a repository's config can carry flows
// for its own worktrees, layered like the rest of its config: committed in
// the repository, then its kit's, then this box's own, the most local flow
// with an id replacing the others.

type Flow struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Enabled bool    `json:"enabled"`
	Trigger Trigger `json:"trigger"`
	Steps   []Step  `json:"steps"`
	// MaxRunsPerHour stops a flow that keeps triggering itself, such as one
	// prompting the agent whose finishing started it. Zero means
	// DefaultMaxRunsPerHour.
	MaxRunsPerHour int `json:"max_runs_per_hour,omitempty"`
	// A trigger for a worktree where this flow's run is still going waits
	// for it: at most Queue of them (default 5). Coalesce merges new GitHub
	// items into the run already waiting instead, as {{event.items}}.
	Queue    int  `json:"queue,omitempty"`
	Coalesce bool `json:"coalesce,omitempty"`
}

// DefaultMaxRunsPerHour is how many times a flow may start in an hour when
// it doesn't say. The app's DEFAULT_MAX_RUNS_PER_HOUR (app/src/lib/flows.ts)
// shows the same number.
const DefaultMaxRunsPerHour = 20

// Trigger is what starts a flow, narrowed by Where: an event, a schedule,
// something happening on GitHub, or a signed POST to the box (Webhook).
// Exactly one is set.
type Trigger struct {
	Event string `json:"event,omitempty"`
	// Schedule is a cron expression (minute hour day month weekday) or a
	// shortcut like @daily, in the box's local time.
	Schedule string `json:"schedule,omitempty"`
	// EachWorktree runs a scheduled flow once per worktree matching Where,
	// rather than once at the repository's main checkout.
	EachWorktree bool           `json:"each_worktree,omitempty"`
	GitHub       *GitHubTrigger `json:"github,omitempty"`
	// Webhook starts the flow from POST /v1/triggers/<id>, signed with
	// the flow's secret (berth flows secret).
	Webhook *WebhookTrigger `json:"webhook,omitempty"`
	Where   Where           `json:"where,omitempty"`
}

// WebhookTrigger starts a flow from a signed POST: a CI job on the tailnet,
// or a Linear or Slack bridge you host.
type WebhookTrigger struct {
	// Worktree picks the worktree from a field of the posted JSON naming a
	// branch (default "branch"); without it the run is at the repository's
	// main checkout.
	BranchField string `json:"branch_field,omitempty"`
}

// GitHubTrigger watches the pull requests of a project's worktrees, or its
// issues.
type GitHubTrigger struct {
	// On is review_comment, pr_review, check_failed or pr_merged (a
	// worktree's pull request), or issue_labeled or issue_assigned (the
	// repository's open issues).
	On string `json:"on"`
	// Poll is how often to look, at least 1m; default 2m.
	Poll string `json:"poll,omitempty"`
	// Label is the label issue_labeled watches for.
	Label string `json:"label,omitempty"`
	// Assignee is who issue_assigned watches for; default @me, the account
	// gh is signed in as.
	Assignee string `json:"assignee,omitempty"`
}

var githubOns = map[string]bool{"review_comment": true, "pr_review": true, "check_failed": true, "pr_merged": true, "issue_labeled": true, "issue_assigned": true}

// Where narrows a trigger; empty fields match anything. Branch takes a
// trailing * for a prefix.
type Where struct {
	Location string `json:"location,omitempty"`
	Agent    string `json:"agent,omitempty"`
	Branch   string `json:"branch,omitempty"`
	// Author limits GitHub triggers to comments and reviews by these
	// logins, or by the repository's "collaborators" (owners, members and
	// collaborators); "*" is anyone. review_comment and pr_review default
	// to collaborators: anyone can comment on a public repository, and the
	// comment reaches an agent's prompt.
	Author []string `json:"author,omitempty"`
}

// Step is one action of a flow: a run's step (see internal/box/runs).
// The kinds flows always had keep their meaning:
//   - run: Command (in the event's worktree), Timeout
//   - prompt: Text, sent to the event's session or Session
//   - wait: For (states, default finished,waiting), Timeout, Session
//   - start_agent: Agent, Text (its prompt), NewWorktree + Name
//   - notify: Title, Text
//   - webhook: URL, Text (the JSON body; default the run's context)
//
// and flows may use every run step kind too: loop, gate, map, join, judge,
// if, sleep, pr, check, headless.
//
// When runs it on the previous step's "success" (default), "failure", or
// "always". Text fields take {{event.FIELD}}, {{worktree.path}},
// {{prev.output}}, {{prev.exit_code}} and {{steps.ID.output}}, filled in
// for each kind of field as flowtemplate.go describes: never as code.
type Step = runs.Step

// StepRun is what one step of a run did.
type StepRun = runs.StepRun

var flowID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

func validateTrigger(t Trigger) error {
	set := 0
	for _, on := range []bool{t.Event != "", t.Schedule != "", t.GitHub != nil, t.Webhook != nil} {
		if on {
			set++
		}
	}
	if set != 1 {
		return errors.New("a flow starts from exactly one of an event, a schedule, GitHub, or a webhook")
	}
	switch {
	case t.Event != "":
		if err := hooks.Validate([]hooks.Hook{{On: t.Event, Run: "x"}}); err != nil || strings.HasPrefix(t.Event, hooks.BeforePrefix) {
			return fmt.Errorf("%q is not an event to start from", t.Event)
		}
	case t.Schedule != "":
		if _, err := ParseCron(t.Schedule); err != nil {
			return err
		}
	case t.Webhook != nil:
		if f := t.Webhook.BranchField; f != "" && !regexp.MustCompile(`^[a-z_][a-z0-9_]{0,31}$`).MatchString(f) {
			return fmt.Errorf("webhook branch_field %q must be a plain field name", f)
		}
	default:
		if !githubOns[t.GitHub.On] {
			return fmt.Errorf("GitHub trigger %q must be review_comment, pr_review, check_failed, pr_merged, issue_labeled or issue_assigned", t.GitHub.On)
		}
		if t.GitHub.On == "issue_labeled" && strings.TrimSpace(t.GitHub.Label) == "" {
			return errors.New("issue_labeled needs a label")
		}
		if strings.ContainsAny(t.GitHub.Label+t.GitHub.Assignee, "\n\"") {
			return errors.New("label and assignee must be plain names")
		}
		if t.GitHub.Poll != "" {
			if d, err := time.ParseDuration(t.GitHub.Poll); err != nil || d < time.Minute {
				return fmt.Errorf("GitHub poll %q must be a duration of at least 1m", t.GitHub.Poll)
			}
		}
	}
	if t.EachWorktree && t.Schedule == "" {
		return errors.New("each_worktree only applies to scheduled flows")
	}
	if len(t.Where.Author) > 0 && t.GitHub == nil {
		return errors.New("where.author only applies to GitHub triggers")
	}
	for _, a := range t.Where.Author {
		if a != "*" && a != "collaborators" && !ghLogin.MatchString(strings.TrimPrefix(a, "@")) {
			return fmt.Errorf("author %q is not a GitHub login, \"collaborators\" or \"*\"", a)
		}
	}
	return nil
}

var ghLogin = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$`)

// ValidateFlows reports the first thing wrong with flows someone wrote.
func ValidateFlows(flows []Flow) error {
	seen := map[string]bool{}
	for _, f := range flows {
		if !flowID.MatchString(f.ID) {
			return fmt.Errorf("flow id %q must be lowercase letters, digits and dashes", f.ID)
		}
		if seen[f.ID] {
			return fmt.Errorf("two flows are called %s", f.ID)
		}
		seen[f.ID] = true
		if strings.TrimSpace(f.Name) == "" {
			return fmt.Errorf("flow %s needs a name", f.ID)
		}
		if err := validateTrigger(f.Trigger); err != nil {
			return fmt.Errorf("flow %s: %v", f.ID, err)
		}
		if len(f.Steps) == 0 {
			return fmt.Errorf("flow %s has no steps", f.ID)
		}
		if err := runs.ValidateSteps(f.Steps); err != nil {
			return fmt.Errorf("flow %s, %v", f.ID, err)
		}
		if f.Queue < 0 || f.Queue > 50 {
			return fmt.Errorf("flow %s: queue must be from 0 to 50", f.ID)
		}
	}
	return nil
}

// FlowRun is one run of a flow as the flows API shows it: a run of the
// "flow" template, read from the box's runs.
type FlowRun struct {
	ID       string       `json:"id"`
	Flow     string       `json:"flow"`
	Scope    string       `json:"scope"`
	Started  time.Time    `json:"started"`
	Finished time.Time    `json:"finished,omitzero"`
	Status   string       `json:"status"` // running, waiting_gate, queued, succeeded, failed, cancelled, interrupted, skipped
	Event    events.Event `json:"event"`
	Steps    []StepRun    `json:"steps"`
	Error    string       `json:"error,omitempty"`
	// Test is set for a run started from the app's Test run, not by its
	// trigger, so Runs can say so.
	Test bool `json:"test,omitempty"`
	// Usage is what its agents spent, where they report it.
	Usage *runs.Usage `json:"usage,omitempty"`
}

// Flows runs a box's flows and its repositories'.
type Flows struct {
	// Path is the box's own flows file, ~/.berth/flows.json.
	Path string
	// RunsPath is where runs were kept before runs were durable
	// (flow-runs.json); they are imported into the box's runs once.
	RunsPath string

	// GitHubPath keeps what GitHub flows have already seen.
	GitHubPath string
	// Now reads the clock; tests replace it.
	Now func() time.Time
	// AllowOutbound adds to the outbound allowlist in network.json beside
	// Path (see netguard.go); tests use it for their local servers.
	AllowOutbound []string
	// Logf is berthd's log: a flow reaching its runs-per-hour limit, and a
	// schedule that fires more often than its limit allows, are said there.
	Logf func(format string, args ...any)

	mu        sync.Mutex
	box       *Box
	rate      map[string]*flowRate // flow scope/id → its starts and refusals this hour
	warned    map[string]string    // scheduled flow → the schedule and limit its rate was last checked for
	lastFired map[string]time.Time // scheduled flow → minute it last fired
	lastPoll  map[string]time.Time // GitHub flow → when it last looked
	cursor    map[string]int       // GitHub flow → the target its next look starts at
	gh        map[string]*ghState  // GitHub flow + PR → what it has seen
}

// ScopedFlow is a flow with where it comes from.
type ScopedFlow struct {
	Scope string `json:"scope"` // "box" or "repo:<location>"
	// Source is "box", or for a repository's flow its layer: "repo"
	// (committed), "kit" (the location's kit) or "local" (this box's).
	Source   string `json:"source"`
	Editable bool   `json:"editable"`
	// Overridden is set on a flow a more local layer replaces with a flow of
	// the same id. It is listed so the app can show it, but never runs.
	Overridden bool `json:"overridden,omitempty"`
	Flow       Flow `json:"flow"`

	// RefusedLastHour is how many starts the runs-per-hour limit refused in
	// the last hour, the limit's own window; LastRefusedAt is the latest.
	// Both are kept in memory, like the window, so a restart clears them.
	RefusedLastHour int       `json:"refused_last_hour,omitempty"`
	LastRefusedAt   time.Time `json:"last_refused_at,omitzero"`
	// FiresPerHour is, for a scheduled flow, how often its schedule fires in
	// its busiest hour: times its worktrees for each_worktree, which share
	// the one limit. Warning says so when that is over the limit. Neither
	// stops the flow from saving or running.
	FiresPerHour int    `json:"fires_per_hour,omitempty"`
	Warning      string `json:"warning,omitempty"`

	// autofix is a worktree's "Auto-fix this PR" toggle acting as a flow:
	// the template it starts, for that worktree only.
	autofix *autoFlow
}

// key names a flow in its scope, as its rate window and run keys do:
// "box/<id>" or "repo:<location>/<id>".
func (sf ScopedFlow) key() string { return sf.Scope + "/" + sf.Flow.ID }

// flowSkipped tells the box's subscribers a start of sf was refused.
func (b *Box) flowSkipped(sf ScopedFlow, err error) {
	if b.Runs != nil {
		b.Runs.Host.Publish("flow.skipped", map[string]any{"flow": sf.Flow.ID, "scope": sf.Scope, "error": err.Error(), "run": ""})
	}
}

func (f *Flows) loadBox() ([]Flow, error) {
	var doc struct {
		Flows []Flow `json:"flows"`
	}
	b, err := os.ReadFile(f.Path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", f.Path, err)
	}
	return doc.Flows, nil
}

// SaveBox replaces the box's own flows.
func (f *Flows) SaveBox(flows []Flow) error {
	if err := ValidateFlows(flows); err != nil {
		return err
	}
	if flows == nil {
		flows = []Flow{}
	}
	b, err := json.MarshalIndent(map[string]any{"flows": flows}, "", "  ")
	if err != nil {
		return err
	}
	return statefile.Write(f.Path, append(b, '\n'))
}

// AllFlows lists every flow on the box: its own, then each repository's
// layers in the order its config merges them (committed, its kit's, this
// box's). A flow replaced by id in a more local layer is marked Overridden;
// ActiveFlows leaves those out.
func (b *Box) AllFlows(ctx context.Context) ([]ScopedFlow, error) {
	out := []ScopedFlow{}
	own, err := b.Flows.loadBox()
	if err != nil {
		return nil, err
	}
	for _, f := range own {
		out = append(out, ScopedFlow{Scope: "box", Source: "box", Editable: true, Flow: f})
	}
	locs, _ := b.Locations.List(ctx)
	for _, l := range locs {
		cfg, err := b.Locations.Config(ctx, l.Name)
		if err != nil {
			continue
		}
		scope, start := "repo:"+l.Name, len(out)
		add := func(source string, editable bool, flows []Flow) {
			for _, f := range flows {
				out = append(out, ScopedFlow{Scope: scope, Source: source, Editable: editable, Flow: f})
			}
		}
		if cfg.Repo != nil {
			add("repo", false, cfg.Repo.Flows)
		}
		if cfg.Kit != nil {
			add("kit", false, cfg.Kit.Config.Flows)
		}
		add("local", true, cfg.Local.Flows)
		// Like merge: a later layer's flow replaces an earlier one's by id.
		for i := start; i < len(out); i++ {
			for j := i + 1; j < len(out); j++ {
				if out[j].Flow.ID == out[i].Flow.ID {
					out[i].Overridden = true
				}
			}
		}
	}
	return out, nil
}

// ActiveFlows is the flows that run: AllFlows without the overridden ones,
// so each scope has at most one flow per id, and its run limit and schedule
// are its own.
func (b *Box) ActiveFlows(ctx context.Context) ([]ScopedFlow, error) {
	all, err := b.AllFlows(ctx)
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, sf := range all {
		if !sf.Overridden {
			out = append(out, sf)
		}
	}
	return out, nil
}

// Run follows the box's events and starts the flows they trigger.
//
// It reads the bus with a cursor, so a burst it is slow to match is caught
// up from the journal rather than lost.
func (f *Flows) Run(ctx context.Context, b *Box) {
	b.runsEngine(ctx)
	f.importRuns(b)
	go f.schedule(ctx, b)
	go f.watchGitHub(ctx, b)
	cur := b.Events.SubscribeFrom(-1).Named("flows")
	defer cur.Close()
	var cached []ScopedFlow
	var cachedAt time.Time
	for {
		e, err := cur.Next(ctx)
		if err != nil {
			return
		}
		// A flow's or run's own bookkeeping never starts flows, except a
		// run finishing or stopping at a gate.
		if strings.HasPrefix(e.Type, "flow.") || (strings.HasPrefix(e.Type, "run.") && e.Type != "run.finished" && e.Type != "run.gate") {
			continue
		}
		// Reading every repository's config per event is what made this
		// subscriber slow; a second-old copy is as good.
		if time.Since(cachedAt) > time.Second {
			all, err := b.ActiveFlows(ctx)
			if err != nil {
				continue
			}
			cached, cachedAt = all, time.Now()
		}
		for _, sf := range cached {
			if sf.Flow.Enabled && b.flowMatches(ctx, sf, e) {
				if _, err := b.startFlowRun(ctx, sf, e, flowStart{via: "event"}); err != nil {
					b.flowSkipped(sf, err)
				}
			}
		}
	}
}

// runsEngine is the box's run engine, made and resumed here when serve did
// not (tests, older embedders).
func (b *Box) runsEngine(ctx context.Context) *runs.Engine {
	runsInit.Lock()
	defer runsInit.Unlock()
	if b.Flows != nil {
		b.Flows.mu.Lock()
		b.Flows.box = b
		b.Flows.mu.Unlock()
	}
	if b.Runs == nil {
		dir := filepath.Join(os.TempDir(), "berth-runs")
		if b.Flows != nil && b.Flows.Path != "" {
			dir = filepath.Join(filepath.Dir(b.Flows.Path), "runs")
		}
		b.NewRuns(dir, 0, 0, nil)
		b.Runs.Resume(ctx)
	}
	return b.Runs
}

var runsInit sync.Mutex

// runsNow is b.Runs, read safely while runsEngine may be making it.
func (b *Box) runsNow() *runs.Engine {
	runsInit.Lock()
	defer runsInit.Unlock()
	return b.Runs
}

// importRuns moves the runs flow-runs.json kept into the box's durable
// runs, once. A run that was still going is imported as interrupted, as
// it could not resume: that is said with flow.interrupted.
func (f *Flows) importRuns(b *Box) {
	if f.RunsPath == "" {
		return
	}
	raw, err := os.ReadFile(f.RunsPath)
	if err != nil {
		return
	}
	var old []struct {
		FlowRun
		Steps []struct {
			ID       string    `json:"id"`
			Kind     string    `json:"kind"`
			Status   string    `json:"status"`
			Started  time.Time `json:"started"`
			Duration string    `json:"duration"`
			Output   string    `json:"output"`
			ExitCode int       `json:"exit_code"`
			Error    string    `json:"error"`
		} `json:"steps"`
	}
	if json.Unmarshal(raw, &old) != nil {
		return
	}
	var imported []runs.Run
	var cut []runs.Run
	for _, o := range old {
		r := runs.Run{ID: "f_" + o.ID, Template: "flow", Title: o.Flow, FlowID: o.Flow, Scope: o.Scope, Status: o.Status, Created: o.Started,
			Updated: o.Finished, Finished: o.Finished, Error: o.Error, Test: o.Test, Trigger: eventMap(o.Event), Steps: []runs.StepRun{}}
		r.Path, _ = o.Event.Data["path"].(string)
		for i, s := range o.Steps {
			r.Steps = append(r.Steps, runs.StepRun{ID: s.ID, Kind: s.Kind, Path: strconv.Itoa(i), Status: s.Status, Started: s.Started, Duration: s.Duration, Output: s.Output, ExitCode: s.ExitCode, Error: s.Error})
		}
		if !runs.Terminal(r.Status) {
			r.Status, r.Error = runs.Interrupted, "berthd restarted during this run, before runs could resume"
			if r.Finished.IsZero() {
				r.Finished = time.Now().UTC()
			}
			cut = append(cut, r)
		}
		if r.Updated.IsZero() {
			r.Updated = r.Created
		}
		imported = append(imported, r)
	}
	if _, err := b.Runs.Import(imported); err != nil {
		return
	}
	os.Rename(f.RunsPath, f.RunsPath+".imported")
	for _, r := range cut {
		b.Events.Publish(events.Event{Type: "flow.interrupted", Box: b.Name, Origin: "flow:" + r.FlowID, Data: map[string]any{"flow": r.FlowID, "scope": r.Scope, "run": r.ID, "status": "interrupted", "path": r.Path}})
	}
}

func eventMap(e events.Event) map[string]any {
	var m map[string]any
	b, _ := json.Marshal(e)
	json.Unmarshal(b, &m)
	return m
}

func (b *Box) flowMatches(ctx context.Context, sf ScopedFlow, e events.Event) bool {
	t := sf.Flow.Trigger
	if t.Event == "" || !hooks.Matches(hooks.Hook{On: t.Event, Run: "x"}, e) {
		return false
	}
	loc, wt, ok := b.eventScope(ctx, e.Data)
	if name, isRepo := strings.CutPrefix(sf.Scope, "repo:"); isRepo && (!ok || loc.Name != name) {
		return false
	}
	if t.Where.Location != "" && (!ok || loc.Name != t.Where.Location) {
		return false
	}
	if t.Where.Agent != "" {
		if a, _ := e.Data["agent"].(string); a != t.Where.Agent {
			return false
		}
	}
	if t.Where.Branch != "" {
		if !ok {
			return false
		}
		if p, prefix := strings.CutSuffix(t.Where.Branch, "*"); prefix {
			if !strings.HasPrefix(wt.Branch, p) {
				return false
			}
		} else if wt.Branch != t.Where.Branch {
			return false
		}
	}
	return true
}

// flowStart says how a flow's run is admitted.
type flowStart struct {
	// via is what started it, for the log: event, cron, github, webhook or
	// api.
	via  string
	test bool
	// idem dedupes a trigger delivered twice (github:<flow>:<pr>:<item>).
	idem string
	// item is the trigger's item, merged into a waiting run when the flow
	// coalesces.
	item map[string]any
}

// startFlowRun admits a run of a flow for event e: it starts, or waits
// behind the flow's run in the same worktree (bounded by the flow's queue),
// or merges into the one waiting when the flow coalesces. Nothing is
// skipped silently: a refusal is returned.
func (b *Box) startFlowRun(ctx context.Context, sf ScopedFlow, e events.Event, opt flowStart) (runs.Summary, error) {
	eng := b.runsEngine(context.Background())
	key := sf.key()
	loc, wt, scoped := b.eventScope(ctx, e.Data)
	if opt.idem != "" {
		// A delivery already admitted: not a new run, and not counted.
		for _, s := range eng.List(runs.Filter{Flow: sf.Flow.ID, Limit: 200}) {
			if s.IdemKey == opt.idem {
				return s, nil
			}
		}
	}
	var slot time.Time
	if !opt.test {
		var ok bool
		if slot, ok = b.Flows.allowRate(key, maxRunsPerHour(sf.Flow), opt.via); !ok {
			return runs.Summary{}, errRateLimited
		}
	}
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	vars := map[string]string{"event.type": e.Type, "event.box": e.Box, "event.origin": e.Origin, "now": time.Now().Format(time.RFC3339)}
	for k, v := range e.Data {
		vars["event."+k] = fmt.Sprint(v)
	}
	if scoped {
		vars["location"], vars["worktree.name"], vars["worktree.path"], vars["worktree.branch"] = loc.Name, wt.Name, wt.Path, wt.Branch
	}
	session, _ := e.Data["session"].(string)
	if session == "" && scoped {
		session = b.sessionIn(ctx, wt.Path)
	}
	vars["session"] = session
	req := runs.Request{Template: "flow", Title: sf.Flow.Name, Flow: sf.Flow.Steps, Vars: vars, Scope: sf.Scope, FlowID: sf.Flow.ID,
		Trigger: eventMap(e), Origin: "flow:" + sf.Flow.ID, Path: wt.Path, Test: opt.test, IdemKey: opt.idem,
		QueueLimit: sf.Flow.Queue, Coalesce: sf.Flow.Coalesce, Item: opt.item}
	if a := sf.autofix; a != nil {
		req.Template, req.Flow, req.Params, req.Title = a.template, nil, a.params(e, session), ""
	}
	if !opt.test {
		// One run at a time per flow and worktree; more wait their turn.
		req.Key = key + "@" + wt.Path
	}
	s, dup, err := eng.Start(req)
	switch {
	case slot.IsZero():
	case err != nil || dup:
		// Not started (a full queue, most often), or a delivery already
		// admitted: it doesn't count.
		b.Flows.releaseRate(key, slot)
	default:
		b.Flows.started(key)
	}
	return s, err
}

// runFlow runs a flow for one event and waits for the run to finish (or
// ctx to end): Test run, and tests.
func (b *Box) runFlow(ctx context.Context, sf ScopedFlow, e events.Event) FlowRun {
	s, err := b.startFlowRun(ctx, sf, e, flowStart{test: ctx.Value(testRun{}) == true})
	if err != nil {
		return FlowRun{Flow: sf.Flow.ID, Scope: sf.Scope, Status: "skipped", Error: err.Error(), Event: e, Steps: []StepRun{}}
	}
	eng := b.runsNow()
	for {
		r, err := eng.Get(s.ID)
		if err == nil && runs.Terminal(r.Status) {
			return flowRunOf(r)
		}
		select {
		case <-ctx.Done():
			return flowRunOf(r)
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// testRun marks the context of a run started by Test run.
type testRun struct{}

// flowRunOf shows a run as the flows API always has.
func flowRunOf(r runs.Run) FlowRun {
	fr := FlowRun{ID: r.ID, Flow: r.FlowID, Scope: r.Scope, Started: r.Created, Finished: r.Finished, Status: r.Status, Steps: r.Steps, Error: r.Error, Test: r.Test, Usage: r.Usage}
	if fr.Steps == nil {
		fr.Steps = []StepRun{}
	}
	if r.Trigger != nil {
		b, _ := json.Marshal(r.Trigger)
		json.Unmarshal(b, &fr.Event)
	}
	return fr
}

// Runs returns recent runs of the box's flows, newest first, optionally of
// one flow.
func (f *Flows) Runs(flow string, limit int) []FlowRun {
	b := flowsBox(f)
	if b == nil {
		return []FlowRun{}
	}
	eng := b.runsNow()
	if eng == nil {
		return []FlowRun{}
	}
	out := []FlowRun{}
	for _, s := range eng.List(runs.Filter{Template: "flow", Flow: flow, Limit: limit}) {
		r, err := eng.Get(s.ID)
		if err != nil {
			continue
		}
		fr := flowRunOf(r)
		switch fr.Status {
		case runs.Queued, runs.WaitingGate, runs.Paused:
			// Shown as running to older apps; Status says more to new ones.
		}
		out = append(out, fr)
	}
	return out
}

// flowsBox is the box whose flows f are.
func flowsBox(f *Flows) *Box {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.box
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

// sessionIn finds the agent session working in dir, if there is one.
func (b *Box) sessionIn(ctx context.Context, dir string) string {
	all, err := b.Sessions.List(ctx)
	if err != nil {
		return ""
	}
	for _, s := range b.enrich(ctx, all) {
		if samePath(s.Dir, dir) && s.Agent != "" && !s.Exited {
			return s.Name
		}
	}
	return ""
}

func stepTimeout(s Step, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(s.Timeout); err == nil && d > 0 {
		return min(d, 2*time.Hour)
	}
	return def
}

// flowEnv is a worktree's environment for a flow's commands, and the
// secret values in it, which nothing the flow sends or keeps may carry.
func (b *Box) flowEnv(ctx context.Context, location string, wt Worktree) (env, secrets []string) {
	p, err := b.worktreeEnv(ctx, location, wt)
	if err != nil {
		return nil, nil
	}
	values := b.resolveWorktreeSecrets(ctx, p.location, wt, p.refs, p.opEnv)
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	env = p.env
	for _, k := range keys {
		env = append(env, k+"="+values[k])
		secrets = append(secrets, values[k])
	}
	// Longest first, so one secret containing another is hidden whole.
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	return env, secrets
}

// awaitState waits for a session's agent to report one of states from now:
// from the next event on, in the journal's order.
func (b *Box) awaitState(ctx context.Context, session string, states []string, timeout time.Duration) (string, error) {
	want := map[string]bool{}
	for _, s := range states {
		want[s] = true
	}
	after := time.Now()
	afterSeq := b.Events.Head() + 1
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		var changed <-chan struct{}
		if b.Turns != nil {
			changed = b.Turns.Changed()
		}
		if sess, err := b.Sessions.Get(ctx, session); err == nil {
			s := b.enrich(ctx, []Session{sess})[0]
			if s.Exited {
				return "exited", errors.New(session + " has exited")
			}
			fresh := s.StateSince.After(after)
			if b.Events.Journal != nil || b.Events.Sequence {
				fresh = s.StateSeq >= afterSeq
			}
			if want[s.AgentState] && fresh {
				return s.AgentState, nil
			}
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("%s did not finish within %v", session, timeout)
		case <-changed:
		case <-tick.C:
		}
	}
}

// awaitTurn waits for a turn to end, or to wait for someone when states
// allow it.
func (b *Box) awaitTurn(ctx context.Context, id string, states []string, timeout time.Duration) (string, error) {
	untilWaiting := false
	for _, s := range states {
		untilWaiting = untilWaiting || s == "waiting"
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tr, timedOut, err := b.Turns.WaitTurn(ctx, id, untilWaiting)
	switch {
	case err != nil:
		return "", err
	case timedOut:
		return tr.State, fmt.Errorf("%s did not finish within %v", tr.Session, timeout)
	case tr.State == "exited":
		return "exited", errors.New(tr.Session + " has exited")
	}
	return tr.State, nil
}

func (b *Box) listFlows(w http.ResponseWriter, r *http.Request) error {
	all, err := b.AllFlows(r.Context())
	if err != nil {
		return err
	}
	k := &rateChecker{ctx: r.Context(), b: b}
	for i, sf := range all {
		if sf.Overridden {
			continue
		}
		all[i].RefusedLastHour, all[i].LastRefusedAt = b.Flows.refusals(sf.key())
		if rc := k.check(sf); rc.fires > 0 {
			all[i].FiresPerHour, all[i].Warning = rc.fires, rc.warning()
		}
	}
	writeJSON(w, all)
	return nil
}

func (b *Box) putFlows(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Flows []Flow `json:"flows"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	if err := b.before(r, "config.change", map[string]any{"flows": len(req.Flows)}); err != nil {
		return err
	}
	if err := b.Flows.SaveBox(req.Flows); err != nil {
		return badRequest("%v", err)
	}
	b.publish(r, "config.changed", map[string]any{"flows": len(req.Flows)})
	return b.listFlows(w, r)
}

// testFlow runs a flow now, as if its trigger had happened with the given
// event data (a worktree path, a session).
func (b *Box) testFlow(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Scope string         `json:"scope"`
		Data  map[string]any `json:"data"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	all, err := b.ActiveFlows(r.Context())
	if err != nil {
		return err
	}
	for _, sf := range all {
		if sf.Flow.ID == r.PathValue("id") && (req.Scope == "" || sf.Scope == req.Scope) {
			// A test run runs the flow's steps for real.
			if err := b.before(r, "flow.test", map[string]any{"flow": sf.Flow.ID, "scope": sf.Scope}); err != nil {
				return err
			}
			e := events.Event{Type: triggerType(sf.Flow.Trigger), Box: b.Name, Origin: origin(r), Time: time.Now(), Data: req.Data}
			// It answers when the run ends, or with the run as it stands
			// when the app stops waiting; the run goes on either way.
			run := b.runFlow(context.WithValue(r.Context(), testRun{}, true), sf, e)
			writeJSON(w, run)
			return nil
		}
	}
	return httpError{http.StatusNotFound, "no flow with that id"}
}

const maxFlowRuns = 200

func (b *Box) listFlowRuns(w http.ResponseWriter, r *http.Request) error {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > maxFlowRuns {
		limit = 50
	}
	writeJSON(w, b.Flows.Runs(r.URL.Query().Get("flow"), limit))
	return nil
}

// FlowsAt keeps a box's flows in userDir and their runs in stateDir.
func FlowsAt(userDir, stateDir string) *Flows {
	return &Flows{Path: filepath.Join(userDir, "flows.json"), RunsPath: filepath.Join(stateDir, "flow-runs.json"), GitHubPath: filepath.Join(stateDir, "flow-github.json")}
}
