package box

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
)

func writeRepoConfig(t *testing.T, repo string, c RepoConfig) {
	t.Helper()
	os.MkdirAll(filepath.Join(repo, ".berth"), 0o755)
	b, _ := json.Marshal(c)
	os.WriteFile(filepath.Join(repo, RepoConfigFile), b, 0o600)
}

// trustRepo trusts a location's repository config as it is now, as someone
// who reviewed it would.
func trustRepo(t *testing.T, l *Locations, name string) {
	t.Helper()
	c, err := l.Config(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	if err := l.TrustRepo(name, c.RepoTrust.Hash); err != nil {
		t.Fatal(err)
	}
}

func TestLocalConfigLaysOverTheRepositorys(t *testing.T) {
	ctx := context.Background()
	repo := gitRepo(t)
	writeRepoConfig(t, repo, RepoConfig{
		Setup:    "pnpm install",
		Env:      map[string]string{"A": "repo", "B": "repo"},
		Services: []WorktreeService{{Name: "web", Run: "pnpm dev"}},
		Hooks:    []hooks.Hook{{On: "worktree.created", Run: "echo repo"}},
	})
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	l.Add(ctx, "cal", repo)
	trustRepo(t, l, "cal")
	if err := l.SetLocalConfig("cal", RepoConfig{Env: map[string]string{"B": "box"}, Services: []WorktreeService{{Name: "web", Run: "yarn dev"}, {Name: "worker", Run: "yarn worker"}}, Hooks: []hooks.Hook{{On: "worktree.removed", Run: "echo box"}}}); err != nil {
		t.Fatal(err)
	}
	c, err := l.Config(ctx, "cal")
	if err != nil {
		t.Fatal(err)
	}
	e := c.Effective
	if e.Setup != "pnpm install" || e.Env["A"] != "repo" || e.Env["B"] != "box" || len(e.Services) != 2 || e.Services[0].Run != "yarn dev" || len(e.Hooks) != 2 {
		t.Fatalf("effective = %+v", e)
	}
	if err := l.SetLocalConfig("cal", RepoConfig{Services: []WorktreeService{{Name: "Web Server", Run: "x"}}}); err == nil {
		t.Fatal("an invalid service name was saved")
	}
}

func TestEveryWorktreeGetsItsOwnPortsAndEnvironment(t *testing.T) {
	ctx := context.Background()
	repo := gitRepo(t)
	writeRepoConfig(t, repo, RepoConfig{Ports: 3, Env: map[string]string{"DATABASE_URL": "postgres://localhost/$BERTH_WORKTREE_SLUG?port=$BERTH_PORT_1"}})
	b := &Box{Name: "devbox", Locations: NewLocations(filepath.Join(t.TempDir(), "locations.json")), Events: &events.Bus{}}
	b.Locations.Add(ctx, "cal", repo)
	trustRepo(t, b.Locations, "cal")
	one, _ := b.Locations.CreateWorktree(ctx, "cal", "billing", "", "")
	two, _ := b.Locations.CreateWorktree(ctx, "cal", "fix-login", "", "")
	envOf := func(wt Worktree) map[string]string {
		env, err := b.WorktreeEnv(ctx, "cal", wt)
		if err != nil {
			t.Fatal(err)
		}
		m := map[string]string{}
		for _, kv := range env {
			k, v, _ := strings.Cut(kv, "=")
			m[k] = v
		}
		return m
	}
	a, c := envOf(one), envOf(two)
	if a["BERTH_PORT"] == "" || a["BERTH_PORT"] == c["BERTH_PORT"] || a["BERTH_PORT_2"] == "" {
		t.Fatalf("ports: %v / %v", a["BERTH_PORT"], c["BERTH_PORT"])
	}
	if a["BERTH_WORKTREE_SLUG"] != "cal_billing" || a["DATABASE_URL"] != "postgres://localhost/cal_billing?port="+a["BERTH_PORT_1"] {
		t.Fatalf("env = %v", a)
	}
	if again := envOf(one); again["BERTH_PORT"] != a["BERTH_PORT"] {
		t.Fatal("a worktree's port changed")
	}
	// A removed worktree's block goes back to the pool.
	b.Locations.RemoveWorktree(ctx, "cal", "billing", true)
	b.Locations.Ports.Release(one.Path)
	three, _ := b.Locations.CreateWorktree(ctx, "cal", "next", "", "")
	if envOf(three)["BERTH_PORT"] != a["BERTH_PORT"] {
		t.Fatal("a freed port block was not reused")
	}
}

func TestRepoHooksRunOnlyForTheirRepoInTheWorktree(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cal, other := gitRepo(t), gitRepo(t)
	out := filepath.Join(t.TempDir(), "ran")
	writeRepoConfig(t, cal, RepoConfig{Hooks: []hooks.Hook{{On: "worktree.created", Run: `echo "$PWD $BERTH_PORT $BERTH_EVENT" >> ` + out}}})
	b := &Box{Name: "devbox", Locations: NewLocations(filepath.Join(t.TempDir(), "locations.json")), Events: &events.Bus{}}
	b.Locations.Add(ctx, "cal", cal)
	trustRepo(t, b.Locations, "cal")
	b.Locations.Add(ctx, "other", other)
	go b.RunRepoHooks(ctx, log.New(io.Discard, "", 0))
	time.Sleep(50 * time.Millisecond)

	wt, _ := b.Locations.CreateWorktree(ctx, "cal", "billing", "", "")
	ow, _ := b.Locations.CreateWorktree(ctx, "other", "billing", "", "")
	b.Events.Publish(events.Event{Type: "worktree.created", Data: map[string]any{"location": "other", "name": "billing", "path": ow.Path}})
	b.Events.Publish(events.Event{Type: "worktree.created", Data: map[string]any{"location": "cal", "name": "billing", "path": wt.Path}})
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, _ := os.ReadFile(out)
		if strings.Count(string(got), "\n") >= 1 {
			line := strings.TrimSpace(string(got))
			resolved, _ := filepath.EvalSymlinks(wt.Path)
			if strings.Count(string(got), "\n") != 1 || !strings.HasPrefix(line, resolved+" 41") || !strings.HasSuffix(line, "worktree.created") {
				t.Fatalf("hook output = %q", got)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the repo hook never ran")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestWorktreeServicesStartWithTheWorktreesEnvironmentAndStopWithIt(t *testing.T) {
	ctx := context.Background()
	repo := gitRepo(t)
	writeRepoConfig(t, repo, RepoConfig{Services: []WorktreeService{{Name: "web", Run: "pnpm dev --port $BERTH_PORT", Autostart: true}}})
	units := &Units{Dir: t.TempDir()}
	ops, calls := fakeService()
	units.svc = ops
	b := &Box{Name: "devbox", Locations: NewLocations(filepath.Join(t.TempDir(), "locations.json")), Events: &events.Bus{}, Units: units}
	b.Locations.Add(ctx, "cal", repo)
	trustRepo(t, b.Locations, "cal")
	b.Locations.CreateWorktree(ctx, "cal", "billing", "", "")

	st, err := b.StartService(ctx, "cal", "billing", "web")
	if err != nil {
		t.Fatal(err)
	}
	if st.State == "stopped" || st.Port < 41000 || st.Unit != "svc-cal-billing-web" {
		t.Fatalf("status = %+v", st)
	}
	files, _ := os.ReadDir(units.Dir)
	if len(files) == 0 {
		t.Fatal("no unit log was made")
	}
	if !strings.Contains(strings.Join(*calls, "\n"), "install svc-cal-billing-web") {
		t.Fatalf("calls = %v", *calls)
	}
	if _, err := b.StartService(ctx, "cal", "billing", "nope"); err != ErrUnknownService {
		t.Fatalf("an unknown service gave %v", err)
	}
	b.stopServices("cal", "billing")
	all, _ := b.WorktreeServices(ctx, "cal", "billing")
	if all[0].State != "stopped" {
		t.Fatalf("after stopping: %+v", all[0])
	}
}

func TestAgentPresetsComeFromEveryLayer(t *testing.T) {
	ctx := context.Background()
	repo := gitRepo(t)
	writeRepoConfig(t, repo, RepoConfig{Agents: []AgentPreset{{ID: "claude", Name: "Repo Claude", Command: "claude --model opus"}}})
	l := NewLocations(filepath.Join(t.TempDir(), "locations.json"))
	l.Add(ctx, "cal", repo)
	trustRepo(t, l, "cal")
	l.SetLocalConfig("cal", RepoConfig{Agents: []AgentPreset{{ID: "claude", Name: "Box Claude", Command: "claude --model sonnet"}, {ID: "fake", Name: "Fake", Command: "cat"}}})
	loc, _ := l.Get(ctx, "cal")
	p, ok := presetFor(&loc, "claude")
	if !ok || p.Command != "claude --model sonnet" {
		t.Fatalf("claude preset = %+v", p)
	}
	if p, ok := presetFor(&loc, "fake"); !ok || p.Command != "cat" {
		t.Fatalf("a box-only preset was missed: %+v %v", p, ok)
	}
}

// The hello sample and most dev servers listen on $PORT. A worktree's
// terminals and agents get its own, so `npm start` lands in the worktree's
// block and its WORKTREE.LOCATION.BOX.localhost URL works on any box; a
// project that sets PORT itself keeps its value.
func TestAWorktreesTerminalsGetItsPortAsPORT(t *testing.T) {
	ctx := context.Background()
	repo := gitRepo(t)
	b := &Box{Name: "devbox", Locations: NewLocations(filepath.Join(t.TempDir(), "locations.json")), Events: &events.Bus{}}
	b.Locations.Add(ctx, "hello", repo)
	wt, err := b.Locations.CreateWorktree(ctx, "hello", "health", "", "")
	if err != nil {
		t.Fatal(err)
	}
	envOf := func() map[string]string {
		env, _ := b.sessionEnv(ctx, wt.Path, nil)
		m := map[string]string{}
		for _, kv := range env {
			k, v, _ := strings.Cut(kv, "=")
			if _, dup := m[k]; dup {
				t.Fatalf("%s is set twice in %v", k, env)
			}
			m[k] = v
		}
		return m
	}
	if e := envOf(); e["BERTH_PORT"] == "" || e["PORT"] != e["BERTH_PORT"] {
		t.Fatalf("PORT = %q, BERTH_PORT = %q", e["PORT"], e["BERTH_PORT"])
	}
	if err := b.Locations.SetLocalConfig("hello", RepoConfig{Env: map[string]string{"PORT": "8080"}}); err != nil {
		t.Fatal(err)
	}
	if e := envOf(); e["PORT"] != "8080" {
		t.Fatalf("the project's PORT was replaced: %q", e["PORT"])
	}
}
