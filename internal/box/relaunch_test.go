package box

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/transcript"
	"github.com/cosscom/shipyard/internal/wire"
)

func TestShellWordsReadsWhatShellQuoteWrites(t *testing.T) {
	args := []string{"/opt/berth tools/berthd", "agent-host", "it's", "", `a "quoted" $word`, "--permission-prompt-tool", "stdio"}
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = shellQuote(a)
	}
	got, ok := shellWords(strings.Join(quoted, " ") + "  --resume 'x'")
	if want := append(slices.Clone(args), "--resume", "x"); !ok || !slices.Equal(got, want) {
		t.Fatalf("words = %q, %v; want %q", got, ok, want)
	}
	if got, ok := shellWords(`a\ b "c \"d\"" e`); !ok || !slices.Equal(got, []string{"a b", `c "d"`, "e"}) {
		t.Fatalf("words = %q, %v", got, ok)
	}
	if _, ok := shellWords("claude 'unclosed"); ok {
		t.Fatal("an open quote split")
	}
}

func TestAnAgentHostCommandNamesItsConversation(t *testing.T) {
	b := &Box{ConversationsDir: t.TempDir()}
	conv := filepath.Join(b.ConversationsDir, "tnjr2z-0123456789ab")
	os.MkdirAll(conv, 0o700)
	os.WriteFile(filepath.Join(conv, metaName), []byte(`{"agent":"claude"}`), 0o600)
	host := "'/home/u/.local/bin/berthd' 'agent-host' --dir " + shellQuote(conv) + " --socket '/tmp/berth-1000/x.sock' -- claude '-p' '--permission-prompt-tool'"
	if got, ok := b.commandConversation(host); !ok || got != conv {
		t.Fatalf("conversation = %q, %v", got, ok)
	}
	for _, cmd := range []string{
		"claude --resume abc",
		"'berthd' 'agent-host' --dir '/elsewhere/tnjr2z-0123456789ab' -- claude",
		"'berthd' 'agent-host' --dir " + shellQuote(filepath.Join(b.ConversationsDir, "nope")) + " -- claude",
		"claude -- 'agent-host' --dir " + shellQuote(conv),
	} {
		if got, ok := b.commandConversation(cmd); ok {
			t.Fatalf("%q names %q", cmd, got)
		}
	}
}

// structuredBoxFor serves a box that runs the stand-in Claude under this
// test binary as its agent host, keeping its conversations in convs: a
// second one on the same folder is berthd started again.
func structuredBoxFor(t *testing.T, convs, repo string) (*wire.Client, *Box, *Turns) {
	t.Helper()
	exe, _ := os.Executable()
	states := &Turns{}
	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		bx = b
		b.Turns = states
		b.ConversationsDir = convs
		b.AgentHost = []string{"env", "BERTH_TEST_AGENT_HOST=1", exe}
	})
	states.Attach(bus)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	return c, bx, states
}

func fakeClaudeOnPath(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("the stand-in Claude needs python3")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte(fakeStreamClaude), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
}

func until(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("%s never happened", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func saidIn(t *testing.T, c *wire.Client, name, text string) func() bool {
	return func() bool {
		var res transcript.Result
		call(t, c, "GET", "/v1/sessions/"+name+"/transcript?since=0", "", nil, &res)
		for _, it := range res.Items {
			if strings.Contains(it.Text, text) {
				return true
			}
		}
		return false
	}
}

func finishedIn(states *Turns, name string) func() bool {
	return func() bool { st, _ := states.State(name); return st.State == "finished" }
}

// hostGoneFor waits for no host to answer for a conversation any more.
func hostGoneFor(t *testing.T, conv string) {
	t.Helper()
	sock, err := hostSocket(filepath.Base(conv))
	if err != nil {
		t.Fatal(err)
	}
	until(t, "the host's end", func() bool { return !hostAlive(sock) })
}

// appRestartCommand is what Shipyard's "Start again" made of a session's
// command (lib/derive.ts restartCommand): the last quoted word dropped, as
// a first prompt would be.
var appRestartCommand = regexp.MustCompile(`(?:\s+(?:--prompt|-i))?\s+'(?:[^']|'\\'')*'\s*$`)

// The box rebooted under a structured conversation: its tmux server, its
// agent host and berthd all went. Shipyard started it again from the
// command it had read back, cut short by a word, and Claude refused it
// ("option '--permission-prompt-tool <tool>' argument missing"). Started
// again from its conversation, it comes back with its whole command and
// --resume, and carries on.
func TestAConversationRunningWhenTheBoxRebootsComesBackWithItsWholeCommand(t *testing.T) {
	fakeClaudeOnPath(t)
	repo, convs := gitRepo(t), conversationsDir(t)
	c, bx, _ := structuredBoxFor(t, convs, repo)
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude", "mode": "bypassPermissions", "prompt": "hello"}, &sess); status != 200 {
		t.Fatalf("start: %d", status)
	}
	until(t, "the first reply", saidIn(t, c, sess.Name, "echo: hello"))
	live, err := bx.Sessions.Get(t.Context(), sess.Name)
	if err != nil || live.conv == "" {
		t.Fatalf("the session: %+v, %v", live, err)
	}
	conv, before := live.conv, live.Command
	if !strings.HasSuffix(before, "'--permission-prompt-tool' 'stdio'") {
		t.Fatalf("it started with %q", before)
	}

	// The reboot: every tmux session and the host in it are gone, and
	// berthd starts again on the same folders.
	exec.Command("tmux", "-L", tmuxSocket, "kill-server").Run()
	hostGoneFor(t, conv)
	c, _, states := structuredBoxFor(t, convs, repo)
	var none []Session
	if call(t, c, "GET", "/v1/sessions", "", nil, &none); len(none) != 0 {
		t.Fatalf("sessions after the reboot: %+v", none)
	}

	// What an older Shipyard sent: the command read back, its last word
	// taken for a prompt and dropped.
	cut := appRestartCommand.ReplaceAllString(before, "")
	if !strings.HasSuffix(cut, "'--permission-prompt-tool'") {
		t.Fatalf("cut to %q", cut)
	}
	var again Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "command": cut}, &again); status != 200 {
		t.Fatalf("start again: %d", status)
	}
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+again.Name, "", nil, nil) })
	if again.Driver != DriverClaude || again.Title != "hello" {
		t.Fatalf("it came back as %+v", again)
	}
	const sid = "00000000-0000-4000-8000-0000000000c1"
	if want := "'--permission-prompt-tool' 'stdio' --resume '" + sid + "'"; !strings.HasSuffix(again.Command, want) {
		t.Fatalf("it came back as %q, not ending %q", again.Command, want)
	}
	// Its log has the agent's command as it ran, word for word.
	var argv []string
	agenthost.ReadLog(filepath.Join(conv, agenthost.LogName), 0, func(e agenthost.Entry) error {
		if e.Dir == "host" && e.Event == "started" {
			argv = e.Argv
		}
		return nil
	})
	if n := len(argv); n < 4 || !slices.Equal(argv[n-4:], []string{"--permission-prompt-tool", "stdio", "--resume", sid}) {
		t.Fatalf("it ran %q", argv)
	}

	// It reaches its first turn since, the turns before it with it.
	call(t, c, "POST", "/v1/sessions/"+again.Name+"/send", "", map[string]any{"text": "after the reboot", "when": "now"}, nil)
	until(t, "a reply after the reboot", saidIn(t, c, again.Name, "echo: after the reboot"))
	until(t, "that turn's end", finishedIn(states, again.Name))
	until(t, "the turn before the reboot", saidIn(t, c, again.Name, "echo: hello"))
	var convsNow []Conversation
	call(t, c, "GET", "/v1/conversations", "", nil, &convsNow)
	if len(convsNow) != 1 || !convsNow[0].Live || convsNow[0].Session != again.Name || convsNow[0].Failed != nil {
		t.Fatalf("conversations = %+v", convsNow)
	}
}

// An agent started again that exits at once failed to start: the resume
// says so with what it wrote to its stderr, and the conversation and its
// session read as failed, not as running or as one to resume.
func TestARelaunchThatFailsIsReportedAsFailed(t *testing.T) {
	fakeClaudeOnPath(t)
	repo, convs := gitRepo(t), conversationsDir(t)
	c, bx, states := structuredBoxFor(t, convs, repo)
	var sess Session
	call(t, c, "POST", "/v1/sessions", "", map[string]any{"location": "acme", "agent": "claude", "driver": "claude", "prompt": "hello"}, &sess)
	until(t, "the first reply", saidIn(t, c, sess.Name, "echo: hello"))
	until(t, "the first turn's end", finishedIn(states, sess.Name))
	live, _ := bx.Sessions.Get(t.Context(), sess.Name)

	// Claude no longer has the conversation, so --resume refuses it.
	os.RemoveAll(filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), "projects"))
	if err := agenthost.Stop(t.Context(), live.sock); err != nil {
		t.Fatal(err)
	}
	until(t, "the session's end", func() bool {
		var list []Session
		call(t, c, "GET", "/v1/sessions", "", nil, &list)
		return len(list) == 1 && list[0].Exited
	})
	var refused struct{ Error, Code string }
	if status := call(t, c, "POST", "/v1/sessions/"+sess.Name+"/resume", "", nil, &refused); status != http.StatusConflict ||
		refused.Code != CodeAgentFailed || !strings.Contains(refused.Error, "No conversation found with session ID") {
		t.Fatalf("resume: %d %+v", status, refused)
	}
	var list []Session
	call(t, c, "GET", "/v1/sessions", "", nil, &list)
	if len(list) != 1 || !list[0].Exited || list[0].Failed == nil || list[0].Failed.Code != 1 || !strings.Contains(list[0].Failed.Error, "No conversation found") {
		t.Fatalf("sessions = %+v", list)
	}
	var cs []Conversation
	call(t, c, "GET", "/v1/conversations", "", nil, &cs)
	if len(cs) != 1 || cs[0].Live || cs[0].Failed == nil {
		t.Fatalf("conversations = %+v", cs)
	}

	// Its session gone too: carried on in a new one, which fails the same
	// way and leaves nothing running.
	call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil)
	if status := call(t, c, "POST", "/v1/conversations/"+cs[0].ID+"/resume", "", nil, &refused); status != http.StatusConflict || refused.Code != CodeAgentFailed {
		t.Fatalf("resume the conversation: %d %+v", status, refused)
	}
	list = nil
	call(t, c, "GET", "/v1/sessions", "", nil, &list)
	if len(list) != 0 {
		t.Fatalf("a failed start left %+v", list)
	}
}

// Two agents work in one checkout. Whether one's conversation runs is its
// own session's host, never the folder: the other running there blocks
// neither its resume nor carrying it on.
func TestTwoSessionsInOneFolderDontBlockEachOthersResume(t *testing.T) {
	fakeClaudeOnPath(t)
	t.Setenv("FAKE_CLAUDE_UNIQUE", "1")
	repo, convs := gitRepo(t), conversationsDir(t)
	c, bx, states := structuredBoxFor(t, convs, repo)
	start := func(name string) Session {
		t.Helper()
		var s Session
		if status := call(t, c, "POST", "/v1/sessions", "", map[string]any{"name": name, "location": "acme", "agent": "claude", "driver": "claude", "prompt": "hello " + name}, &s); status != 200 {
			t.Fatalf("start %s: %d", name, status)
		}
		t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+name, "", nil, nil) })
		until(t, name+"'s first turn", finishedIn(states, name))
		return s
	}
	start("integrator")
	start("worker")
	integrator, _ := bx.Sessions.Get(t.Context(), "integrator")
	sid := conversationSession(integrator.conv)
	if sid == "" || sid == conversationSession(mustSession(t, bx, "worker").conv) {
		t.Fatalf("the two share a conversation: %q", sid)
	}

	stop := func() {
		t.Helper()
		live, _ := bx.Sessions.Get(t.Context(), "integrator")
		if err := agenthost.Stop(t.Context(), live.sock); err != nil {
			t.Fatal(err)
		}
		until(t, "the integrator's end", func() bool { s, err := bx.Sessions.Get(t.Context(), "integrator"); return err == nil && s.Exited })
	}
	// Claude's own transcript of it, with its prompt: the worker's list of
	// past conversations offers it.
	transcriptOf := filepath.Join(claudeFolders(os.Getenv("CLAUDE_CONFIG_DIR"), repo)[0], sid+".jsonl")
	line, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "hello integrator"}, "sessionId": sid})
	if err := os.WriteFile(transcriptOf, append(line, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	pastIn := func(name string) PastSession {
		t.Helper()
		var past PastSessions
		call(t, c, "GET", "/v1/sessions/"+name+"/past", "", nil, &past)
		for _, p := range past.Sessions {
			if p.ID == sid {
				return p
			}
		}
		t.Fatalf("%s doesn't list the integrator's conversation: %+v", name, past)
		return PastSession{}
	}

	// Ended while the worker runs in the same folder: it resumes.
	stop()
	if p := pastIn("worker"); p.Session != "" {
		t.Fatalf("an ended conversation reads as running in %s", p.Session)
	}
	if status := call(t, c, "POST", "/v1/sessions/integrator/resume", "", nil, nil); status != 200 {
		t.Fatalf("resume beside the worker: %d", status)
	}
	call(t, c, "POST", "/v1/sessions/integrator/send", "", map[string]any{"text": "back", "when": "now"}, nil)
	until(t, "the integrator's reply", saidIn(t, c, "integrator", "echo: back"))
	// Running again, it is running in its own session, and only there.
	if p := pastIn("worker"); p.Session != "integrator" {
		t.Fatalf("the running conversation reads as running in %q", p.Session)
	}

	// Ended again, the worker carries it on: nothing holds it.
	stop()
	if status := call(t, c, "POST", "/v1/sessions/worker/resume", "", map[string]string{"agent_session_id": sid}, nil); status != 200 {
		t.Fatalf("carry it on in the worker: %d", status)
	}
	until(t, "the worker on the integrator's conversation", func() bool {
		return conversationSession(mustSession(t, bx, "worker").conv) == sid
	})
}

func mustSession(t *testing.T, bx *Box, name string) Session {
	t.Helper()
	s, err := bx.Sessions.Get(t.Context(), name)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// A reboot leaves the ledger's states of agents berth didn't start, by
// folder, saying they run. Settled as berthd starts, those that no agent
// works in are exited, and folders that are gone are forgotten, in the
// ledger and in agent-states.json.
func TestSettlingEndsAgentStatesNothingRuns(t *testing.T) {
	dir := t.TempDir()
	stale, working, finished, gone := t.TempDir(), t.TempDir(), t.TempDir(), filepath.Join(dir, "wt-1")
	now := time.Now().UTC()
	tr := &Turns{Path: filepath.Join(dir, "turns.json"), LegacyPath: filepath.Join(dir, "agent-states.json")}
	tr.init()
	tr.loaded = true
	tr.dirs[stale] = dirState{"running", now.Add(-10 * 24 * time.Hour)}
	tr.dirs[working] = dirState{"waiting", now.Add(-time.Hour)}
	tr.dirs[finished] = dirState{"finished", now.Add(-time.Hour)}
	tr.dirs[gone] = dirState{"idle", now.Add(-time.Hour)}
	tr.dirs[t.TempDir()] = dirState{"finished", now.Add(-agentStateTTL - time.Hour)}

	if n := tr.Settle(func(d string) bool { return d == working }, now); n != 3 {
		t.Fatalf("settled %d", n)
	}
	tr.save()
	raw, _ := os.ReadFile(tr.LegacyPath)
	var legacy map[string]dirState
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{stale: "exited", working: "waiting", finished: "finished"}
	if len(legacy) != len(want) {
		t.Fatalf("agent-states.json = %s", raw)
	}
	for d, st := range want {
		if legacy[d].State != st {
			t.Fatalf("%s is %q, want %q: %s", d, legacy[d].State, st, raw)
		}
	}
	if !legacy[stale].At.Equal(now.Add(-10 * 24 * time.Hour)) {
		t.Fatalf("its time moved: %v", legacy[stale].At)
	}
	if n := tr.Settle(func(d string) bool { return d == working }, now); n != 0 {
		t.Fatalf("settled again: %d", n)
	}
}

// What a start says in its log: the host it replaced ending is not its
// failure; an exit with an error after it started, or a host that couldn't
// run the agent at all, is; its first word of its own means it is up.
func TestAStartIsReadFromItsLog(t *testing.T) {
	code := func(c int) *int { return &c }
	write := func(entries ...agenthost.Entry) (string, int64) {
		t.Helper()
		dir := t.TempDir()
		log, err := agenthost.OpenLog(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer log.Close()
		log.Append(agenthost.Entry{Dir: "out", Data: json.RawMessage(`{"type":"result","session_id":"s"}`)})
		from := logEnd(dir)
		for _, e := range entries {
			log.Append(e)
		}
		return dir, from
	}
	sock := filepath.Join(t.TempDir(), "none.sock")

	dir, from := write(
		agenthost.Entry{Dir: "host", Event: "exited", Code: code(143)},
		agenthost.Entry{Dir: "host", Event: "started", PID: 7},
		agenthost.Entry{Dir: "err", Text: "error: option '--permission-prompt-tool <tool>' argument missing"},
		agenthost.Entry{Dir: "host", Event: "exited", Code: code(1)},
	)
	if f := awaitStart(dir, sock, from, time.Second); f == nil || f.Code != 1 || f.Error != "error: option '--permission-prompt-tool <tool>' argument missing" {
		t.Fatalf("a refused flag: %+v", f)
	}
	dir, from = write(agenthost.Entry{Dir: "host", Event: "exited", Code: code(127), Text: `exec: "claude": executable file not found in $PATH`})
	if f := awaitStart(dir, sock, from, time.Second); f == nil || f.Code != 127 || !strings.Contains(f.Error, "not found") {
		t.Fatalf("no agent to run: %+v", f)
	}
	dir, from = write(
		agenthost.Entry{Dir: "host", Event: "started", PID: 7},
		agenthost.Entry{Dir: "out", Data: json.RawMessage(`{"type":"system","subtype":"hook_started"}`)},
		agenthost.Entry{Dir: "host", Event: "exited", Code: code(1)},
	)
	if f := awaitStart(dir, sock, from, time.Second); f != nil {
		t.Fatalf("up, then ended later: %+v", f)
	}
}

// A box that can't list its processes (macOS has no /proc) can't tell an
// agent still running from one gone: it keeps their states, and only
// forgets folders that are gone.
func TestSettlingWithoutProcKeepsWhatMayStillRun(t *testing.T) {
	dir := t.TempDir()
	live, gone := t.TempDir(), filepath.Join(dir, "wt-1")
	now := time.Now().UTC()
	tr := &Turns{}
	tr.init()
	tr.loaded = true
	tr.dirs[live] = dirState{"running", now.Add(-time.Hour)}
	tr.dirs[gone] = dirState{"waiting", now.Add(-time.Hour)}
	b := &Box{Turns: tr}
	if n := b.settleAgentStates(filepath.Join(dir, "no-proc")); n != 1 {
		t.Fatalf("settled %d", n)
	}
	if st, ok := tr.dirs[live]; !ok || st.State != "running" {
		t.Fatalf("a folder that may still run is %+v", st)
	}
	if _, ok := tr.dirs[gone]; ok {
		t.Fatal("a gone folder stayed")
	}
}
