package integrations

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An existing Cursor hooks file, as Orca writes it.
const orcaCursorHooks = `{
  "hooks": {
    "stop": [{"command": "/bin/sh '/Users/alex/.orca/agent-hooks/cursor-hook.sh'", "timeout": 10}],
    "beforeShellExecution": [{"command": "/bin/sh orca-allow", "timeout": 10}]
  }
}`

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestCursorHooksAreAppendedAfterOrcasAndOnlyOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hooks.json")
	os.WriteFile(path, []byte(orcaCursorHooks), 0o600)
	changed, err := InstallCursorHooks(path, "/Users/alex/bin/berth")
	if err != nil || !changed {
		t.Fatalf("install: %v changed=%v", err, changed)
	}
	root := readJSON(t, path)
	hooks := root["hooks"].(map[string]any)
	stop := hooks["stop"].([]any)
	if len(stop) != 2 || !strings.Contains(stop[0].(map[string]any)["command"].(string), "orca") ||
		stop[1].(map[string]any)["command"] != "/Users/alex/bin/berth hook cursor stop" {
		t.Fatalf("stop hooks = %v", stop)
	}
	if len(hooks["beforeShellExecution"].([]any)) != 1 {
		t.Fatal("an unrelated hook was changed")
	}
	if changed, _ := InstallCursorHooks(path, "/Users/alex/bin/berth"); changed {
		t.Fatal("a second install changed the file again")
	}
	backup, err := os.ReadFile(path + ".berth-backup")
	if err != nil || string(backup) != orcaCursorHooks {
		t.Fatalf("backup = %q, %v", backup, err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode changed to %v", info.Mode().Perm())
	}
}

func TestClaudeHooksKeepExistingSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte(`{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}`), 0o644)
	if _, err := InstallClaudeHooks(path, "/home/alex/.local/bin/berthd"); err != nil {
		t.Fatal(err)
	}
	root := readJSON(t, path)
	if root["model"] != "opus" {
		t.Fatal("an existing setting was lost")
	}
	hooks := root["hooks"].(map[string]any)
	if stop := hooks["Stop"].([]any); len(stop) != 2 {
		t.Fatalf("Stop hooks = %v", stop)
	}
	if len(hooks["Notification"].([]any)) != 1 {
		t.Fatal("Notification hook missing")
	}
	if changed, _ := InstallClaudeHooks(path, "/home/alex/.local/bin/berthd"); changed {
		t.Fatal("a second install changed the file again")
	}
}

func TestInstallCreatesMissingFilesAndRefusesBrokenOnes(t *testing.T) {
	dir := t.TempDir()
	if _, err := InstallClaudeHooks(filepath.Join(dir, "new", "settings.json"), "berth"); err != nil {
		t.Fatalf("missing settings file: %v", err)
	}
	broken := filepath.Join(dir, "broken.json")
	os.WriteFile(broken, []byte("{ not json"), 0o644)
	if _, err := InstallCursorHooks(broken, "berth"); err == nil {
		t.Fatal("rewrote a file that is not JSON")
	}
	if b, _ := os.ReadFile(broken); string(b) != "{ not json" {
		t.Fatal("a broken file was modified")
	}
}

func TestQuotedBinaryPaths(t *testing.T) {
	if got := hookCommand("/Users/alex/Application Support/berth", "cursor", "stop"); got != "'/Users/alex/Application Support/berth' hook cursor stop" {
		t.Fatalf("hookCommand = %q", got)
	}
}

// Codex's question box and tool uses come through PreToolUse and
// PostToolUse. A hooks.json from an older berth, without them, reads as
// outdated so an upgrade adds them: once, after the hooks already there.
func TestCodexToolHooksAreAddedToAnOlderInstallOnce(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hooks.json")
	os.WriteFile(path, []byte(`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/opt/berthd hook codex Stop"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"my-guard"}]}]}}`), 0o644)
	if hooked, current := accountHooks("codex", dir); !hooked || current {
		t.Fatalf("older hooks: hooked %v current %v", hooked, current)
	}
	if changed, err := InstallCodexHooks(path, "/opt/berthd"); !changed || err != nil {
		t.Fatalf("install: %v changed=%v", err, changed)
	}
	if changed, _ := InstallCodexHooks(path, "/opt/berthd"); changed {
		t.Fatal("a second install changed the file again")
	}
	hooks := readJSON(t, path)["hooks"].(map[string]any)
	for event, n := range map[string]int{"SessionStart": 1, "UserPromptSubmit": 1, "PreToolUse": 2, "PostToolUse": 1, "PermissionRequest": 1, "Stop": 1} {
		if list, _ := hooks[event].([]any); len(list) != n {
			t.Errorf("%s hooks = %v", event, list)
		}
	}
	pre := hooks["PreToolUse"].([]any)
	if !containsCommand(pre[:1], "my-guard") || !containsCommand(pre[1:], "/opt/berthd hook codex PreToolUse") {
		t.Fatalf("PreToolUse hooks = %v", pre)
	}
	if hooked, current := accountHooks("codex", dir); !hooked || !current {
		t.Fatalf("after install: hooked %v current %v", hooked, current)
	}
}

func TestNewAgentHooksInstallOnceAndKeepOtherSettings(t *testing.T) {
	dir := t.TempDir()
	gem := filepath.Join(dir, "settings.json")
	os.WriteFile(gem, []byte(`{"theme":"dark"}`), 0o600)
	if changed, err := InstallGeminiHooks(gem, "/opt/berthd"); !changed || err != nil {
		t.Fatalf("gemini: %v %v", changed, err)
	}
	if changed, _ := InstallGeminiHooks(gem, "/opt/berthd"); changed {
		t.Fatal("gemini hooks were added twice")
	}
	b, _ := os.ReadFile(gem)
	if !strings.Contains(string(b), `"theme": "dark"`) || !strings.Contains(string(b), "hook gemini AfterAgent") {
		t.Fatalf("gemini settings = %s", b)
	}
	codex := filepath.Join(dir, "hooks.json")
	if changed, err := InstallCodexHooks(codex, "/opt/berthd"); !changed || err != nil {
		t.Fatalf("codex: %v %v", changed, err)
	}
	plugin := filepath.Join(dir, "plugin", "berth.js")
	if changed, err := InstallOpenCodePlugin(plugin, "/opt/berthd"); !changed || err != nil {
		t.Fatalf("opencode: %v %v", changed, err)
	}
	if changed, _ := InstallOpenCodePlugin(plugin, "/opt/berthd"); changed {
		t.Fatal("plugin rewritten unchanged")
	}
	b, _ = os.ReadFile(plugin)
	if !strings.Contains(string(b), `"/opt/berthd"} hook opencode`) {
		t.Fatalf("plugin = %s", b)
	}
	claude := filepath.Join(dir, "claude.json")
	InstallClaudeHooks(claude, "/opt/berthd")
	b, _ = os.ReadFile(claude)
	for _, ev := range []string{"PostToolUse", "PermissionRequest", "SessionEnd"} {
		if !strings.Contains(string(b), "hook claude "+ev) {
			t.Errorf("claude settings lack %s", ev)
		}
	}
}
