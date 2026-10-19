package box

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/cosscom/shipyard/internal/box/runs"
)

// The runs API:
//
//	POST /v1/runs                         {template, params} | {flow} | {flow_id, scope, data}; Idempotency-Key
//	GET  /v1/runs?status=&template=&flow=&group=&limit=
//	GET  /v1/runs/templates
//	GET  /v1/runs/{id}                    with steps, gates and candidates
//	GET  /v1/runs/{id}/events?since=N     its journal from record N, then live (NDJSON)
//	POST /v1/runs/{id}/cancel
//	POST /v1/runs/{id}/gates/{step}/decide {approve, note, pick}; step "current" is the open one
//	POST /v1/runs/{id}/judge              an attempts run at its pick: judge the attempts again, as they are now

// RunRequest starts a run.
type RunRequest struct {
	Template string         `json:"template,omitempty"`
	Params   map[string]any `json:"params,omitempty"`
	Title    string         `json:"title,omitempty"`
	// Flow is ad-hoc steps instead of a template.
	Flow []runs.Step `json:"flow,omitempty"`
	// FlowID (with Scope) runs one of the box's configured flows now, with
	// Data as its event's data.
	FlowID string         `json:"flow_id,omitempty"`
	Scope  string         `json:"scope,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
	// Session and Path set the scope of ad-hoc steps.
	Session string       `json:"session,omitempty"`
	Path    string       `json:"path,omitempty"`
	Group   string       `json:"group,omitempty"`
	Parent  string       `json:"parent,omitempty"`
	Budget  *runs.Budget `json:"budget,omitempty"`
	// IdemKey is the Idempotency-Key, for callers that cannot send headers
	// (the app, through the laptop's agent).
	IdemKey string `json:"idem_key,omitempty"`
}

func (b *Box) runsOrNotFound() (*runs.Engine, error) {
	if b.Runs == nil {
		return nil, httpError{http.StatusNotFound, "this box does not run durable runs"}
	}
	return b.Runs, nil
}

func runErr(err error) error {
	switch {
	case errors.Is(err, runs.ErrNotFound):
		return httpError{http.StatusNotFound, err.Error()}
	case errors.Is(err, runs.ErrNoGate), errors.Is(err, runs.ErrDone), errors.Is(err, runs.ErrQueueFull),
		errors.Is(err, runs.ErrNotPicking), errors.Is(err, runs.ErrJudging), errors.Is(err, runs.ErrNoJudge):
		return httpError{http.StatusConflict, err.Error()}
	}
	return err
}

func (b *Box) startRun(w http.ResponseWriter, r *http.Request) error {
	eng, err := b.runsOrNotFound()
	if err != nil {
		return err
	}
	var req RunRequest
	if err := decodeLimit(r, &req, 256<<10); err != nil {
		return err
	}
	idem := r.Header.Get("Idempotency-Key")
	if idem == "" {
		idem = req.IdemKey
	}
	if len(idem) > 200 {
		return badRequest("Idempotency-Key is too long")
	}
	from := gateOrigin(r)
	if req.FlowID != "" {
		sf, ok := b.flowByID(r.Context(), req.FlowID, req.Scope)
		if !ok {
			return httpError{http.StatusNotFound, "no flow with that id"}
		}
		if err := b.before(r, "run.start", map[string]any{"flow": sf.Flow.ID, "scope": sf.Scope}); err != nil {
			return err
		}
		// A repository's flow runs only in that repository's worktrees.
		if name, ok := strings.CutPrefix(sf.Scope, "repo:"); ok {
			if loc, _, scoped := b.eventScope(r.Context(), req.Data); scoped && loc.Name != name {
				return badRequest("flow %s belongs to %s, not %s", sf.Flow.ID, name, loc.Name)
			}
		}
		e := eventAs(b, origin(r), triggerType(sf.Flow.Trigger), req.Data)
		s, err := b.startFlowRun(r.Context(), sf, e, flowStart{idem: idem})
		if err != nil {
			return runErr(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		writeJSON(w, s)
		return nil
	}
	if req.Template == "" && len(req.Flow) == 0 {
		return badRequest("a run needs a template or steps")
	}
	vars := map[string]string{}
	path := req.Path
	if req.Session != "" {
		vars["session"] = req.Session
		if sess, err := b.Sessions.Get(r.Context(), req.Session); err == nil && path == "" {
			path = sess.Dir
		}
	}
	if s, _ := req.Params["session"].(string); s != "" && vars["session"] == "" {
		vars["session"] = s
		if sess, err := b.Sessions.Get(r.Context(), s); err == nil && path == "" {
			path = sess.Dir
		}
	}
	if loc, ok := req.Params["location"].(string); ok && loc != "" {
		vars["location"] = loc
	}
	if path != "" {
		loc, wt, ok := b.worktreeAt(r.Context(), path)
		if !ok {
			return badRequest("%s is not a worktree on this box", path)
		}
		vars["location"], vars["worktree.name"], vars["worktree.path"], vars["worktree.branch"] = loc.Name, wt.Name, wt.Path, wt.Branch
		path = wt.Path
	}
	if err := b.before(r, "run.start", map[string]any{"template": req.Template, "path": path, "steps": len(req.Flow)}); err != nil {
		return err
	}
	s, dup, err := eng.Start(runs.Request{Template: req.Template, Title: req.Title, Flow: req.Flow, Params: req.Params, Vars: vars,
		IdemKey: idem, Group: req.Group, Parent: req.Parent, Budget: req.Budget, Origin: from, Path: path})
	if err != nil {
		if errors.Is(err, runs.ErrQueueFull) {
			return runErr(err)
		}
		return badRequest("%v", err)
	}
	b.watchCaller(r, Watch{Kind: "run", Run: s.ID})
	if dup {
		w.Header().Set("Idempotent-Replay", "true")
	} else {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
	}
	writeJSON(w, s)
	return nil
}

func (b *Box) flowByID(ctx context.Context, id, scope string) (ScopedFlow, bool) {
	all, err := b.ActiveFlows(ctx)
	if err != nil {
		return ScopedFlow{}, false
	}
	for _, sf := range all {
		if sf.Flow.ID == id && (scope == "" || sf.Scope == scope) {
			return sf, true
		}
	}
	return ScopedFlow{}, false
}

func (b *Box) listRuns(w http.ResponseWriter, r *http.Request) error {
	eng, err := b.runsOrNotFound()
	if err != nil {
		return err
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	writeJSON(w, eng.List(runs.Filter{Status: q.Get("status"), Template: q.Get("template"), Flow: q.Get("flow"), Group: q.Get("group"), Limit: limit}))
	return nil
}

func (b *Box) runTemplates(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, runs.Templates())
	return nil
}

func (b *Box) getRun(w http.ResponseWriter, r *http.Request) error {
	eng, err := b.runsOrNotFound()
	if err != nil {
		return err
	}
	run, err := eng.Get(r.PathValue("id"))
	if err != nil {
		return runErr(err)
	}
	writeJSON(w, run)
	return nil
}

// runEvents streams a run's journal: what it has recorded from since on,
// then each new record until the run ends.
func (b *Box) runEvents(w http.ResponseWriter, r *http.Request) error {
	eng, err := b.runsOrNotFound()
	if err != nil {
		return err
	}
	since, _ := strconv.Atoi(r.URL.Query().Get("since"))
	follow := r.URL.Query().Get("follow") != "0"
	w.Header().Set("Content-Type", "application/x-ndjson")
	bw := bufio.NewWriter(w)
	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(bw)
	ctx := r.Context()
	if !follow {
		// What is recorded so far, and no more.
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		cancel()
	}
	started := false
	err = eng.Follow(ctx, r.PathValue("id"), since, func(i int, rec runs.Record) bool {
		started = true
		// Each line carries its record number, to resume from.
		enc.Encode(struct {
			N int `json:"n"`
			runs.Record
		}{i, rec})
		bw.Flush()
		if flusher != nil {
			flusher.Flush()
		}
		return true
	})
	if err != nil && !started {
		return runErr(err)
	}
	bw.Flush()
	return nil
}

func (b *Box) cancelRun(w http.ResponseWriter, r *http.Request) error {
	eng, err := b.runsOrNotFound()
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	if err := b.before(r, "run.cancel", map[string]any{"run": id}); err != nil {
		return err
	}
	if err := eng.Cancel(id); err != nil {
		return runErr(err)
	}
	writeJSON(w, map[string]string{"cancelled": id})
	return nil
}

// GateDecision decides a gate.
type GateDecision struct {
	Approve bool   `json:"approve"`
	Note    string `json:"note,omitempty"`
	Pick    *int   `json:"pick,omitempty"`
}

func (b *Box) decideGate(w http.ResponseWriter, r *http.Request) error {
	eng, err := b.runsOrNotFound()
	if err != nil {
		return err
	}
	var req GateDecision
	if err := decode(r, &req); err != nil {
		return err
	}
	return b.decide(r, eng, r.PathValue("id"), r.PathValue("step"), req, gateOrigin(r), w)
}

func (b *Box) decide(r *http.Request, eng *runs.Engine, id, step string, req GateDecision, by string, w http.ResponseWriter) error {
	if step == "current" || step == "-" {
		step = ""
	}
	if len(req.Note) > 2000 {
		req.Note = req.Note[:2000]
	}
	// before:run.approve decides who may approve (and reject); by says
	// who asks: laptop:<name>, phone, or a tool on the box.
	if err := b.before(r, "run.approve", map[string]any{"run": id, "step": step, "approve": req.Approve, "by": by}); err != nil {
		return err
	}
	if err := eng.Decide(id, step, runs.Decision{Approve: req.Approve, Note: req.Note, Pick: req.Pick, By: by}); err != nil {
		return runErr(err)
	}
	writeJSON(w, map[string]any{"decided": id, "approve": req.Approve})
	return nil
}

// reviewRun is Review's Compare view: each candidate of an attempts run
// with its worktree's changes.
func (b *Box) reviewRun(w http.ResponseWriter, r *http.Request, id string) error {
	eng, err := b.runsOrNotFound()
	if err != nil {
		return err
	}
	run, err := eng.Get(id)
	if err != nil {
		return runErr(err)
	}
	// Now is the worktree as it is: its diff against the base, committed
	// or not (the Changes line and the file list both read it), and its
	// version, to tell whether it changed since the judge looked.
	type now struct {
		Files   []ReviewFile `json:"files"`
		Head    string       `json:"head,omitempty"`
		Dirty   bool         `json:"dirty,omitempty"`
		Base    string       `json:"base,omitempty"`
		Commits int          `json:"commits"`
	}
	type compared struct {
		runs.Candidate
		Review *ReviewItem `json:"review,omitempty"`
		Now    *now        `json:"now,omitempty"`
	}
	out := struct {
		Run   runs.Summary `json:"run"`
		Gate  *runs.Gate   `json:"gate,omitempty"`
		Judge string       `json:"judge,omitempty"`
		// PR is the pull request step: opened, skipped (a host without
		// them) or failed, with what it said.
		PR          *runs.StepRun     `json:"pr,omitempty"`
		Candidates  []compared        `json:"candidates"`
		Evaluations []runs.Evaluation `json:"evaluations,omitempty"`
		// CanRejudge says the judge can be asked again (POST .../judge).
		CanRejudge bool `json:"can_rejudge,omitempty"`
	}{Gate: run.Gate, Candidates: []compared{}, Evaluations: run.Evaluations}
	out.Run = runs.Summary{ID: run.ID, Template: run.Template, Title: run.Title, Status: run.Status, Created: run.Created, Updated: run.Updated, Usage: run.Usage}
	for _, st := range run.Steps {
		if st.Kind == "judge" {
			out.Judge = st.Output
		}
	}
	var findPR func([]runs.StepRun)
	findPR = func(steps []runs.StepRun) {
		for i := range steps {
			// A pr step skipped by its when rule says nothing: not that one.
			if steps[i].Kind == "pr" && (steps[i].Status != runs.Skipped || steps[i].Output != "") {
				st := steps[i]
				st.Children = nil
				out.PR = &st
			}
			findPR(steps[i].Children)
		}
	}
	findPR(run.Steps)
	// The last evaluation that ended is the one Review shows.
	for i := len(run.Evaluations) - 1; i >= 0; i-- {
		if ev := run.Evaluations[i]; ev.Status != runs.Running {
			out.Judge = ev.Output
			break
		}
	}
	if run.Gate != nil && run.Gate.Pick {
		for _, s := range run.Flow {
			if s.Kind == "judge" && s.By != "human" {
				out.CanRejudge = true
			}
		}
	}
	explicit, _ := run.Params["base"].(string)
	for _, c := range run.Candidates {
		item := compared{Candidate: c}
		if loc, wt, ok := b.worktreeAt(r.Context(), c.Path); ok {
			ri := gitReview(r.Context(), loc, wt)
			item.Review = &ri
			base := b.attemptBase(r.Context(), explicit, loc.Name)
			d := diffSummary(r.Context(), c.Path, base)
			d.apply(&item.Candidate)
			// What a person picked from, not what the judge saw: the
			// candidate's own Head and Dirty stay the judge's.
			item.Head, item.Dirty = c.Head, c.Dirty
			item.Now = &now{Files: d.list, Head: d.head, Dirty: d.dirty, Base: base, Commits: d.commits}
		}
		out.Candidates = append(out.Candidates, item)
	}
	writeJSON(w, out)
	return nil
}

// rejudgeRun asks an attempts run's judge again, about the attempts as
// they are now. It answers at once with the evaluation started; Review
// reads the verdict when it is in.
func (b *Box) rejudgeRun(w http.ResponseWriter, r *http.Request) error {
	eng, err := b.runsOrNotFound()
	if err != nil {
		return err
	}
	ev, err := eng.Rejudge(r.PathValue("id"))
	if err != nil {
		return runErr(err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, ev)
	return nil
}

// mountRuns adds the runs routes.
func (b *Box) mountRuns(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("GET /v1/runs", b.listRuns)
	route("POST /v1/runs", b.startRun)
	route("GET /v1/runs/templates", b.runTemplates)
	route("GET /v1/runs/{id}", b.getRun)
	route("GET /v1/runs/{id}/events", b.runEvents)
	route("POST /v1/runs/{id}/cancel", b.cancelRun)
	route("POST /v1/runs/{id}/gates/{step}/decide", b.decideGate)
	route("POST /v1/runs/{id}/judge", b.rejudgeRun)
	route("GET /v1/autofix", b.listAutoFix)
	route("PUT /v1/autofix", b.putAutoFix)
	route("POST /v1/flows/{id}/secret", b.flowSecret)
	route("POST /v1/triggers/{flow}", func(w http.ResponseWriter, r *http.Request) error {
		b.handleTrigger(w, r)
		return nil
	})
}

// shortRun is a run in a line, for the CLI and MCP.
func shortRun(s runs.Summary) string {
	parts := []string{s.ID, s.Template, s.Status}
	if s.Title != "" {
		parts = append(parts, s.Title)
	}
	if s.Gate != nil {
		parts = append(parts, "gate: "+s.Gate.Title)
	}
	return strings.Join(parts, "  ")
}

func firstLineOf(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	return s
}
