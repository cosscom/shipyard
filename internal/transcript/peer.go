package transcript

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Messages that reach an agent from someone other than the person. Claude
// Code hands each to the model as a "user" turn: another agent's message (a
// helper's hand-back, a teammate, another session), the team lead's note,
// its own notification of a background task, and a message the person
// typed mid-turn. Read as typed text they would draw as the person's own
// bubble (or, marked meta, not at all); read here each becomes an
// agent-message, a ping, or the person's words marked MidTurn.
//
// Claude Code 2.1 marks most of them with an origin beside the line (an
// isMeta user line, or a queued_command attachment); the text's own
// wrapping is the fallback for records without one. Whatever isn't
// recognised goes on to userText as before.
//
// Codex has no equivalent: its helpers (spawn_agent) answer through a tool
// call's output (wait_agent), never as a turn of their own, so its parser
// doesn't classify.

// Origin is what Claude Code writes beside such a turn.
type Origin struct {
	Kind         string `json:"kind"` // human, peer, coordinator, task-notification
	From         string `json:"from"`
	SenderTaskID string `json:"senderTaskId"`
	Handback     bool   `json:"handback"`
}

// Sender is who a message is from. Helper is the crew member's ID when it
// is one of this agent's helpers, so the app can open its conversation.
type Sender struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Kind is helper, teammate, session, lead or harness (Claude Code).
	Kind   string `json:"kind"`
	Color  string `json:"color,omitempty"`
	Helper string `json:"helper,omitempty"`
}

// Message is an agent-message's, or a ping's.
type Message struct {
	From Sender `json:"from"`
	// Intent is report, question, update or instruction (agent-message).
	Intent string `json:"intent,omitempty"`
	// Status: finished, failed or stopped on a message; done, failed,
	// stopped or info on a ping.
	Status  string `json:"status,omitempty"`
	Title   string `json:"title,omitempty"`
	Summary string `json:"summary,omitempty"`
	Body    string `json:"body,omitempty"`
	// Saved is where Claude Code put a report too long for the record:
	// Body is then its preview.
	Saved string `json:"saved,omitempty"`
	Task  string `json:"task,omitempty"`
	// Repeat is how many times it was said, once more than once.
	Repeat int `json:"repeat,omitempty"`
	// At is when it arrived (Unix ms).
	At int64 `json:"at,omitempty"`
	// Answered: a question the agent answered since (it messaged the
	// sender back), or one the person wrote after.
	Answered bool `json:"answered,omitempty"`
}

var (
	reminderRe = regexp.MustCompile(`(?s)\s*<system-reminder>.*?</system-reminder>\s*`)
	midTurnRe  = regexp.MustCompile(`(?s)^The user sent a new message while you were working:\n(.*?)(?:\n+This is how Claude Code surfaces messages the user sends mid-turn.*)?$`)
	peerHead   = "Another Claude session sent a message:"
	peerRe     = regexp.MustCompile(`(?s)^<(agent-message|cross-session-message|teammate-message)((?:\s+[\w-]+="[^"]*")*)\s*>\n?(.*?)\n?</(?:agent-message|cross-session-message|teammate-message)>\s*$`)
	peerAttrRe = regexp.MustCompile(`([\w-]+)="([^"]*)"`)
	sysNoteRe  = regexp.MustCompile(`(?s)^\[SYSTEM NOTIFICATION - NOT USER INPUT\].*?(<task-notification>)`)
	taskNoteRe = regexp.MustCompile(`(?s)<task-notification>.*?</task-notification>`)
	handbackRe = regexp.MustCompile(`(?s)^\s*\[Subagent hand-back\].*?The report follows:\n`)
	savedRe    = regexp.MustCompile(`(?s)<persisted-output>\s*Output too large \([^)]*\)\. Full output saved to: (\S+)\s*(?:Preview \(first [^)]*\):\n)?(.*?)\s*</persisted-output>`)
	agentSumRe = regexp.MustCompile(`^Agent "([^"]+)"\s*(.*)$`)
	cmdSumRe   = regexp.MustCompile(`^Background command "([^"]+)"\s*(.*)$`)
	hexIDRe    = regexp.MustCompile(`^[a-z]?[a-f0-9]{12,}$`)
	leadNoteRe = regexp.MustCompile(`^From the lead:\s*`)
	boilerRe   = regexp.MustCompile(`(?i)^(I (didn't|did not|haven't) (change|modify|edit|touch)[^.]*\.|Nothing (was|is) (changed|edited)[^.]*\.)\s*`)
)

// classified is one turn, or part of one, read for what it is.
type classified struct {
	kind    string // user, agent-message, ping, drop
	text    string
	midTurn bool
	msg     *Message
}

// classify reads a user turn's text and origin. It never fails: what it
// doesn't know is the person's, as before.
func classify(c *conv, s string, o *Origin) []classified {
	s = strings.TrimSpace(reminderRe.ReplaceAllString(s, "\n"))
	if s == "" {
		return []classified{{kind: "drop"}}
	}
	if m := midTurnRe.FindStringSubmatch(s); m != nil {
		return []classified{{kind: "user", text: strings.TrimSpace(m[1]), midTurn: true}}
	}
	if o != nil && o.Kind == "human" {
		return []classified{{kind: "user", text: s, midTurn: true}}
	}
	if o != nil && o.Kind == "coordinator" {
		body := leadNoteRe.ReplaceAllString(s, "")
		_, sum := gist(body)
		return []classified{{kind: "agent-message", msg: &Message{From: Sender{ID: "lead", Name: "Lead", Kind: "lead"}, Intent: "instruction", Summary: sum, Body: clip(body, maxText)}}}
	}
	if p := peerRe.FindStringSubmatch(strings.TrimSpace(strings.TrimPrefix(s, peerHead))); p != nil {
		return []classified{c.peer(p[1], p[2], p[3], o)}
	}
	if note := sysNoteRe.ReplaceAllString(s, "$1"); strings.HasPrefix(note, "<task-notification>") {
		var out []classified
		for _, n := range taskNoteRe.FindAllString(note, -1) {
			m := c.taskNote(n)
			kind := "ping"
			if m.Intent != "" {
				kind = "agent-message"
			}
			out = append(out, classified{kind: kind, msg: m})
		}
		if len(out) > 0 {
			return out
		}
	}
	// The rest is as before: userText knows commands, Shipyard's reports,
	// pastes and the tags to skip.
	return []classified{{kind: "user", text: s}}
}

// peer reads another agent's message: <agent-message from>,
// <cross-session-message from> or <teammate-message teammate_id color
// summary>.
func (c *conv) peer(tag, attrs, body string, o *Origin) classified {
	a := map[string]string{}
	for _, m := range peerAttrRe.FindAllStringSubmatch(attrs, -1) {
		a[m[1]] = unescapeAttr(m[2])
	}
	handback := handbackRe.MatchString(body) || (o != nil && o.Handback)
	var from Sender
	switch tag {
	case "teammate-message":
		from = c.sender(firstNonEmpty(a["teammate_id"], a["from"], originFrom(o), "teammate"), "teammate", a["color"])
	case "cross-session-message":
		from = c.sender(firstNonEmpty(a["from"], originFrom(o), "session"), "session", "")
	default:
		kind := "session"
		if handback {
			kind = "helper"
		}
		from = c.sender(firstNonEmpty(a["from"], originFrom(o), "agent"), kind, "")
	}
	// A teammate's notice is JSON (an idle notification, a shutdown): its
	// words when it has some, else one line.
	if t := strings.TrimSpace(body); strings.HasPrefix(t, "{") && strings.HasSuffix(t, "}") {
		var j map[string]any
		if json.Unmarshal([]byte(t), &j) == nil {
			typ, _ := j["type"].(string)
			words := ""
			for _, k := range []string{"result", "message", "content", "text"} {
				if v, ok := j[k].(string); ok && strings.TrimSpace(v) != "" {
					words = v
					break
				}
			}
			if words == "" && typ != "" {
				line := from.Name + " is free"
				if typ != "idle_notification" {
					line = from.Name + ": " + strings.ReplaceAll(typ, "_", " ")
				}
				return classified{kind: "ping", msg: &Message{From: from, Status: "info", Summary: line}}
			}
			if words != "" {
				body = words
			}
		}
	}
	body = dedent(handbackRe.ReplaceAllString(body, ""))
	saved := ""
	if m := savedRe.FindStringSubmatch(body); m != nil {
		saved, body = m[1], strings.TrimSuffix(strings.TrimSpace(m[2]), "...")
	}
	body = strings.TrimSpace(body)
	title, sum := gist(body)
	if a["summary"] != "" {
		sum = clip(a["summary"], 180)
	}
	msg := &Message{From: from, Title: title, Summary: sum, Body: clip(body, maxText), Saved: saved}
	if handback {
		msg.Intent, msg.Status = "report", "finished"
	} else {
		msg.Intent = intent(body, from)
	}
	return classified{kind: "agent-message", msg: msg}
}

// taskNote reads a <task-notification>: a helper's result is a report; a
// helper or background command without one is a ping.
func (c *conv) taskNote(n string) *Message {
	field := func(t string) string { v, _ := tagged(n, t); return strings.TrimSpace(v) }
	sum := field("summary")
	if strings.HasPrefix(field("task-type"), "artifact-watch") {
		return &Message{From: Sender{ID: "claude-code", Name: "Claude Code", Kind: "harness"}, Status: "info", Summary: clip(sum, 300)}
	}
	task, tool := field("task-id"), field("tool-use-id")
	status := map[string]string{"completed": "done", "failed": "failed", "killed": "stopped", "stopped": "stopped"}[field("status")]
	if status == "" {
		status = "info"
	}
	if m := agentSumRe.FindStringSubmatch(sum); m != nil {
		from := c.sender(firstNonEmpty(tool, task), "helper", "")
		if from.Helper == "" {
			from = c.sender(task, "helper", "")
		}
		if from.Helper == "" {
			from.Name = m[1]
		}
		if res := field("result"); res != "" {
			title, s := gist(res)
			ms := map[string]string{"done": "finished", "failed": "failed"}[status]
			if ms == "" {
				ms = "stopped"
			}
			return &Message{From: from, Intent: "report", Status: ms, Title: title, Summary: s, Body: clip(res, maxText), Task: task}
		}
		return &Message{From: from, Status: status, Summary: clip(strings.TrimSpace(from.Name+" "+m[2]), 300), Task: task}
	}
	if m := cmdSumRe.FindStringSubmatch(sum); m != nil {
		sum = m[1] + " " + m[2]
	}
	return &Message{From: Sender{ID: firstNonEmpty(task, "background"), Name: "Background command", Kind: "harness"}, Status: status, Summary: clip(strings.TrimSpace(sum), 300), Task: task}
}

// sender names who a message is from: a helper in the crew (by its call
// or agent ID), the lead, or else what the tag says it is (a teammate with
// its colour, another session).
func (c *conv) sender(raw, kind, color string) Sender {
	if i, ok := c.crewByID[raw]; ok {
		return Sender{ID: raw, Name: strings.TrimPrefix(c.crew[i].Name, "Explore: "), Kind: "helper", Helper: c.crew[i].ID}
	}
	// A helper's agent ID (the task ID its notifications carry) is in the
	// "Async agent launched … agentId: X" result of the call that started
	// it; c.agentIDs maps it back to that call.
	if call, ok := c.agentIDs[raw]; ok {
		if i, ok := c.crewByID[call]; ok {
			return Sender{ID: raw, Name: strings.TrimPrefix(c.crew[i].Name, "Explore: "), Kind: "helper", Helper: call}
		}
	}
	if raw == "team-lead" || raw == "lead" {
		return Sender{ID: raw, Name: "Lead", Kind: "lead", Color: color}
	}
	name := raw
	if hexIDRe.MatchString(raw) {
		switch kind {
		case "session":
			name = "Session " + raw[:7]
		case "helper":
			name = "Helper " + raw[:7]
		}
	}
	return Sender{ID: raw, Name: name, Kind: kind, Color: color}
}

// intent reads what a message wants: one ending on a question asks; a
// short one is an update; the rest are reports.
func intent(body string, from Sender) string {
	if from.Kind == "lead" {
		return "instruction"
	}
	paras := strings.Split(strings.TrimSpace(body), "\n\n")
	if strings.HasSuffix(strings.TrimSpace(paras[len(paras)-1]), "?") {
		return "question"
	}
	if len(body) < 320 && !strings.HasPrefix(body, "#") && !strings.Contains(body, "\n#") && !strings.Contains(body, "\n|") {
		return "update"
	}
	return "report"
}

// gist is a report's first heading and its first line of prose.
func gist(body string) (title, summary string) {
	fence := false
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "```") {
			fence = !fence
			continue
		}
		if fence {
			continue
		}
		if strings.HasPrefix(l, "#") {
			if title == "" {
				title = clip(strings.TrimSpace(strings.TrimLeft(l, "#")), 120)
			}
			continue
		}
		l = boilerRe.ReplaceAllString(l, "")
		if summary == "" && l != "" && !strings.HasPrefix(l, "|") && !strings.HasPrefix(l, "- ") && !strings.HasPrefix(l, "* ") && !strings.HasSuffix(l, ":") {
			summary = clip(strings.NewReplacer("`", "", "**", "").Replace(l), 180)
		}
		if title != "" && summary != "" {
			break
		}
	}
	return title, summary
}

// dedent undoes the two spaces the harness puts before each line of a
// hand-back.
func dedent(s string) string {
	lines := strings.Split(s, "\n")
	for _, l := range lines {
		if strings.TrimSpace(l) != "" && !strings.HasPrefix(l, "  ") {
			return s
		}
	}
	for i, l := range lines {
		if len(l) >= 2 {
			lines[i] = l[2:]
		} else {
			lines[i] = ""
		}
	}
	return strings.Join(lines, "\n")
}

func unescapeAttr(s string) string {
	return strings.NewReplacer("&quot;", `"`, "&apos;", "'", "&lt;", "<", "&gt;", ">", "&amp;", "&").Replace(s)
}

func originFrom(o *Origin) string {
	if o == nil {
		return ""
	}
	return firstNonEmpty(o.From, o.SenderTaskID)
}

// How a user turn arrived: the person's prompt, an isMeta line (Claude
// Code's, never shown as the person's), or a queued_command (read
// mid-turn).
const (
	turnPrompt = iota
	turnMeta
	turnQueued
)

// userTurn reads a user turn: the person's words go to userText, the rest
// become messages. The same message delivered twice (a queued_command, then
// its line) shows once.
func (c *conv) userTurn(s string, o *Origin, how int, at int64) {
	helperDone(c, s, at)
	for _, k := range classify(c, s, o) {
		switch k.kind {
		case "user":
			// A meta line not known as anything is Claude Code's own, as
			// before; a queued command is the person's, typed mid-turn.
			if how == turnMeta && !k.midTurn {
				continue
			}
			if how == turnQueued && !strings.HasPrefix(k.text, "<") {
				k.midTurn = true
			}
			if !k.midTurn {
				userText(c, k.text)
				continue
			}
			// Claude Code writes a mid-turn message more than once (its
			// queued_command, the note around it, sometimes its line).
			if c.queued[k.text] {
				continue
			}
			n := c.base + len(c.items)
			userText(c, k.text)
			if c.base+len(c.items) > n {
				c.items[len(c.items)-1].MidTurn = true
				if c.queued == nil {
					c.queued = map[string]bool{}
				}
				c.queued[k.text] = true
			}
		case "agent-message", "ping":
			if c.seenVia(s, how) {
				return
			}
			k.msg.At = at
			c.addMessage(k.kind, k.msg)
		}
	}
}

// seenVia says whether text came just now another way (a queued_command,
// then the line Claude Code writes for it): the second is the same
// message, not a repeat.
func (c *conv) seenVia(s string, how int) bool {
	now := c.base + len(c.items)
	if c.via == nil || len(c.via) > 64 {
		c.via = map[string][2]int{}
	}
	if prev, ok := c.via[s]; ok && prev[0] != how && now-prev[1] <= 3 {
		delete(c.via, s)
		return true
	}
	c.via[s] = [2]int{how, now}
	return false
}

// addMessage adds a message or a ping, folding what repeats one already
// shown: a helper's notification that it finished into its hand-back's
// card, the same notification again into a count, the same message twice
// into one.
func (c *conv) addMessage(kind string, m *Message) {
	if kind == "ping" && m.From.Helper != "" && m.Status == "done" {
		// Its hand-back came first: the card says it already.
		for i := len(c.items) - 1; i >= 0; i-- {
			it := &c.items[i]
			if it.Kind == "agent-message" && it.Msg.From.Helper == m.From.Helper && it.Msg.Intent == "report" {
				if !it.confirmed {
					it.confirmed = true
					return
				}
				break
			}
		}
	}
	if kind == "agent-message" && m.From.Helper != "" && m.Intent == "report" {
		// Its notification came first, just now: the card takes its place.
		if n := len(c.items); n > 0 {
			last := &c.items[n-1]
			if last.Kind == "ping" && last.Msg.From.Helper == m.From.Helper && last.Msg.Status == "done" {
				m.At = last.Msg.At
				last.Kind, last.Msg, last.confirmed = "agent-message", m, true
				c.changed(last)
				return
			}
		}
	}
	for i := len(c.items) - 1; i >= 0; i-- {
		it := &c.items[i]
		if it.Msg == nil || it.Kind != kind {
			continue
		}
		same := false
		if kind == "ping" && m.Task != "" {
			if it.Msg.Task != m.Task {
				continue
			}
			same = it.Msg.Status == m.Status
		} else {
			same = it.Msg.From.ID == m.From.ID && it.Msg.Body == m.Body && it.Msg.Summary == m.Summary
		}
		if same {
			it.Msg.Repeat = max(it.Msg.Repeat, 1) + 1
			c.changed(it)
			return
		}
		break
	}
	// Another agent's word doesn't answer a question the agent asked the
	// person, which stays open until they do (or a prompt of theirs
	// settles it).
	c.closeArtifacts()
	c.add(Item{Kind: kind, ID: c.id(), Msg: m})
}

// changed marks an item sent already as changed: a reader that has it
// gets it again (artifactsSince).
func (c *conv) changed(it *Item) {
	it.resolved = c.base + len(c.items)
}

// repliedTo marks the open questions from a sender answered: the agent
// messaged it back (SendMessage), or with to empty, the person wrote.
func (c *conv) repliedTo(to string) {
	for i := len(c.items) - 1; i >= 0; i-- {
		it := &c.items[i]
		if it.Kind != "agent-message" || it.Msg.Intent != "question" || it.Msg.Answered {
			continue
		}
		if to == "" || to == "*" || strings.EqualFold(to, it.Msg.From.ID) || strings.EqualFold(to, it.Msg.From.Name) {
			it.Msg.Answered = true
			c.changed(it)
		}
	}
}
