package transcript

import (
	"path/filepath"
	"strings"
	"testing"
)

// Synthetic records in the shapes Claude Code 2.1 writes for messages that
// aren't the person's (made up, for the made-up acme org; never copied
// from a real transcript).

const sysPreamble = "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n"

const handbackPreamble = "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n"

func meta(s string, o m) m {
	return m{"type": "user", "isMeta": true, "timestamp": "2026-10-04T12:00:02Z", "origin": o, "message": m{"role": "user", "content": s}}
}

func queued(prompt string, o m) m {
	a := m{"type": "queued_command", "prompt": prompt}
	if o != nil {
		a["origin"] = o
	}
	return m{"type": "attachment", "timestamp": "2026-10-04T12:00:03Z", "attachment": a}
}

func taskNotification(task, tool, status, summary, extra string) string {
	s := sysPreamble + "<task-notification>\n<task-id>" + task + "</task-id>\n"
	if tool != "" {
		s += "<tool-use-id>" + tool + "</tool-use-id>\n"
	}
	return s + "<status>" + status + "</status>\n<summary>" + summary + "</summary>\n" + extra + "</task-notification>"
}

func indent2(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = "  " + l
		}
	}
	return strings.Join(lines, "\n")
}

func handback(agentID, report string) string {
	return "Another Claude session sent a message:\n<agent-message from=\"" + agentID + "\">\n" + handbackPreamble + indent2(report) + "\n</agent-message>"
}

// launch is an Agent call started in the background and its answer, which
// names its agent ID.
func launch(call, name, agentID string) []any {
	return []any{
		assistant(tool(call, "Agent", m{"description": name, "run_in_background": true})),
		user([]m{{"type": "tool_result", "tool_use_id": call, "content": "Async agent launched successfully.\nagentId: " + agentID + " (internal ID - do not mention to user)"}}),
	}
}

func readAll(t *testing.T, lines ...any) Result {
	t.Helper()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p, lines...)
	res, err := NewReader().Read("claude", p, "/w/acme", 0)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func only(t *testing.T, items []Item, kind string) []Item {
	t.Helper()
	var out []Item
	for _, it := range items {
		if it.Kind == kind {
			out = append(out, it)
		}
	}
	return out
}

const ledgerReport = "# Ledger writes in acme/billing\n\nI didn't change any files. Two of the three write paths have no idempotency key.\n\n| Path | Keyed |\n|---|---|\n| settle | yes |\n| refund | no |"

func TestHandbackIsAHelpersReport(t *testing.T) {
	lines := append([]any{user("Map the ledger writes")}, launch("toolu_L", "Map ledger writes", "a3f9c1e7b2d4a6c80")...)
	lines = append(lines,
		meta(handback("a3f9c1e7b2d4a6c80", ledgerReport), m{"kind": "peer", "from": "a3f9c1e7b2d4a6c80", "handback": true}),
		// Its own "finished" notification folds into the card.
		meta(taskNotification("a3f9c1e7b2d4a6c80", "toolu_L", "completed", `Agent "Map ledger writes" finished`, "<note>may notify more than once</note>\n"), m{"kind": "task-notification"}),
	)
	res := readAll(t, lines...)
	if got := kinds(res.Items); got != "user,crew,agent-message" {
		t.Fatalf("kinds = %s", got)
	}
	h := res.Items[2].Msg
	if h.From != (Sender{ID: "a3f9c1e7b2d4a6c80", Name: "Map ledger writes", Kind: "helper", Helper: "toolu_L"}) {
		t.Fatalf("from = %+v", h.From)
	}
	if h.Intent != "report" || h.Status != "finished" || h.Title != "Ledger writes in acme/billing" || h.Summary != "Two of the three write paths have no idempotency key." || h.Repeat != 0 {
		t.Fatalf("hand-back = %+v", h)
	}
	// The harness's preamble and indent are gone; the Markdown is whole.
	if !strings.HasPrefix(h.Body, "# Ledger writes") || !strings.Contains(h.Body, "\n| refund | no |") || strings.Contains(h.Body, "Subagent hand-back") {
		t.Fatalf("body = %q", h.Body)
	}
	if res.Crew[0].State != "finished" {
		t.Fatalf("crew = %+v", res.Crew)
	}
}

func TestNotificationBeforeHandbackBecomesTheCard(t *testing.T) {
	lines := launch("toolu_E", "Audit export reads", "a51be0c7d93f2a614")
	lines = append(lines,
		meta(taskNotification("a51be0c7d93f2a614", "toolu_E", "completed", `Agent "Audit export reads" finished`, ""), m{"kind": "task-notification"}),
		meta(handback("a51be0c7d93f2a614", "## Export reads\n\nTwo reads still use ledger_v1."), m{"kind": "peer", "from": "a51be0c7d93f2a614", "handback": true}),
	)
	res := readAll(t, lines...)
	if got := kinds(res.Items); got != "crew,agent-message" {
		t.Fatalf("kinds = %s", got)
	}
	if m := res.Items[1].Msg; m.Title != "Export reads" || m.Summary != "Two reads still use ledger_v1." {
		t.Fatalf("card = %+v", m)
	}
}

func TestPingsFoldRepeats(t *testing.T) {
	lines := launch("toolu_R", "Fix retry tests", "a7d20e94c1b3f5a26")
	failed := taskNotification("a7d20e94c1b3f5a26", "toolu_R", "failed", `Agent "Fix retry tests" failed: Agent stalled: no progress for 600s`, "")
	lines = append(lines,
		meta(failed, m{"kind": "task-notification"}),
		meta(failed, m{"kind": "task-notification"}),
		meta(taskNotification("b4kq7m2xz", "toolu_B", "completed", `Background command "Run the billing tests" completed (exit code 0)`, "<output-file>/tmp/acme/b4kq7m2xz.output</output-file>\n"), m{"kind": "task-notification"}),
		meta(sysPreamble+"<task-notification>\n<task-type>artifact-watch-lifecycle</task-type>\n<summary>Not watching Artifact: \"Ledger plan\" (watch limit reached)</summary>\n</task-notification>", m{"kind": "task-notification"}),
		meta(taskNotification("b9x2k7q1m", "toolu_D", "killed", `Background command "Dry-run the backfill" was stopped`, ""), m{"kind": "task-notification"}),
	)
	res := readAll(t, lines...)
	pings := only(t, res.Items, "ping")
	if len(pings) != 4 {
		t.Fatalf("pings = %s", kinds(res.Items))
	}
	f := pings[0].Msg
	if f.Status != "failed" || f.Repeat != 2 || f.From.Kind != "helper" || f.From.Helper != "toolu_R" || f.Summary != "Fix retry tests failed: Agent stalled: no progress for 600s" {
		t.Fatalf("failed = %+v", f)
	}
	if b := pings[1].Msg; b.Status != "done" || b.From.Name != "Background command" || b.Summary != "Run the billing tests completed (exit code 0)" || b.Task != "b4kq7m2xz" {
		t.Fatalf("background = %+v", b)
	}
	if a := pings[2].Msg; a.Status != "info" || a.From.Kind != "harness" || !strings.HasPrefix(a.Summary, "Not watching Artifact") {
		t.Fatalf("artifact watch = %+v", a)
	}
	if k := pings[3].Msg; k.Status != "stopped" {
		t.Fatalf("killed = %+v", k)
	}
}

func TestNotificationWithResultIsAReport(t *testing.T) {
	lines := launch("toolu_I", "Check index sizes", "a0c8e2b71f4d96a35")
	lines = append(lines, user(taskNotification("a0c8e2b71f4d96a35", "toolu_I", "completed", `Agent "Check index sizes" completed`, "<result>## Index sizes\n\nEvery index fits in memory.</result>\n")))
	res := readAll(t, lines...)
	if got := kinds(res.Items); got != "crew,agent-message" {
		t.Fatalf("kinds = %s", got)
	}
	if m := res.Items[1].Msg; m.Intent != "report" || m.Status != "finished" || m.From.Name != "Check index sizes" || m.Title != "Index sizes" {
		t.Fatalf("report = %+v", m)
	}
}

func TestTwoNotificationsInOneTurn(t *testing.T) {
	res := readAll(t, user(taskNotification("b1", "", "completed", `Background command "Lint" completed (exit code 0)`, "")+"\n"+taskNotification("b2", "", "failed", `Background command "Typecheck" failed with exit code 2`, "")))
	if got := kinds(res.Items); got != "ping,ping" {
		t.Fatalf("kinds = %s", got)
	}
	if res.Items[1].Msg.Status != "failed" {
		t.Fatalf("second = %+v", res.Items[1].Msg)
	}
}

func TestMidTurnMessageShowsOnceAsThePersons(t *testing.T) {
	const said = "Keep ledger_v1 until Friday's deploy."
	res := readAll(t,
		user("Move acme billing to the new ledger"),
		assistant(tool("toolu_1", "Bash", m{"command": "go test ./billing/..."})),
		queued(said, m{"kind": "human"}),
		meta("The user sent a new message while you were working:\n"+said+"\n\nThis is how Claude Code surfaces messages the user sends mid-turn. Address it as you continue.", m{"kind": "human"}),
		result("toolu_1"),
	)
	users := only(t, res.Items, "user")
	if len(users) != 2 || users[1].Text != said || !users[1].MidTurn || users[0].MidTurn {
		t.Fatalf("users = %+v", users)
	}
}

func TestMidTurnNoteFirstThenItsQueuedCommand(t *testing.T) {
	const said = "Use the staging database."
	res := readAll(t,
		meta("The user sent a new message while you were working:\n"+said, m{"kind": "human"}),
		queued(said, nil),
		// Older Claude Code also wrote the prompt's own line later.
		user(said),
	)
	if got := kinds(res.Items); got != "user" || !res.Items[0].MidTurn {
		t.Fatalf("items = %+v", res.Items)
	}
}

func TestQueuedCommandWithoutOriginIsMidTurn(t *testing.T) {
	res := readAll(t, queued("Also check the refunds path", nil))
	if len(res.Items) != 1 || !res.Items[0].MidTurn || res.Items[0].Text != "Also check the refunds path" {
		t.Fatalf("items = %+v", res.Items)
	}
}

func TestRemindersDisappear(t *testing.T) {
	res := readAll(t,
		user("Fix the refund retries\n\n<system-reminder>\nThe task tools haven't been used recently.\n</system-reminder>"),
		user("<system-reminder>\nWhole line of its own.\n</system-reminder>"),
		meta("<system-reminder>\nMeta line.\n</system-reminder>", m{"kind": "peer"}),
	)
	if got := kinds(res.Items); got != "user" || res.Items[0].Text != "Fix the refund retries" {
		t.Fatalf("items = %+v", res.Items)
	}
}

func TestSessionQuestionAndItsAnswer(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p,
		user("Another Claude session sent a message:\n<cross-session-message from=\"payments-api\">\nHas the ledger migration merged?\n\nWhich column name will it be: `idempotency_key` or `request_key`?\n</cross-session-message>"),
	)
	r := NewReader()
	res, err := r.Read("claude", p, "/w/acme", 0)
	if err != nil {
		t.Fatal(err)
	}
	q := res.Items[0]
	if q.Kind != "agent-message" || q.Msg.Intent != "question" || q.Msg.From != (Sender{ID: "payments-api", Name: "payments-api", Kind: "session"}) || q.Msg.Answered {
		t.Fatalf("question = %+v", q.Msg)
	}
	// Claude answers it: the card comes again, answered.
	write(t, p,
		assistant(tool("toolu_S", "SendMessage", m{"to": "payments-api", "message": "idempotency_key, today"})),
		result("toolu_S"),
	)
	res, err = r.Read("claude", p, "/w/acme", res.Next)
	if err != nil {
		t.Fatal(err)
	}
	if res.Items[0].ID != q.ID || !res.Items[0].Msg.Answered {
		t.Fatalf("resent = %s %+v", kinds(res.Items), res.Items[0])
	}
}

func TestThePersonsPromptSettlesAQuestion(t *testing.T) {
	res := readAll(t,
		user("Another Claude session sent a message:\n<teammate-message teammate_id=\"export-job\" color=\"green\">\nShould I switch the export reads now?\n</teammate-message>"),
		user("Tell export-job to wait"),
	)
	if !res.Items[0].Msg.Answered {
		t.Fatalf("question = %+v", res.Items[0].Msg)
	}
}

func TestTeammatesAndTheLead(t *testing.T) {
	res := readAll(t,
		// A plain user line: today's chat drew it as the person's bubble.
		user("Another Claude session sent a message:\n<teammate-message teammate_id=\"schema-review\" color=\"blue\" summary=\"Schema is fine; one nit\">\nSchema looks right. Swap the two lines in the down migration and it's good to go.\n</teammate-message>"),
		user("Another Claude session sent a message:\n<teammate-message teammate_id=\"webhook-v2\" color=\"yellow\">\n{\"type\":\"idle_notification\",\"from\":\"webhook-v2\",\"idleReason\":\"available\"}\n</teammate-message>"),
		user("Another Claude session sent a message:\n<teammate-message teammate_id=\"webhook-v2\" color=\"yellow\">\n{\"type\":\"idle_notification\",\"from\":\"webhook-v2\",\"result\":\"Webhook v2 is deployed to staging.\"}\n</teammate-message>"),
		user("Another Claude session sent a message:\n<teammate-message teammate_id=\"team-lead\">\nWrap up by five.\n</teammate-message>"),
		user("Another Claude session sent a message:\n<teammate-message teammate_id=\"webhook-v2\" color=\"yellow\">\n{\"type\":\"shutdown_request\",\"from\":\"webhook-v2\"}\n</teammate-message>"),
		queued("From the lead: hold the backfill until export-job confirms.", m{"kind": "coordinator"}),
	)
	if got := kinds(res.Items); got != "agent-message,ping,agent-message,agent-message,ping,agent-message" {
		t.Fatalf("kinds = %s", got)
	}
	it := res.Items
	if s := it[0].Msg; s.From.Kind != "teammate" || s.From.Color != "blue" || s.Intent != "update" || s.Summary != "Schema is fine; one nit" {
		t.Fatalf("teammate = %+v", s)
	}
	if i := it[1].Msg; i.Status != "info" || i.Summary != "webhook-v2 is free" || i.From.Color != "yellow" {
		t.Fatalf("idle = %+v", i)
	}
	if r := it[2].Msg; r.Body != "Webhook v2 is deployed to staging." || r.Intent != "update" {
		t.Fatalf("idle with result = %+v", r)
	}
	if l := it[3].Msg; l.From.Kind != "lead" || l.Intent != "instruction" {
		t.Fatalf("team lead = %+v", l)
	}
	if s := it[4].Msg; s.Summary != "webhook-v2: shutdown request" {
		t.Fatalf("shutdown = %+v", s)
	}
	if l := it[5].Msg; l.From.Kind != "lead" || l.Intent != "instruction" || l.Body != "hold the backfill until export-job confirms." {
		t.Fatalf("coordinator = %+v", l)
	}
	for _, x := range only(t, it, "user") {
		t.Fatalf("a message drawn as the person's: %q", x.Text)
	}
}

func TestPersistedReportKeepsItsPreviewAndPath(t *testing.T) {
	report := "<persisted-output>\nOutput too large (52.1KB). Full output saved to: /home/me/.claude/acme/tool-results/r1.txt\n\nPreview (first 2KB):\n# Full audit\n\nEvery write is listed below.\n...\n</persisted-output>"
	res := readAll(t, meta(handback("a9e8d7c6b5a4f3e21", report), m{"kind": "peer", "handback": true}))
	h := res.Items[0].Msg
	if h.Saved != "/home/me/.claude/acme/tool-results/r1.txt" || h.Title != "Full audit" || strings.Contains(h.Body, "persisted-output") || strings.HasSuffix(h.Body, "...") {
		t.Fatalf("persisted = %+v", h)
	}
	// Not one of this agent's helpers: named from its ID.
	if h.From.Kind != "helper" || h.From.Name != "Helper a9e8d7c" || h.From.Helper != "" {
		t.Fatalf("from = %+v", h.From)
	}
}

func TestSameMessageTwoWaysShowsOnce(t *testing.T) {
	note := taskNotification("b4", "", "completed", `Background command "Build" completed (exit code 0)`, "")
	res := readAll(t,
		queued(note, m{"kind": "task-notification"}),
		meta(note, m{"kind": "task-notification"}),
	)
	if got := kinds(res.Items); got != "ping" || res.Items[0].Msg.Repeat != 0 {
		t.Fatalf("items = %s %+v", got, res.Items)
	}
}

func TestSameAgentMessageTwiceCounts(t *testing.T) {
	msg := "Another Claude session sent a message:\n<cross-session-message from=\"payments-api\">\nWebhook v2 is merged.\n</cross-session-message>"
	res := readAll(t, user(msg), user(msg))
	if got := kinds(res.Items); got != "agent-message" || res.Items[0].Msg.Repeat != 2 {
		t.Fatalf("items = %s %+v", got, res.Items)
	}
}

func TestUnknownMetaAndTagsStayAsBefore(t *testing.T) {
	res := readAll(t,
		// A meta line with an origin it doesn't know words for: dropped.
		meta("Some note Claude Code keeps for itself", m{"kind": "peer"}),
		// A tag the person didn't type: skipped, as userText always did.
		user("<local-command-caveat>Caveat: ignore</local-command-caveat>"),
		user("<command-name>/model</command-name><command-args>opus</command-args>"),
		user("Plain words"),
	)
	if got := kinds(res.Items); got != "command,user" {
		t.Fatalf("kinds = %s", got)
	}
}

func TestCodexLeavesItsTurnsAlone(t *testing.T) {
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	write(t, p,
		m{"type": "response_item", "payload": m{"type": "message", "role": "user", "content": []m{{"type": "input_text", "text": "Fix the acme webhook"}}}},
		m{"type": "response_item", "payload": m{"type": "function_call", "name": "spawn_agent", "call_id": "c1", "arguments": `{"message":"look"}`}},
		m{"type": "response_item", "payload": m{"type": "function_call_output", "call_id": "c1", "output": "agent started"}},
	)
	res, err := NewReader().Read("codex", p, "/w/acme", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := kinds(res.Items); got != "user,tools" {
		t.Fatalf("kinds = %s", got)
	}
}

// A helper's notification, or its hand-back, while the agent waits on its
// questions isn't the person's answer: the questions stay open until the
// person replies.
func TestAHelpersWordDoesntAnswerTheAgentsQuestion(t *testing.T) {
	lines := append(launch("toolu_L", "Map ledger writes", "a3f9c1e7b2d4a6c80"),
		assistant(tool("q1", "AskUserQuestion", m{"questions": threeQuestions})),
		meta(taskNotification("a3f9c1e7b2d4a6c80", "toolu_L", "completed", `Agent "Map ledger writes" finished`, ""), m{"kind": "task-notification"}),
		meta(handback("a3f9c1e7b2d4a6c80", "Ledger writes go through acme/ledger.go only."), m{"kind": "peer", "from": "a3f9c1e7b2d4a6c80", "handback": true}),
	)
	res := readAll(t, lines...)
	q := only(t, res.Items, "question")
	if len(q) != 1 || q[0].Done {
		t.Fatalf("after the helper's word: %+v", q)
	}
	if len(only(t, res.Items, "agent-message")) != 1 {
		t.Fatalf("the hand-back isn't shown: %s", kinds(res.Items))
	}
	res = readAll(t, append(lines, user("Skip the questions, just write it"))...)
	// It closes them unanswered: the prompt is no answer to them.
	if q := only(t, res.Items, "question"); len(q) != 1 || !q[0].Done || !q[0].Error || len(q[0].Answers) != 0 {
		t.Fatalf("after the person's prompt: %+v", q)
	}
}
