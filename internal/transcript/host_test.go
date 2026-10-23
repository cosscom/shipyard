package transcript

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// claude_host_ask.jsonl is an agent-host log of a structured Claude Code
// session (recorded, then cut down and made anonymous): a prompt, a
// question the agent asked with its own form and was answered, and its
// reply, among the stream's other lines.
func TestAStructuredSessionsLogReadsAsItsConversation(t *testing.T) {
	path := filepath.Join("testdata", "claude_host_ask.jsonl")
	res, err := NewReader().Read(SourceClaudeHost, path, "/home/dev/acme", 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Source != "claude" {
		t.Fatalf("source %q", res.Source)
	}
	var kinds []string
	for _, it := range res.Items {
		kinds = append(kinds, it.Kind)
	}
	if got := strings.Join(kinds, " "); got != "user question text" {
		t.Fatalf("items = %s: %+v", got, res.Items)
	}
	user, q, reply := res.Items[0], res.Items[1], res.Items[2]
	if !strings.HasPrefix(user.Text, "Ask me whether I prefer tea") || user.UUID == "" {
		t.Fatalf("the prompt (sent once, echoed once) reads %+v", user)
	}
	if len(q.Questions) != 1 || q.Questions[0].Question != "Do you prefer Tea or Coffee?" || len(q.Answers) != 1 || q.Answers[0] != "Tea" || !q.Done {
		t.Fatalf("question = %+v", q)
	}
	if reply.Text != "You chose Tea." {
		t.Fatalf("reply = %+v", reply)
	}

	// A tool call's details and older pages read the same log.
	d, err := Detail(SourceClaudeHost, path, "/home/dev/acme", "toolu_01Tct9HfJ6SKZik2AZ5F7FHV")
	if err != nil || d.ID == "" {
		t.Fatalf("detail = %+v, %v", d, err)
	}
	page, err := Before(SourceClaudeHost, path, "/home/dev/acme", reply.Off, 10)
	if err != nil || len(page.Items) != 2 || page.Items[0].ID != user.ID {
		t.Fatalf("older page = %+v, %v", page, err)
	}
}

func TestOnlyTheConversationsOwnLinesAreUnwrapped(t *testing.T) {
	for _, tc := range []struct {
		line string
		ok   bool
	}{
		{`{"seq":1,"dir":"out","data":{"type":"assistant","message":{"content":"hi"}}}`, true},
		{`{"seq":1,"dir":"out","data":{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":"a helper's"}}}`, false},
		{`{"seq":1,"dir":"in","data":{"type":"user","message":{"content":"sent, and echoed when replayed"}}}`, false},
		{`{"seq":1,"dir":"out","data":{"type":"stream_event"}}`, false},
		{`{"seq":1,"dir":"out","data":{"type":"control_request"}}`, false},
		{`{"seq":1,"dir":"out","data":{"type":"system","subtype":"compact_boundary"}}`, true},
		{`{"seq":1,"dir":"out","text":"not json"}`, false},
	} {
		if _, ok := unwrapHost([]byte(tc.line)); ok != tc.ok {
			t.Errorf("%s: %v", tc.line, ok)
		}
	}
	line, _ := unwrapHost([]byte(`{"seq":1,"at":1791900000000,"dir":"out","data":{"type":"user","message":{"content":"x"}}}`))
	if !strings.HasPrefix(string(line), `{"timestamp":"2026-`) {
		t.Fatalf("no time: %s", line)
	}
}

// A skill loaded in a structured session (as Claude Code 2.1's stream
// writes it, recorded): its instructions come back as a user line marked
// isSynthetic, which isn't the person's and isn't shown; the call says
// which skill it was.
func TestASkillsInstructionsAreNotShownAsThePersonsMessage(t *testing.T) {
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"Use the acme-hello skill to greet acme."},"uuid":"u1","timestamp":"2026-10-15T12:00:00Z"}`,
		`{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Skill","input":{"skill":"acme-hello","args":"acme"}}]},"uuid":"a1","timestamp":"2026-10-15T12:00:01Z"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"Launching skill: acme-hello"}]},"uuid":"u2","timestamp":"2026-10-15T12:00:02Z"}`,
		`{"type":"user","isSynthetic":true,"message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /home/dev/acme/.claude/skills/acme-hello\n\n# Greeting acme\n\nReply with exactly: Hello from acme."}]},"uuid":"u3","timestamp":"2026-10-15T12:00:02Z"}`,
		`{"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[{"type":"text","text":"Hello from acme."}]},"uuid":"a2","timestamp":"2026-10-15T12:00:03Z"}`,
	}
	var log strings.Builder
	for i, l := range lines {
		fmt.Fprintf(&log, `{"seq":%d,"at":1791900001000,"dir":"out","data":%s}`+"\n", i+1, l)
	}
	path := filepath.Join(t.TempDir(), "log.jsonl")
	if err := os.WriteFile(path, []byte(log.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := NewReader().Read(SourceClaudeHost, path, "/home/dev/acme", 0)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, it := range res.Items {
		s := it.Kind + ":" + it.Text
		for _, c := range it.Items {
			s += c.Verb + " " + c.Target
		}
		got = append(got, s)
	}
	want := "user:Use the acme-hello skill to greet acme.|tools:Skill acme-hello|text:Hello from acme."
	if strings.Join(got, "|") != want {
		t.Fatalf("items %q, want %q", strings.Join(got, "|"), want)
	}
}

// A helper an agent leaves working in the background (an Agent call with
// run_in_background) is back when the stream says so, in a system line of
// its own (Claude Code 2.1, as recorded): the crew shows it back, its time
// stopped, though no user line carries the notification.
func TestAHelperIsBackWhenTheStreamSaysSo(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.jsonl")
	lines := []string{
		`{"seq":1,"at":1792200000000,"dir":"out","data":{"type":"user","message":{"role":"user","content":"Score the trial"}}}`,
		`{"seq":2,"at":1792200001000,"dir":"out","data":{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_score","name":"Agent","input":{"description":"Score the trial","subagent_type":"general-purpose","prompt":"...","run_in_background":true}}]}}}`,
		`{"seq":3,"at":1792200001500,"dir":"out","data":{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_score","content":[{"type":"text","text":"Async agent launched successfully. agentId: a6dfde406d4d6c871"}]}]}}}`,
		`{"seq":4,"at":1792200100000,"dir":"out","data":{"type":"system","subtype":"task_updated","task_id":"a6dfde406d4d6c871","patch":{"status":"completed"}}}`,
		`{"seq":5,"at":1792200100000,"dir":"out","data":{"type":"system","subtype":"task_notification","task_id":"a6dfde406d4d6c871","tool_use_id":"toolu_score","status":"completed","output_file":"/tmp/x.output"}}`,
	}
	crew := func(n int) []CrewMember {
		t.Helper()
		os.WriteFile(path, []byte(strings.Join(lines[:n], "\n")+"\n"), 0o644)
		res, err := NewReader().Read(SourceClaudeHost, path, "/home/dev/acme", 0)
		if err != nil {
			t.Fatal(err)
		}
		return res.Crew
	}
	if c := crew(4); len(c) != 1 || c[0].State != "running" {
		t.Fatalf("while it works: %+v", c)
	}
	c := crew(5)
	if len(c) != 1 || c[0].State != "finished" || c[0].Until != 1792200100000 {
		t.Fatalf("once the stream says it is back: %+v", c)
	}
}

func TestAnEditInAStructuredSessionsLogKeepsItsLineNumbers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	hunk := []Hunk{{OldStart: 12, OldLines: 1, NewStart: 12, NewLines: 1, Lines: []string{"-old", "+new"}}}
	res := user([]m{{"type": "tool_result", "tool_use_id": "toolu_e1", "content": "ok"}})
	res["tool_use_result"] = m{"structuredPatch": hunk}
	write(t, path,
		m{"seq": 1, "dir": "out", "data": assistant(tool("toolu_e1", "Edit", m{"file_path": "/home/dev/acme/notes.txt", "old_string": "old", "new_string": "new"}))},
		m{"seq": 2, "dir": "out", "data": res},
	)
	d, err := Detail(SourceClaudeHost, path, "/home/dev/acme", "toolu_e1")
	if err != nil || d.File != "notes.txt" || !reflect.DeepEqual(d.Hunks, hunk) {
		t.Fatalf("detail = %+v, %v", d, err)
	}
}

// An agent that asks its questions while a helper it left in the
// background works on: the helper's lines go on in the log, megabytes of
// them, and its notifications come back, but the question stays the
// conversation's last word and stays open, read live or afresh.
func TestAQuestionStaysOpenWhileItsHelpersWorkOn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	seq := 0
	out := func(data m) m {
		seq++
		return m{"seq": seq, "at": 1792200000000 + int64(seq)*1000, "dir": "out", "data": data}
	}
	helperLine := func(parent string, data m) m { data["parent_tool_use_id"] = parent; return out(data) }
	launched := func(call, agentID string) m {
		return out(user([]m{{"type": "tool_result", "tool_use_id": call, "content": "Async agent launched successfully. agentId: " + agentID}}))
	}
	back := func(call string) m {
		return out(m{"type": "system", "subtype": "task_notification", "tool_use_id": call, "status": "completed"})
	}
	write(t, path,
		out(user("Draft the acme release notes")),
		out(assistant(tool("toolu_tally", "Agent", m{"description": "Tally the changes", "run_in_background": true}))),
		launched("toolu_tally", "a1b2c3d4e5f6a7b8c"),
		out(assistant(tool("toolu_shots", "Agent", m{"description": "Take the screenshots", "run_in_background": true}))),
		launched("toolu_shots", "b1c2d3e4f5a6b7c8d"),
		// One helper is back before the question; the other after it.
		back("toolu_tally"),
		out(assistant(tool("toolu_ask", "AskUserQuestion", m{"questions": threeQuestions[:2]}))),
		out(m{"type": "control_request", "request_id": "r1", "request": m{"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": m{"questions": threeQuestions[:2]}}}),
	)
	live := NewReader()
	asked, err := live.Read(SourceClaudeHost, path, "/home/dev/acme", 0)
	if err != nil {
		t.Fatal(err)
	}
	pad := strings.Repeat("y", 16<<10)
	for i := 0; ; i++ {
		n := itoa(i)
		write(t, path,
			out(m{"type": "stream_event", "event": m{"type": "content_block_delta"}}),
			helperLine("toolu_shots", assistant(tool("toolu_r"+n, "Read", m{"file_path": "/home/dev/acme/shot" + n + ".png"}))),
			helperLine("toolu_shots", user([]m{{"type": "tool_result", "tool_use_id": "toolu_r" + n, "content": pad}})),
		)
		if st, _ := os.Stat(path); st.Size() > maxStart+(1<<20) {
			break
		}
	}
	write(t, path, back("toolu_shots"))

	open := func(how string, items []Item) {
		t.Helper()
		if len(items) == 0 {
			t.Fatalf("%s: nothing to show", how)
		}
		q := items[len(items)-1]
		if q.Kind != "question" || q.Done || q.Tool != "toolu_ask" || len(q.Questions) != 2 || len(q.Questions[1].Options) != 4 {
			t.Fatalf("%s: last item %+v, not the open question", how, q)
		}
	}
	more, err := live.Read(SourceClaudeHost, path, "/home/dev/acme", asked.Next)
	if err != nil {
		t.Fatal(err)
	}
	// The live read sends the open question again, still open and last.
	open("followed live", more.Items)
	for _, c := range more.Crew {
		if c.State != "finished" {
			t.Fatalf("a helper not back: %+v", more.Crew)
		}
	}
	afresh, err := NewReader().Read(SourceClaudeHost, path, "/home/dev/acme", 0)
	if err != nil {
		t.Fatal(err)
	}
	// Its last 4 MB are the helper's: the window reaches back to the
	// conversation, its prompt included.
	if afresh.Items[0].Kind != "user" {
		t.Fatalf("read afresh, the first item is %+v", afresh.Items[0])
	}
	open("read afresh", afresh.Items)
}
