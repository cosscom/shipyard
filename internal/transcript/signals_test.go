package transcript

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The shapes below are Claude Code's and Codex's own, as they write them
// (2.1.28x and Codex 0.130).

func read(t *testing.T, source, p string) Result {
	t.Helper()
	r, err := NewReader().Read(source, p, "/w", 0)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func notices(items []Item) []string {
	var out []string
	for _, it := range items {
		if it.Kind == "notice" {
			out = append(out, it.Notice+":"+it.Text)
		}
	}
	return out
}

func TestClaudeSignals(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p,
		m{"type": "permission-mode", "permissionMode": "plan", "sessionId": "x"},
		m{"type": "user", "permissionMode": "plan", "message": m{"role": "user", "content": "Plan the change"}},
		m{"type": "assistant", "effort": "high", "message": m{"model": "claude-opus-5-5", "role": "assistant", "content": []m{{"type": "text", "text": "Planning."}},
			"usage": m{"input_tokens": 6, "cache_creation_input_tokens": 1200, "cache_read_input_tokens": 40000, "output_tokens": 300}}},
		m{"type": "permission-mode", "permissionMode": "acceptEdits"},
	)
	s := read(t, "claude", p).Signals
	if s.Mode != "acceptEdits" || s.Model != "claude-opus-5-5" || s.Effort != "high" {
		t.Fatalf("mode/model/effort = %q %q %q", s.Mode, s.Model, s.Effort)
	}
	if s.Context == nil || s.Context.Tokens != 41206 {
		t.Fatalf("context = %+v", s.Context)
	}
}

// The signals are read in the same pass as the conversation: a signal's
// field of a shape they don't know leaves that line's signals unread, never
// its words.
func TestClaudeSignalOfAnotherShape(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p,
		m{"type": "assistant", "effort": "high", "message": m{"model": "claude-acme-1", "role": "assistant", "content": []m{{"type": "text", "text": "First."}}}},
		m{"type": "assistant", "effort": m{"level": "max"}, "message": m{"model": "claude-acme-2", "role": "assistant", "content": []m{{"type": "text", "text": "Second."}}}},
	)
	res := read(t, "claude", p)
	if n := len(res.Items); n != 2 || res.Items[1].Text != "Second." {
		t.Fatalf("items = %+v", res.Items)
	}
	if s := res.Signals; s.Model != "claude-acme-1" || s.Effort != "high" {
		t.Fatalf("model/effort = %q %q", s.Model, s.Effort)
	}
}

func TestClaudeTasks(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p,
		user("Do three things"),
		assistant(tool("c1", "TaskCreate", m{"subject": "Write the parser", "activeForm": "Writing the parser"})),
		user([]m{{"type": "tool_result", "tool_use_id": "c1", "content": "Task #1 created successfully: Write the parser"}}),
		assistant(tool("c2", "TaskCreate", m{"subject": "Test it"})),
		user([]m{{"type": "tool_result", "tool_use_id": "c2", "content": "Task #2 created successfully: Test it"}}),
		assistant(tool("u1", "TaskUpdate", m{"taskId": "1", "status": "in_progress"})),
		user([]m{{"type": "tool_result", "tool_use_id": "u1", "content": "Updated task #1 status"}}),
		assistant(tool("r1", "Read", m{"file_path": "/w/a.go"})),
	)
	r := read(t, "claude", p)
	got := r.Signals.Todos
	if len(got) != 2 || got[0].Status != "in_progress" || got[0].Active != "Writing the parser" || got[1].Status != "pending" || got[1].Text != "Test it" {
		t.Fatalf("todos = %+v", got)
	}
	// Task bookkeeping is not a step.
	if k := kinds(r.Items); k != "user,tools" {
		t.Fatalf("items = %s", k)
	}

	// TodoWrite replaces the list whole.
	write(t, p, assistant(tool("t1", "TodoWrite", m{"todos": []m{
		{"content": "One", "status": "completed", "activeForm": "Doing one"},
		{"content": "Two", "status": "in_progress", "activeForm": "Doing two"},
		{"content": "Three", "status": "pending", "activeForm": "Doing three"},
	}})))
	got = read(t, "claude", p).Signals.Todos
	if len(got) != 3 || got[1].Active != "Doing two" || got[0].Status != "completed" {
		t.Fatalf("todos after TodoWrite = %+v", got)
	}
}

func TestClaudeTaskListStartsAfresh(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p,
		m{"type": "permission-mode", "permissionMode": "default"},
		assistant(tool("c1", "TaskCreate", m{"subject": "Old"})),
		user([]m{{"type": "tool_result", "tool_use_id": "c1", "content": "Task #1 created successfully: Old"}}),
		assistant(tool("u1", "TaskUpdate", m{"taskId": "1", "status": "completed"})),
		m{"type": "permission-mode", "permissionMode": "default"},
		assistant(tool("c2", "TaskCreate", m{"subject": "New"})),
		user([]m{{"type": "tool_result", "tool_use_id": "c2", "content": "Task #2 created successfully: New"}}),
	)
	got := read(t, "claude", p).Signals.Todos
	if len(got) != 1 || got[0].Text != "New" {
		t.Fatalf("todos = %+v", got)
	}
}

func TestClaudeNotices(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	apiErr := func(kind, text string) m {
		return m{"type": "assistant", "isApiErrorMessage": true, "error": kind, "message": m{"model": "<synthetic>", "role": "assistant", "content": []m{{"type": "text", "text": text}},
			"usage": m{"input_tokens": 0}}}
	}
	write(t, p,
		user("Go"),
		m{"type": "system", "subtype": "api_error", "level": "error", "error": m{"message": "Connection error.", "formatted": "Connection dropped (ECONNRESET)"}, "retryAttempt": 2, "maxRetries": 10},
	)
	r := read(t, "claude", p)
	if r.Signals.Retrying == nil || r.Signals.Retrying.Attempt != 2 || r.Signals.Retrying.Message != "Connection dropped (ECONNRESET)" {
		t.Fatalf("retrying = %+v", r.Signals.Retrying)
	}
	write(t, p,
		apiErr("server_error", "API Error: Connection lost mid-response. The response above may be incomplete."),
		apiErr("authentication_failed", "Login expired · Please run /login"),
		apiErr("rate_limit", "Claude AI usage limit reached|1760000000"),
		apiErr("", "5-hour limit reached ∙ resets 3pm"),
		user([]m{{"type": "text", "text": "[Request interrupted by user for tool use]"}}),
		m{"type": "attachment", "attachment": m{"type": "hook_non_blocking_error", "hookName": "PostToolUse:Edit", "stderr": "prettier: not found", "exitCode": 127}},
	)
	r = read(t, "claude", p)
	got := strings.Join(notices(r.Items), "\n")
	want := strings.Join([]string{
		"api_error:API Error: Connection lost mid-response. The response above may be incomplete.",
		"auth:Login expired · Please run /login",
		"limit:Claude AI usage limit reached",
		"limit:5-hour limit reached ∙ resets 3pm",
		"interrupted:Interrupted",
		"hook:PostToolUse:Edit hook failed: prettier: not found",
	}, "\n")
	if got != want {
		t.Fatalf("notices:\n%s\nwant:\n%s", got, want)
	}
	for _, it := range r.Items {
		if it.Notice == "limit" && strings.HasPrefix(it.Text, "Claude AI") && it.Resets != 1760000000000 {
			t.Fatalf("resets = %d", it.Resets)
		}
		if it.Kind == "user" && strings.Contains(it.Text, "interrupted") {
			t.Fatal("an interruption reads as the person's words")
		}
		if it.Kind == "text" {
			t.Fatalf("an API error reads as the agent's answer: %q", it.Text)
		}
	}
	if r.Signals.Retrying != nil {
		t.Fatal("still retrying after the request gave up")
	}
	// The synthetic reply's empty usage leaves the context as it was.
	if r.Signals.Context != nil {
		t.Fatalf("context = %+v", r.Signals.Context)
	}
}

func TestClaudeBackground(t *testing.T) {
	dir := t.TempDir()
	tasks := filepath.Join(dir, "tasks")
	os.MkdirAll(tasks, 0o700)
	out := filepath.Join(tasks, "b1895wo0t.output")
	os.WriteFile(out, []byte("1\n2\n3\n"), 0o600)
	p := filepath.Join(dir, "s.jsonl")
	write(t, p,
		user("Count slowly in the background"),
		assistant(tool("b1", "Bash", m{"command": "for i in $(seq 1 50); do echo $i; sleep 1; done", "description": "Count to 50", "run_in_background": true})),
		user([]m{{"type": "tool_result", "tool_use_id": "b1", "content": "Command running in background with ID: b1895wo0t. Output is being written to: " + out + ". You will be notified when it completes."}}),
		assistant(tool("m1", "Monitor", m{"command": "tail -f x.log", "description": "watch the log"})),
		user([]m{{"type": "tool_result", "tool_use_id": "m1", "content": "Monitor started (task ba5rozuf0, expires in 30m)"}}),
	)
	bg := read(t, "claude", p).Signals.Background
	if len(bg) != 2 || bg[0].State != "running" || bg[0].Task != "b1895wo0t" || bg[0].Label != "Count to 50" || bg[1].Kind != "monitor" || bg[1].Task != "ba5rozuf0" {
		t.Fatalf("background = %+v", bg)
	}
	// Its details read the output so far.
	d, err := Detail("claude", p, dir, "b1")
	if err != nil || d.Output != "1\n2\n3\n" || !d.Live {
		t.Fatalf("detail = %+v, %v", d, err)
	}
	write(t, p,
		m{"type": "attachment", "attachment": m{"type": "queued_command", "commandMode": "task-notification", "prompt": "<task-notification>\n<task-id>b1895wo0t</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n</task-notification>"}},
		assistant(tool("k1", "TaskStop", m{"task_id": "ba5rozuf0"})),
	)
	bg = read(t, "claude", p).Signals.Background
	if bg[0].State != "done" || bg[1].State != "stopped" {
		t.Fatalf("background after = %+v", bg)
	}
}

// A shell's output file ends with "[exited with code N]" when it ends: the
// shell reads as ended from that, though no notification says so yet.
func TestAShellEndsWhenItsOutputSaysItExited(t *testing.T) {
	dir := t.TempDir()
	tasks := filepath.Join(dir, "tasks")
	os.MkdirAll(tasks, 0o755)
	p := filepath.Join(dir, "s.jsonl")
	bg := func(id, task string) []any {
		return []any{
			assistant(tool(id, "Bash", m{"command": "make " + id, "description": "Make " + id, "run_in_background": true})),
			user([]m{{"type": "tool_result", "tool_use_id": id, "content": "Command running in background with ID: " + task + ". Output is being written to: " + filepath.Join(tasks, task+".output") + ". You will be notified when it completes."}}),
		}
	}
	var lines []any
	lines = append(lines, user("Make them all"))
	for _, s := range [][2]string{{"ok", "bok"}, {"bad", "bbad"}, {"mid", "bmid"}, {"none", "bnone"}, {"told", "btold"}} {
		lines = append(lines, bg(s[0], s[1])...)
	}
	// A monitor whose output reads the same is a monitor still.
	lines = append(lines,
		assistant(tool("mon", "Monitor", m{"command": "tail -f x.log", "description": "watch the log"})),
		user([]m{{"type": "tool_result", "tool_use_id": "mon", "content": "Monitor started (task bmon). Output is being written to: " + filepath.Join(tasks, "bmon.output")}}),
	)
	write(t, p, lines...)
	ended := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	put := func(task, text string) {
		f := filepath.Join(tasks, task+".output")
		os.WriteFile(f, []byte(text), 0o644)
		os.Chtimes(f, ended, ended)
	}
	put("bok", "built\n\n[exited with code 0]\n")
	put("bbad", "lint: 3 problems\n[exited with code 3]\n\n")
	put("bmid", "it printed [exited with code 0]\n[exited with code 0]\nand went on\n")
	put("btold", "done\n[exited with code 0]\n")
	put("bmon", "[exited with code 0]\n")
	// "bnone" has no output file.
	r := NewReader()
	res, err := r.Read("claude", p, "/w", 0)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Job{}
	for _, j := range res.Signals.Background {
		got[j.Tool] = j
	}
	exit := func(j Job) string {
		if j.Exit == nil {
			return "-"
		}
		return strconv.Itoa(*j.Exit)
	}
	for _, c := range []struct{ tool, state, exit string }{{"ok", "done", "0"}, {"bad", "failed", "3"}, {"mid", "running", "-"}, {"none", "running", "-"}, {"mon", "running", "-"}} {
		if j := got[c.tool]; j.State != c.state || exit(j) != c.exit {
			t.Errorf("%s = %s exit %s, want %s exit %s", c.tool, j.State, exit(j), c.state, c.exit)
		}
	}
	if j := got["ok"]; j.Until != ended.UnixMilli() {
		t.Errorf("ok ended at %d, want the file's time %d", j.Until, ended.UnixMilli())
	}
	// A notification, when one comes, has the last word.
	write(t, p, m{"type": "attachment", "attachment": m{"type": "queued_command", "prompt": "<task-notification>\n<task-id>btold</task-id>\n<tool-use-id>told</tool-use-id>\n<status>killed</status>\n<summary>Background command \"Make told\" was stopped</summary>\n</task-notification>"}})
	// The same reader, followed: "mid" ends later, with no new line in the
	// transcript.
	put("bmid", "it printed [exited with code 0]\nand ended\n[exited with code 0]\n")
	res, err = r.Read("claude", p, "/w", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, j := range res.Signals.Background {
		got[j.Tool] = j
	}
	if j := got["told"]; j.State != "stopped" {
		t.Errorf("told = %s after its notification, want stopped", j.State)
	}
	if j := got["mid"]; j.State != "done" || exit(j) != "0" {
		t.Errorf("mid = %s exit %s once its output says it exited, want done exit 0", j.State, exit(j))
	}
}

func TestLiveOutputOnlyReadsTaskFiles(t *testing.T) {
	d := ToolDetail{Output: "Output is being written to: /etc/passwd.output. x"}
	liveOutput(&d)
	if !strings.HasPrefix(d.Output, "Output is being") {
		t.Fatalf("read a file outside a tasks folder: %q", d.Output)
	}
}

func TestCodexSignals(t *testing.T) {
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	write(t, p,
		m{"type": "turn_context", "payload": m{"approval_policy": "on-request", "model": "gpt-5.5", "effort": "medium"}},
		m{"type": "event_msg", "payload": m{"type": "token_count", "info": m{"last_token_usage": m{"input_tokens": 24095, "total_tokens": 24404}, "model_context_window": 258400}}},
		m{"type": "response_item", "payload": m{"type": "function_call", "name": "update_plan", "call_id": "p1", "arguments": `{"plan":[{"step":"Read","status":"completed"},{"step":"Fix","status":"in_progress"}]}`}},
		m{"type": "event_msg", "payload": m{"type": "turn_aborted", "reason": "interrupted"}},
	)
	r := read(t, "codex", p)
	s := r.Signals
	if s.Mode != "on-request" || s.Model != "gpt-5.5" || s.Effort != "medium" || s.Context.Tokens != 24404 || s.Context.Window != 258400 {
		t.Fatalf("signals = %+v %+v", s, s.Context)
	}
	if len(s.Todos) != 2 || s.Todos[1].Status != "in_progress" {
		t.Fatalf("todos = %+v", s.Todos)
	}
	if got := notices(r.Items); len(got) != 1 || got[0] != "interrupted:Interrupted" {
		t.Fatalf("notices = %v (items %s)", got, kinds(r.Items))
	}
}

// A shell's exit code is the one its notification ends with, not text in
// its command that reads like one.
func TestAShellsExitCodeIsTheNotificationsOwn(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p,
		assistant(tool("e1", "Bash", m{"command": "echo 'exit code 3'", "description": "Say exit code 3", "run_in_background": true})),
		user([]m{{"type": "tool_result", "tool_use_id": "e1", "content": "Command running in background with ID: be1. Output is being written to: /gone/tasks/be1.output."}}),
		m{"type": "attachment", "attachment": m{"type": "queued_command", "prompt": "<task-notification>\n<task-id>be1</task-id>\n<tool-use-id>e1</tool-use-id>\n<status>completed</status>\n<summary>Background command \"echo 'exit code 3'\" completed (exit code 0)</summary>\n</task-notification>"}},
	)
	bg := read(t, "claude", p).Signals.Background
	if len(bg) != 1 || bg[0].State != "done" || bg[0].Exit == nil || *bg[0].Exit != 0 {
		t.Fatalf("background = %+v", bg)
	}
}

// A shell that prints the line itself and goes on is running again once it
// prints more; and a pipe where its output file should be is never opened,
// so it can't hold up the reader.
func TestAShellsOutputFileOnlyEndsItWhileItSaysSo(t *testing.T) {
	dir := t.TempDir()
	tasks := filepath.Join(dir, "tasks")
	os.MkdirAll(tasks, 0o755)
	p := filepath.Join(dir, "s.jsonl")
	for _, s := range [][2]string{{"liar", "bliar"}, {"pipe", "bpipe"}} {
		write(t, p,
			assistant(tool(s[0], "Bash", m{"command": "x", "description": s[0], "run_in_background": true})),
			user([]m{{"type": "tool_result", "tool_use_id": s[0], "content": "Command running in background with ID: " + s[1] + ". Output is being written to: " + filepath.Join(tasks, s[1]+".output") + "."}}),
		)
	}
	if err := syscall.Mkfifo(filepath.Join(tasks, "bpipe.output"), 0o600); err != nil {
		t.Fatal(err)
	}
	liar := filepath.Join(tasks, "bliar.output")
	os.WriteFile(liar, []byte("[exited with code 0]\n"), 0o644)
	r := NewReader()
	states := func() map[string]string {
		t.Helper()
		done := make(chan Result, 1)
		go func() {
			res, _ := r.Read("claude", p, "/w", 0)
			done <- res
		}()
		select {
		case res := <-done:
			out := map[string]string{}
			for _, j := range res.Signals.Background {
				out[j.Tool] = j.State
			}
			return out
		case <-time.After(5 * time.Second):
			t.Fatal("reading the conversation waited on a pipe")
			return nil
		}
	}
	if s := states(); s["liar"] != "done" || s["pipe"] != "running" {
		t.Fatalf("while its file ends with the line: %v", s)
	}
	os.WriteFile(liar, []byte("[exited with code 0]\nand on it goes\n"), 0o644)
	if s := states(); s["liar"] != "running" {
		t.Fatalf("once it printed more: %v", s)
	}
}
