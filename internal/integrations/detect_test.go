package integrations

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeMachine gives the test an empty home and a PATH holding only fake
// agent CLIs named by tools.
func fakeMachine(t *testing.T, tools ...string) string {
	t.Helper()
	home := t.TempDir()
	bin := t.TempDir()
	for _, tool := range tools {
		if err := os.WriteFile(filepath.Join(bin, tool), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin)
	// berthd's own account picks, which a test never follows.
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	old, oldAsk := systemBinDirs, askShell
	systemBinDirs, askShell = nil, false
	t.Cleanup(func() { systemBinDirs, askShell = old, oldAsk })
	return home
}

func TestDetectFindsToolsOnPathAndInHome(t *testing.T) {
	home := fakeMachine(t, "claude")
	// Codex installed with npm under nvm, which a service's PATH leaves out.
	nvm := filepath.Join(home, ".nvm", "versions", "node", "v22.1.0", "bin")
	os.MkdirAll(nvm, 0o755)
	os.WriteFile(filepath.Join(nvm, "codex"), []byte("#!/bin/sh\n"), 0o755)
	// Cursor's editor settings are not its CLI.
	os.MkdirAll(filepath.Join(home, ".cursor"), 0o755)

	present, missing := Detect(home)
	if ids(present) != "claude codex" || ids(missing) != "cursor gemini opencode grok" {
		t.Fatalf("present %q, missing %q", ids(present), ids(missing))
	}
}

func TestDetectCountsAToolThatHasRunHere(t *testing.T) {
	home := fakeMachine(t)
	os.MkdirAll(filepath.Join(home, ".claude"), 0o755)
	present, _ := Detect(home)
	if ids(present) != "claude" {
		t.Fatalf("present %q", ids(present))
	}
}

func TestInstallDetectedInstallsOnlyWhatIsThereAndOnlyOnce(t *testing.T) {
	home := fakeMachine(t, "claude", "codex")
	bin := "/home/alex/.local/bin/berthd"
	var out bytes.Buffer
	if err := InstallDetected(home, bin, "berthd", &out); err != nil {
		t.Fatal(err)
	}
	first := out.String()
	for _, want := range []string{
		"Claude Code: hooks and 7 skills in ~/.claude\n    hooks added in ~/.claude/settings.json",
		"Codex: hooks in ~/.codex; 7 skills in ~/.agents/skills",
		"notify added in ~/.codex/config.toml",
		"Not found: Cursor Agent, Gemini CLI, OpenCode, Grok CLI. After installing one, run: berthd integrations install cursor|gemini|opencode|grok",
	} {
		if !strings.Contains(first, want) {
			t.Errorf("output missing %q:\n%s", want, first)
		}
	}
	claude, _ := ToolByID("claude")
	codex, _ := ToolByID("codex")
	cursor, _ := ToolByID("cursor")
	if !claude.Hooked(home) || !codex.Hooked(home) || cursor.Hooked(home) {
		t.Fatalf("hooked: claude %v codex %v cursor %v", claude.Hooked(home), codex.Hooked(home), cursor.Hooked(home))
	}
	if _, err := os.Stat(filepath.Join(home, ".cursor")); err == nil {
		t.Fatal("wrote settings for a tool that is not installed")
	}
	if st, _ := SkillStatus(home, "claude", "berth"); st != SkillInstalled {
		t.Fatalf("claude skill %s", st)
	}

	settings, _ := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	config, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	out.Reset()
	if err := InstallDetected(home, bin, "berthd", &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "hooks already present") || !strings.Contains(out.String(), "notify already present") {
		t.Errorf("second run:\n%s", out.String())
	}
	again, _ := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	againConfig, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if !bytes.Equal(settings, again) || !bytes.Equal(config, againConfig) {
		t.Fatal("a second run changed the settings")
	}
}

func TestInstallDetectedWithNoAgentsSaysHowToAddThemLater(t *testing.T) {
	home := fakeMachine(t)
	var out bytes.Buffer
	if err := InstallDetected(home, "/usr/local/bin/berthd", "/usr/local/bin/berthd", &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "No agent CLIs found (claude, codex, cursor-agent, gemini, opencode, grok)") ||
		!strings.Contains(out.String(), "/usr/local/bin/berthd integrations install claude|codex|cursor|gemini|opencode|grok") {
		t.Fatalf("output:\n%s", out.String())
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		t.Fatalf("wrote to home: %v", entries)
	}
}

func TestInstallDetectedReportsABrokenSettingsFileAndCarriesOn(t *testing.T) {
	home := fakeMachine(t, "claude", "cursor-agent")
	os.MkdirAll(filepath.Join(home, ".claude"), 0o755)
	os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte("{ not json"), 0o644)
	var out bytes.Buffer
	err := InstallDetected(home, "berthd", "berthd", &out)
	if err == nil || !strings.Contains(err.Error(), "Claude Code") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(out.String(), "Claude Code: not installed") || !strings.Contains(out.String(), "run: berthd integrations install claude") {
		t.Errorf("output:\n%s", out.String())
	}
	if cursor, _ := ToolByID("cursor"); !cursor.Hooked(home) {
		t.Fatal("one tool's failure stopped the others")
	}
}

func TestCodexNotifyLeavesAnotherProgramAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	existing := "model = \"o3\"\n\n[profiles.fast]\nnotify = [\"say\", \"done\"]\n"
	os.WriteFile(path, []byte(existing), 0o600)
	if _, err := InstallCodexNotify(path, "berthd"); err != ErrNotifyTaken {
		t.Fatalf("err = %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != existing {
		t.Fatal("a config with its own notify was changed")
	}

	path = filepath.Join(t.TempDir(), "config.toml")
	os.WriteFile(path, []byte("model = \"o3\"\n\n[tui]\nnotifications = true\n"), 0o600)
	if changed, err := InstallCodexNotify(path, "/opt/berth bin/berthd"); err != nil || !changed {
		t.Fatalf("changed %v, err %v", changed, err)
	}
	b, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(b), "notify = [\"/opt/berth bin/berthd\", \"hook\", \"codex\", \"notify\"]\nmodel = \"o3\"\n") {
		t.Fatalf("config:\n%s", b)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	if changed, err := InstallCodexNotify(path, "/opt/berth bin/berthd"); err != nil || changed {
		t.Fatalf("second install: changed %v, err %v", changed, err)
	}
}

func ids(tools []Tool) string {
	var s []string
	for _, t := range tools {
		s = append(s, t.ID)
	}
	return strings.Join(s, " ")
}
