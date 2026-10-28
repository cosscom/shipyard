package box

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// A session's own variables come over the project's, which come over the
// box's; the rest of each still reaches it.
func TestASessionsOwnEnvironmentComesOverTheProjectsAndTheBoxs(t *testing.T) {
	var bx *Box
	envFile := filepath.Join(t.TempDir(), "env.json")
	c, _ := servedBox(t, func(b *Box) { b.EnvFile = envFile; bx = b })
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": gitRepo(t)}, nil)
	if err := saveBoxEnv(envFile, BoxEnv{Env: map[string]string{"ACCOUNT": "box", "TICKET": "box", "REGION": "box"}}); err != nil {
		t.Fatal(err)
	}
	if err := bx.Locations.SetLocalConfig("acme", RepoConfig{Env: map[string]string{"TICKET": "repo", "REGION": "repo"}}); err != nil {
		t.Fatal(err)
	}
	stop := func(name string) { t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+name, "", nil, nil) }) }
	want := map[string]string{"ACCOUNT": "box", "TICKET": "repo", "REGION": "eu-north", "RUN": "r-41 with spaces"}
	check := func(what string, sess Session) {
		t.Helper()
		for k, v := range want {
			if got := bx.Sessions.EnvVar(t.Context(), sess, k); got != v {
				t.Errorf("%s: %s = %q, want %q", what, k, got, v)
			}
		}
	}
	own := map[string]string{"REGION": "eu-north", "RUN": "r-41 with spaces"}

	var task Task
	if st := call(t, c, "POST", "/v1/tasks", "", TaskRequest{Location: "acme", Name: "billing", Command: "sleep 30", Env: own}, &task); st != 200 {
		t.Fatalf("task: %d", st)
	}
	stop(task.Session.Name)
	check("task new", task.Session)

	var sess Session
	if st := call(t, c, "POST", "/v1/sessions", "", SessionRequest{Name: "own", Location: "acme/billing", Command: "sleep 30", Env: own}, &sess); st != 200 {
		t.Fatalf("session: %d", st)
	}
	stop(sess.Name)
	check("session new", sess)

	// Without any, a session starts as it always did.
	var plain Session
	if st := call(t, c, "POST", "/v1/sessions", "", SessionRequest{Name: "plain", Location: "acme/billing", Command: "sleep 30"}, &plain); st != 200 {
		t.Fatalf("plain session: %d", st)
	}
	stop(plain.Name)
	if got := bx.Sessions.EnvVar(t.Context(), plain, "REGION"); got != "repo" {
		t.Fatalf("a session with no variables of its own has REGION=%q", got)
	}
}

// berthd's own variables say where a session is and who it is; a session
// can't claim others. Nothing is made for a request refused.
func TestASessionCantSetBerthdsOwnVariablesOrMalformedOnes(t *testing.T) {
	c, _ := servedBox(t)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	for _, tc := range []struct {
		env  map[string]string
		says string
	}{
		{map[string]string{"BERTH_SESSION": "someone-else"}, "BERTH_SESSION is set by berthd"},
		{map[string]string{"BERTH_PORT": "1"}, "BERTH_PORT is set by berthd"},
		{map[string]string{"BERTH_PORT_2": "1"}, "BERTH_PORT_2 is set by berthd"},
		{map[string]string{"BERTH_WORKTREE_PATH": "/"}, "BERTH_WORKTREE_PATH is set by berthd"},
		{map[string]string{"BERTH_DRIVER": ""}, "BERTH_DRIVER is set by berthd"},
		{map[string]string{"BERTH_OP": "/tmp/not-op"}, "BERTH_OP is set by berthd"},
		{map[string]string{"BERTH_HOME": "/tmp/elsewhere"}, "BERTH_HOME is set by berthd"},
		{map[string]string{"": "x"}, "an environment variable needs a name"},
		{map[string]string{"NOT A NAME": "x"}, `"NOT A NAME" is not an environment variable name`},
		{map[string]string{"NUL": "a\x00b"}, "NUL"},
	} {
		var resp struct{ Error string }
		if st := call(t, c, "POST", "/v1/tasks", "", TaskRequest{Location: "acme", Name: "refused", Command: "sleep 30", Env: tc.env}, &resp); st != 400 || !strings.Contains(resp.Error, tc.says) {
			t.Errorf("task with %q: %d %q, want 400 saying %q", tc.env, st, resp.Error, tc.says)
		}
		resp.Error = ""
		if st := call(t, c, "POST", "/v1/sessions", "", SessionRequest{Location: "acme", Command: "sleep 30", Env: tc.env}, &resp); st != 400 || !strings.Contains(resp.Error, tc.says) {
			t.Errorf("session with %q: %d %q, want 400 saying %q", tc.env, st, resp.Error, tc.says)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-refused")); err == nil {
		t.Fatal("a refused task made its worktree")
	}
	var all []Session
	call(t, c, "GET", "/v1/sessions", "", nil, &all)
	if len(all) != 0 {
		t.Fatalf("refused requests started %v", all)
	}
	// A name berthd doesn't set is the session's to use.
	var sess Session
	if st := call(t, c, "POST", "/v1/sessions", "", SessionRequest{Location: "acme", Command: "sleep 30", Env: map[string]string{"BERTH_TICKET": "T-7"}}, &sess); st != 200 {
		t.Fatalf("BERTH_TICKET: %d", st)
	}
	call(t, c, "DELETE", "/v1/sessions/"+sess.Name, "", nil, nil)
}

// Every BERTH_ variable berthd gives a worktree's sessions is one a
// session can't set: the list of berthd's own keeps up with the box.
func TestEveryVariableBerthdSetsIsRefusedForASession(t *testing.T) {
	ctx := t.Context()
	repo := gitRepo(t)
	dir := t.TempDir()
	b := &Box{Name: "devbox", Locations: NewLocations(filepath.Join(dir, "locations.json")), Sessions: testSessions(t)}
	b.Locations.Add(ctx, "acme", repo)
	if err := b.Locations.SetLocalConfig("acme", RepoConfig{Ports: 3}); err != nil {
		t.Fatal(err)
	}
	wt, _ := b.Locations.CreateWorktree(ctx, "acme", "billing", "", "")
	sess, err := b.createAgentSessionWith(ctx, "probe", "acme/billing", wt.Path, "sleep 30", "claude", []string{"BERTH_DRIVER=structured"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Sessions.Kill(ctx, sess.Name) })
	out, err := b.Sessions.tmux(ctx, "show-environment", "-t", "="+sess.Name)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, line := range strings.Split(string(out), "\n") {
		k, _, ok := strings.Cut(line, "=")
		if !ok || !strings.HasPrefix(k, "BERTH_") {
			continue
		}
		seen++
		if CheckSessionEnv(map[string]string{k: "x"}) == nil {
			t.Errorf("berthd sets %s, yet a session may set it too", k)
		}
	}
	if seen < 10 {
		t.Fatalf("the session had %d BERTH_ variables: %s", seen, out)
	}
}

// A structured agent's session has them too, and a switch between its
// terminal and the chat, which runs it again in the same pane, keeps them
// over the project's.
func TestAStructuredAgentKeepsItsOwnVariablesAcrossASwitch(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads the pane's environment from /proc")
	}
	// berthd's own environment sets no browser timeout, so a switch has a
	// default to give, which the session's own must win over.
	t.Setenv(AgentBrowserIdleEnv, "")
	os.Unsetenv(AgentBrowserIdleEnv)
	c, bx := structuredBox(t)
	if err := bx.Locations.SetLocalConfig("acme", RepoConfig{Env: map[string]string{"REGION": "repo"}}); err != nil {
		t.Fatal(err)
	}
	var task Task
	if st := call(t, c, "POST", "/v1/tasks", "", TaskRequest{Location: "acme", Name: "chat", Agent: "claude", Driver: DriverClaude, Prompt: "hello", Env: map[string]string{"REGION": "eu-north", "RUN": "r-41", AgentBrowserIdleEnv: "0"}}, &task); st != 200 {
		t.Fatalf("task: %d", st)
	}
	t.Cleanup(func() { call(t, c, "DELETE", "/v1/sessions/"+task.Session.Name, "", nil, nil) })
	if task.Session.Driver != DriverClaude {
		t.Fatalf("the agent ran %q", task.Session.Driver)
	}
	paneEnv := func() map[string]string {
		t.Helper()
		live, err := bx.Sessions.Get(t.Context(), task.Session.Name)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile("/proc/" + strconv.Itoa(live.panePID) + "/environ")
		if err != nil {
			t.Fatal(err)
		}
		return parseEnv(splitNul(raw))
	}
	if env := paneEnv(); env["REGION"] != "eu-north" || env["RUN"] != "r-41" || env["BERTH_DRIVER"] != "structured" {
		t.Fatalf("the chat's pane has REGION=%q RUN=%q BERTH_DRIVER=%q", env["REGION"], env["RUN"], env["BERTH_DRIVER"])
	}
	live, err := bx.Sessions.Get(t.Context(), task.Session.Name)
	if err != nil {
		t.Fatal(err)
	}
	if err := bx.respawnAgent(t.Context(), live, "sleep 30", []string{"BERTH_DRIVER="}, nil); err != nil {
		t.Fatal(err)
	}
	if env := paneEnv(); env["REGION"] != "eu-north" || env["RUN"] != "r-41" || env[AgentBrowserIdleEnv] != "0" {
		t.Fatalf("after the switch the pane has REGION=%q RUN=%q %s=%q", env["REGION"], env["RUN"], AgentBrowserIdleEnv, env[AgentBrowserIdleEnv])
	}
}
