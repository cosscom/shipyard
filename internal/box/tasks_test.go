package box

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
)

func TestATaskIsAWorktreeWithItsAgentRunning(t *testing.T) {
	c, _ := servedBox(t)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "cal", "path": repo}, nil)

	var task Task
	status := call(t, c, "POST", "/v1/tasks", "", TaskRequest{Location: "cal", Name: "billing", Command: "cat"}, &task)
	if status != 200 {
		t.Fatalf("task: %d", status)
	}
	if task.Worktree.Name != "billing" || task.Session.Location != "cal/billing" || task.Session.Dir == "" {
		t.Fatalf("task = %+v", task)
	}
	if _, err := os.Stat(task.Worktree.Path); err != nil {
		t.Fatalf("worktree folder: %v", err)
	}
	if status := call(t, c, "POST", "/v1/tasks", "", TaskRequest{Location: "cal", Name: "x", Agent: "no-such-agent"}, nil); status != 400 {
		t.Fatalf("an unknown agent gave %d, want 400", status)
	}
	if status := call(t, c, "POST", "/v1/tasks", "", TaskRequest{Location: "cal", Name: "y", Agent: "claude", Model: "opus; touch /tmp/x"}, nil); status != 400 {
		t.Fatalf("a model that is not a name gave %d, want 400", status)
	}
	if status := call(t, c, "POST", "/v1/tasks", "", TaskRequest{Location: "cal", Name: "z", Command: "cat", Model: "opus"}, nil); status != 400 {
		t.Fatalf("a model with a command gave %d, want 400", status)
	}
}

func TestABeforeHookRefusesAWorktreeWithItsMessage(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "hooks.json")
	os.WriteFile(cfg, []byte(`{"hooks":[{"on":"before:worktree.create","run":"echo no worktrees on fridays; exit 1"}]}`), 0o600)
	c, _ := servedBox(t, func(b *Box) { b.Hooks = &hooks.Runner{Path: cfg} })
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "cal", "path": repo}, nil)

	var resp struct{ Error string }
	status := call(t, c, "POST", "/v1/tasks", "", TaskRequest{Location: "cal", Name: "billing", Command: "cat"}, &resp)
	if status != 403 || !strings.Contains(resp.Error, "no worktrees on fridays") {
		t.Fatalf("got %d %q, want 403 with the hook's message", status, resp.Error)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-billing")); err == nil {
		t.Fatal("the worktree was made anyway")
	}
}

func TestAgentCommandsQuoteThePrompt(t *testing.T) {
	claude := AgentPreset{ID: "claude", Command: "claude"}
	if got := AgentCommand(claude, "fix the user's bug"); got != `claude 'fix the user'\''s bug'` {
		t.Fatalf("claude = %s", got)
	}
	gemini := AgentPreset{ID: "gemini", Command: "gemini", PromptFlag: "-i"}
	if got := AgentCommand(gemini, "hi"); got != "gemini -i 'hi'" {
		t.Fatalf("gemini = %s", got)
	}
	if agentOf("/usr/local/bin/claude --resume") != "claude" || agentOf("cat") != "" || agentOf("grok --model grok-build") != "grok" {
		t.Fatal("agentOf misread a command")
	}
}

func TestSessionNamesUseTheProgramNotItsPath(t *testing.T) {
	if n := defaultSessionName("cal/billing", "/home/me/.local/bin/claude --resume"); !strings.HasPrefix(n, "cal-billing-claude-") {
		t.Fatalf("name = %s", n)
	}
}

func TestTurnsSurviveARestartAndImportOldStates(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "agent-states.json")
	// What an older berthd left: one state per directory.
	os.WriteFile(legacy, []byte(`{"/w/fix":{"state":"finished","at":"`+time.Now().UTC().Format(time.RFC3339Nano)+`"}}`), 0o600)
	first := &Turns{Path: filepath.Join(dir, "turns.json"), LegacyPath: legacy}
	bus := &events.Bus{Sequence: true}
	first.Attach(bus)
	if st := first.Track(Session{Name: "shop-fix-claude", Dir: "/w/fix", Agent: "claude"}); st.State != "finished" {
		t.Fatalf("imported state = %+v", st)
	}
	bus.Publish(events.Event{Type: "session.sent", Data: map[string]any{"name": "shop-fix-claude"}})
	first.save()

	second := &Turns{Path: filepath.Join(dir, "turns.json"), LegacyPath: legacy}
	second.Attach(&events.Bus{Sequence: true})
	st, ok := second.State("shop-fix-claude")
	if !ok || st.Turn != "shop-fix-claude#1" {
		t.Fatalf("after a restart: %+v, %v", st, ok)
	}
	// The old file is still written, for a downgrade.
	if b, _ := os.ReadFile(legacy); !strings.Contains(string(b), "/w/fix") {
		t.Fatalf("agent-states.json = %s", b)
	}
}

func TestAgentCommandsPassAModelAndAnEffort(t *testing.T) {
	claude, _ := presetFor(nil, "claude")
	got, err := AgentCommandWith(claude, "fix it", "opus", "high")
	if err != nil || got != "claude --model opus --effort high 'fix it'" {
		t.Fatalf("claude = %q, %v", got, err)
	}
	codex, _ := presetFor(nil, "codex")
	if got, err := AgentCommandWith(codex, "", "gpt-5-codex", "low"); err != nil || got != "codex --model gpt-5-codex -c model_reasoning_effort=low" {
		t.Fatalf("codex = %q, %v", got, err)
	}
	if got, _ := AgentCommandWith(claude, "hi", "", ""); got != "claude 'hi'" {
		t.Fatalf("the defaults added flags: %q", got)
	}
	// Anything a shell would read as more than a name is refused.
	for _, bad := range []string{"opus; rm -rf ~", "$(id)", "a b", "--dangerously-skip-permissions", "`x`", "o'pus"} {
		if _, err := AgentCommandWith(claude, "", bad, ""); err == nil {
			t.Fatalf("model %q was let through", bad)
		}
		if _, err := AgentCommandWith(claude, "", "", bad); err == nil {
			t.Fatalf("effort %q was let through", bad)
		}
	}
	gemini, _ := presetFor(nil, "gemini")
	if _, err := AgentCommandWith(gemini, "", "pro", ""); err == nil {
		t.Fatal("a model for an agent with no model flag was let through")
	}
	grok, _ := presetFor(nil, "grok")
	if grok.Command != "grok" || grok.Name != "Grok CLI" || grok.PromptFlag != "" || grok.ModelFlag != "--model" || grok.EffortFlag != "--effort" {
		t.Fatalf("grok preset = %+v", grok)
	}
	if got, err := AgentCommandWith(grok, "fix the bug", "grok-build", "high"); err != nil || got != "grok --model grok-build --effort high 'fix the bug'" {
		t.Fatalf("grok = %q, %v", got, err)
	}
	if got, _ := AgentCommandWith(grok, "fix the bug", "", ""); got != "grok 'fix the bug'" {
		t.Fatalf("grok prompt-only = %q", got)
	}
}

func TestARepositoryCanListModelsForABuiltInAgent(t *testing.T) {
	if _, err := toolPath("claude"); err != nil {
		t.Skip("claude is not on PATH here")
	}
	loc := Location{Agents: []AgentPreset{{ID: "claude", Models: []string{"opus", "claude-opus-4-1"}}}}
	p, ok := presetFor(&loc, "claude")
	if !ok || p.Command != "claude" || p.ModelFlag != "--model" || len(p.Models) != 2 || p.Models[1] != "claude-opus-4-1" {
		t.Fatalf("claude = %+v", p)
	}
}
