package transcript

import (
	"regexp"
	"strconv"
	"strings"
)

// A <berth-notification> is what berth types into an agent's session when
// work it started ends, waits for a person or reaches a gate
// (internal/box/notify_text.go): a prompt from berth, not from the person.
// The chat draws each of its reports as a card, never the tagged text.

// Report is one piece of work a notification reports on.
type Report struct {
	// Kind is task, turn, run or secret.
	Kind     string `json:"kind"`
	Session  string `json:"session,omitempty"`
	Run      string `json:"run,omitempty"`
	Template string `json:"template,omitempty"`
	Title    string `json:"title,omitempty"`
	Worktree string `json:"worktree,omitempty"`
	Branch   string `json:"branch,omitempty"`
	// Status is finished, failed, exited, lost or waiting; a run's own.
	Status   string `json:"status"`
	Duration string `json:"duration,omitempty"`
	Files    int    `json:"files,omitempty"`
	Added    int    `json:"added,omitempty"`
	Removed  int    `json:"removed,omitempty"`
	// Summary is the report in a line; Answer the agent's last words,
	// Needs what it waits for.
	Summary string `json:"summary,omitempty"`
	Answer  string `json:"answer,omitempty"`
	Needs   string `json:"needs,omitempty"`
}

var (
	reportRe = regexp.MustCompile(`(?s)<report((?:\s+[a-z-]+="[^"]*")*)\s*>(.*?)</report>`)
	attrRe   = regexp.MustCompile(`([a-z-]+)="([^"]*)"`)
)

// berthReports reads a <berth-notification> into one report item per
// piece of work, and says whether s was one.
func berthReports(c *conv, s string) bool {
	if !strings.HasPrefix(s, "<berth-notification>") {
		return false
	}
	for _, m := range reportRe.FindAllStringSubmatch(s, -1) {
		r := Report{}
		for _, a := range attrRe.FindAllStringSubmatch(m[1], -1) {
			v := a[2]
			n, _ := strconv.Atoi(v)
			switch a[1] {
			case "kind":
				r.Kind = v
			case "session":
				r.Session = v
			case "run":
				r.Run = v
			case "template":
				r.Template = v
			case "title":
				r.Title = v
			case "worktree":
				r.Worktree = v
			case "branch":
				r.Branch = v
			case "status":
				r.Status = v
			case "duration":
				r.Duration = v
			case "files":
				r.Files = n
			case "added":
				r.Added = n
			case "removed":
				r.Removed = n
			}
		}
		body := m[2]
		r.Summary = clip(strings.TrimSpace(tagText(body, "summary")), 400)
		r.Answer = clip(strings.TrimSpace(tagText(body, "answer")), 2000)
		r.Needs = clip(strings.TrimSpace(tagText(body, "needs")), 600)
		c.add(Item{Kind: "report", ID: c.id(), Report: &r})
	}
	return true
}

// tagText is what <tag>…</tag> holds in s, without the zero-width space
// berth puts in a tag the text itself wrote.
func tagText(s, tag string) string {
	in, _ := tagged(s, tag)
	return strings.ReplaceAll(in, "​", "")
}
