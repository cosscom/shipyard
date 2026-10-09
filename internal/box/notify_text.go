package box

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/transcript"
)

// What a parent reads: one <berth-notification> holding a <report> for
// each piece of work, modelled on Claude Code's own <task-notification>.
// The attributes are the facts (the app draws them as a card, see
// internal/transcript/report.go); the tags inside are words for the agent.

// Trims: what one report may hold.
const (
	answerLimit = 1500
	needsLimit  = 400
	outputLimit = 800
	filesListed = 8
)

// NotificationText is the message that tells a parent about reps; dropped
// counts reports let go because too many piled up.
func NotificationText(reps []Report, dropped int) string {
	var b strings.Builder
	b.WriteString("<berth-notification>\n")
	b.WriteString("This comes from Shipyard, not from the user: news of agent work you started. Carry on with your task using it. If an agent waits for a person, tell the user who and why; never answer for them.\n")
	if dropped > 0 {
		fmt.Fprintf(&b, "(%d earlier updates were dropped: too many came at once. berth_sessions lists every agent's state.)\n", dropped)
	}
	for _, r := range reps {
		writeReport(&b, r)
	}
	b.WriteString("</berth-notification>")
	return b.String()
}

func writeReport(b *strings.Builder, r Report) {
	attrs := [][2]string{{"kind", r.Kind}}
	if r.Session != "" {
		attrs = append(attrs, [2]string{"session", r.Session})
	}
	if r.Run != "" {
		attrs = append(attrs, [2]string{"run", r.Run}, [2]string{"template", r.Template})
		if r.Title != "" {
			attrs = append(attrs, [2]string{"title", r.Title})
		}
	}
	if r.Worktree != "" {
		attrs = append(attrs, [2]string{"worktree", r.Worktree})
	}
	if r.Branch != "" {
		attrs = append(attrs, [2]string{"branch", r.Branch})
	}
	attrs = append(attrs, [2]string{"status", r.Status})
	if r.Duration > 0 {
		attrs = append(attrs, [2]string{"duration", shortDuration(r.Duration)})
	}
	if len(r.Files) > 0 {
		attrs = append(attrs, [2]string{"files", strconv.Itoa(len(r.Files))}, [2]string{"added", strconv.Itoa(r.Added)}, [2]string{"removed", strconv.Itoa(r.Removed)})
	}
	b.WriteString("<report")
	for _, a := range attrs {
		if a[1] != "" {
			fmt.Fprintf(b, " %s=\"%s\"", a[0], attrValue(a[1]))
		}
	}
	b.WriteString(">\n")
	tag := func(name, text string) {
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		fmt.Fprintf(b, "<%s>%s</%s>\n", name, inner(text), name)
	}
	block := func(name, text string) {
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		fmt.Fprintf(b, "<%s>\n%s\n</%s>\n", name, inner(text), name)
	}
	tag("summary", reportSummary(r))
	tag("error", r.Error)
	tag("needs", trim(r.Needs, needsLimit))
	block("answer", trim(r.Answer, answerLimit))
	tag("changes", changesText(r))
	tag("bring-back", bringBack(r))
	tag("more", moreText(r))
	b.WriteString("</report>\n")
}

// reportSummary is the report in one line.
func reportSummary(r Report) string {
	who := firstNonEmpty(r.Worktree, r.Session)
	if r.Kind == "run" {
		who = "run " + r.Run + " (" + firstNonEmpty(r.Title, r.Template) + ")"
		if r.Worktree != "" {
			who += " in " + r.Worktree
		}
	}
	switch r.Status {
	case "finished":
		return who + " finished its turn."
	case "failed":
		if r.Kind == "run" {
			return who + " failed."
		}
		return who + " ended its turn on an error."
	case "exited":
		return who + ": the agent exited before it finished."
	case "lost":
		return who + ": the prompt never started a turn."
	case "waiting":
		return who + " is waiting for a person (a permission or a question)."
	case runs.WaitingGate:
		return who + " waits at a gate for a person to decide."
	case runs.Succeeded:
		return who + " succeeded."
	case runs.Cancelled:
		return who + " was cancelled."
	case runs.Interrupted:
		return who + " was interrupted."
	}
	return who + ": " + r.Status + "."
}

func changesText(r Report) string {
	if len(r.Files) == 0 {
		return ""
	}
	var parts []string
	for i, f := range r.Files {
		if i == filesListed {
			parts = append(parts, fmt.Sprintf("and %d more", len(r.Files)-filesListed))
			break
		}
		parts = append(parts, fmt.Sprintf("%s +%d −%d", f.Path, f.Added, f.Removed))
	}
	where := ""
	switch {
	case r.Base != "" && !r.shared():
		where = " against " + r.Base
	case r.shared():
		where = " this turn"
	}
	s := fmt.Sprintf("%d file%s, +%d −%d%s: %s", len(r.Files), plural(len(r.Files)), r.Added, r.Removed, where, strings.Join(parts, ", "))
	if r.Uncommitted > 0 && !r.shared() {
		s += fmt.Sprintf(". %d uncommitted", r.Uncommitted)
	}
	return s
}

// shared says the work ran in the parent's own folder (or the main
// checkout): there is nothing to bring back.
func (r Report) shared() bool { return r.Branch == "" || r.Repo == r.Path }

func bringBack(r Report) string {
	if r.Kind == "run" && r.Branch == "" {
		return ""
	}
	if r.Status == "waiting" || r.Status == runs.WaitingGate || r.Path == "" || r.shared() || (len(r.Files) == 0 && r.Ahead == 0) {
		return ""
	}
	base := firstNonEmpty(r.Base, "the base branch")
	s := fmt.Sprintf("Branch %s, checked out at %s", r.Branch, r.Path)
	if r.Ahead > 0 {
		s += fmt.Sprintf(", %d commit%s ahead of %s", r.Ahead, plural(r.Ahead), base)
	}
	s += fmt.Sprintf(". Review it there: git diff %s.", firstNonEmpty(r.Base, "HEAD"))
	if r.Uncommitted > 0 {
		s += fmt.Sprintf(" To bring it in, commit there first (git add -A && git commit -m …), then in your checkout: git merge %s.", r.Branch)
	} else {
		s += fmt.Sprintf(" To bring it in, in your checkout: git merge %s.", r.Branch)
	}
	if r.Session != "" {
		s += fmt.Sprintf(" Or hand it to a fresh agent: berth_run_start template=handoff with session %s.", r.Session)
	}
	return s
}

func moreText(r Report) string {
	var parts []string
	if r.Run != "" {
		parts = append(parts, "berth_run_get run="+r.Run)
		if r.Status == runs.WaitingGate {
			parts = append(parts, "a person decides the gate (berthd run approve|reject "+r.Run+"): tell the user")
		}
	}
	if r.Session != "" {
		parts = append(parts, "berth_screen session="+r.Session+" shows its screen")
		if r.Transcript != "" {
			parts = append(parts, "its full conversation is "+r.Transcript)
		}
		if r.Status == "finished" || r.Status == "failed" {
			parts = append(parts, "berth_send session="+r.Session+" asks it for more")
		}
	}
	return strings.Join(parts, "; ")
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// shortDuration is "42s", "4m12s" or "1h05m".
func shortDuration(d time.Duration) string {
	d = d.Round(time.Second)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}

func attrValue(s string) string {
	s = strings.Map(func(r rune) rune {
		switch r {
		case '"':
			return '\''
		case '\n', '\r', '\t':
			return ' '
		case '<', '>':
			return -1
		}
		return r
	}, s)
	return trim(s, 200)
}

// inner keeps text from closing the tags it sits in.
func inner(s string) string {
	for _, t := range []string{"berth-notification", "report", "answer", "needs", "changes", "bring-back", "more", "summary", "error"} {
		s = strings.ReplaceAll(s, "</"+t+">", "</"+t+"​>")
		s = strings.ReplaceAll(s, "<"+t, "<​"+t)
	}
	return s
}

// trim keeps the first n bytes of s, on a character boundary.
func trim(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return strings.TrimSpace(s[:cut]) + " … (trimmed)"
}

// boxNotifyHost is the box as the notifier sees it.
type boxNotifyHost struct{ b *Box }

func (h *boxNotifyHost) turn(id string) (Turn, bool) {
	if h.b.Turns == nil {
		return Turn{}, false
	}
	return h.b.Turns.Get(id)
}

func (h *boxNotifyHost) turns(session string) []Turn {
	if h.b.Turns == nil {
		return nil
	}
	return h.b.Turns.List(session, 20)
}

func (h *boxNotifyHost) state(session string) (SessionState, bool) {
	if h.b.Turns == nil {
		return SessionState{}, false
	}
	return h.b.Turns.State(session)
}

func (h *boxNotifyHost) sessions(ctx context.Context) (map[string]liveSession, error) {
	all, err := h.b.Sessions.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]liveSession, len(all))
	for _, s := range all {
		out[s.Name] = liveSession{Agent: agentFor(s) != "", Exited: s.Exited}
	}
	return out, nil
}

func (h *boxNotifyHost) ready(session string) bool {
	if h.b.Turns == nil {
		return true
	}
	return h.b.Turns.Ready(session)
}

func (h *boxNotifyHost) run(id string) (runs.Run, bool) {
	if h.b.Runs == nil {
		return runs.Run{}, false
	}
	r, err := h.b.Runs.Get(id)
	return r, err == nil
}

func (h *boxNotifyHost) deliver(ctx context.Context, parent, text string) error {
	_, err := h.b.sendPrompt(ctx, parent, SendRequest{Text: text, When: "idle"}, "berth", "berth:report")
	return err
}

// describe fills in where the work ran, what it changed and its last words.
func (h *boxNotifyHost) describe(ctx context.Context, r *Report) {
	b := h.b
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if r.Run != "" {
		describeRun(b, r)
	}
	var sess Session
	dir := r.Path
	if r.Session != "" {
		if s, err := b.Sessions.Get(ctx, r.Session); err == nil {
			sess, dir = s, s.Dir
		}
	}
	var parentDir string
	if p, err := b.Sessions.Get(ctx, r.Parent); err == nil {
		parentDir = p.Dir
	}
	if dir != "" {
		if loc, wt, ok := b.worktreeAt(ctx, dir); ok {
			r.Worktree, r.Path, r.Repo = loc.Name+"/"+wt.Name, wt.Path, loc.Path
			if !wt.Main {
				r.Branch = wt.Branch
			}
			if wt.Path == parentDir {
				r.Repo = wt.Path // the parent's own folder: nothing to bring back
			}
			if r.Status != "waiting" && r.Status != runs.WaitingGate && !r.shared() {
				item := gitReview(ctx, loc, wt)
				r.Base, r.Ahead, r.Uncommitted = item.Base, item.BaseAhead, len(item.Files)
				r.Files = mergeFiles(item.Committed, item.Files)
			}
		}
	}
	if sess.Name == "" {
		sumFiles(r)
		return
	}
	agent, path, _ := b.transcriptFile(requestFor(ctx), sess, nil)
	if path == "" || (agent != "claude" && agent != "codex") {
		sumFiles(r)
		return
	}
	r.Transcript = path
	if r.Status != "waiting" {
		if page, err := transcript.Before(agent, path, sess.Dir, 0, 60); err == nil {
			r.Answer = lastAnswer(page.Items)
		}
	}
	if r.shared() && len(r.Files) == 0 && r.Status != "waiting" {
		if t, err := transcript.LastTurn(agent, path, sess.Dir); err == nil {
			for _, f := range t.Files {
				r.Files = append(r.Files, ReviewFile{Path: relTo(sess.Dir, f.Path), Added: f.Added, Removed: f.Removed})
			}
		}
	}
	sumFiles(r)
}

func requestFor(ctx context.Context) *http.Request {
	r, _ := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
	return r
}

func relTo(dir, p string) string {
	if rest, ok := strings.CutPrefix(p, dir+"/"); ok {
		return rest
	}
	return p
}

// lastAnswer is the agent's last words after the last prompt.
func lastAnswer(items []transcript.Item) string {
	for i := len(items) - 1; i >= 0; i-- {
		switch items[i].Kind {
		case "text":
			return items[i].Text
		case "user", "report":
			return ""
		}
	}
	return ""
}

// mergeFiles is the branch's files and the uncommitted ones as one list,
// counts summed, the most changed first.
func mergeFiles(lists ...[]ReviewFile) []ReviewFile {
	by := map[string]*ReviewFile{}
	var order []string
	for _, l := range lists {
		for _, f := range l {
			if x, ok := by[f.Path]; ok {
				x.Added += f.Added
				x.Removed += f.Removed
				continue
			}
			f := f
			by[f.Path] = &f
			order = append(order, f.Path)
		}
	}
	out := make([]ReviewFile, 0, len(order))
	for _, p := range order {
		out = append(out, *by[p])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Added+out[i].Removed > out[j].Added+out[j].Removed })
	return out
}

func sumFiles(r *Report) {
	r.Added, r.Removed = 0, 0
	for _, f := range r.Files {
		r.Added += f.Added
		r.Removed += f.Removed
	}
}

// describeRun adds a run's own words: its error, its gate, a command's
// output, an attempts run's attempts.
func describeRun(b *Box, r *Report) {
	run, err := b.Runs.Get(r.Run)
	if err != nil {
		return
	}
	r.Error = trim(run.Error, needsLimit)
	if run.Gate != nil && r.Status == runs.WaitingGate {
		r.Needs = strings.TrimSpace(run.Gate.Title + ". " + run.Gate.Text)
	}
	if r.Path == "" {
		r.Path = run.Path
	}
	if run.Template == "exec" && len(run.Steps) > 0 {
		st := run.Steps[len(run.Steps)-1]
		out := st.Output
		if st.Status != runs.Succeeded {
			out = CheckFeedback(out, outputLimit)
		} else if len(out) > outputLimit {
			out = "…" + out[len(out)-outputLimit:]
		}
		r.Answer = fmt.Sprintf("exit code %d\n%s", st.ExitCode, strings.TrimSpace(out))
	}
	if len(run.Candidates) > 0 {
		var lines []string
		for _, c := range run.Candidates {
			lines = append(lines, fmt.Sprintf("attempt %d (%s): check %s, +%d −%d, rank %d%s", c.Index+1, c.Agent, passed(c.Verify.Passed), c.Diff.Added, c.Diff.Removed, c.Judge.Rank, picked(c.Picked)))
		}
		r.Answer = strings.Join(lines, "\n")
	}
}

func passed(ok bool) string {
	if ok {
		return "passed"
	}
	return "failed"
}

func picked(ok bool) string {
	if ok {
		return ", picked"
	}
	return ""
}
