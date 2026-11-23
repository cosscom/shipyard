package integrations

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// accountsMachine is a fake machine with Claude Code and Codex, a second
// and third Claude Code account (one made by the Usage plugin, one a
// project's config picks outside ~/.berth/accounts), and a second Codex
// account.
func accountsMachine(t *testing.T) (home, personal, client, codexWork string) {
	t.Helper()
	home = fakeMachine(t, "claude", "codex")
	personal = filepath.Join(home, ".berth", "accounts", "claude", "personal")
	client = filepath.Join(home, "logins", "client-claude")
	codexWork = filepath.Join(home, ".berth", "accounts", "codex", "work")
	for _, d := range []string{personal, client, codexWork} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	configured(t, map[string][]string{"claude": {"$HOME/logins/client-claude", filepath.Join(home, "gone")}})
	return home, personal, client, codexWork
}

func configured(t *testing.T, dirs map[string][]string) {
	t.Helper()
	old := ConfiguredAccounts
	ConfiguredAccounts = func() map[string][]string { return dirs }
	t.Cleanup(func() { ConfiguredAccounts = old })
}

func dirsOf(accounts []Account) string {
	var s []string
	for _, a := range accounts {
		s = append(s, a.Dir)
	}
	return strings.Join(s, " ")
}

func TestAccountsAreTheDefaultThenEveryFolderThatExists(t *testing.T) {
	home, personal, client, codexWork := accountsMachine(t)
	// The default needn't exist yet; installing makes it. A configured
	// folder that is gone, or names a worktree's variable, does not count.
	if got, want := dirsOf(Accounts(home, "claude")), strings.Join([]string{filepath.Join(home, ".claude"), personal, client}, " "); got != want {
		t.Fatalf("claude accounts:\n got %s\nwant %s", got, want)
	}
	if got, want := dirsOf(Accounts(home, "codex")), filepath.Join(home, ".codex")+" "+codexWork; got != want {
		t.Fatalf("codex accounts: %s", got)
	}
	if ExpandAccountDir(home, "$BERTH_WORKTREE_PATH/.claude") != "" || ExpandAccountDir(home, "relative") != "" || ExpandAccountDir(home, "~/x") != filepath.Join(home, "x") {
		t.Fatal("ExpandAccountDir")
	}

	// berthd's own CLAUDE_CONFIG_DIR is the default, and ~/.claude, once it
	// exists, is still an account; the same folder twice is listed once.
	os.MkdirAll(filepath.Join(home, ".claude"), 0o755)
	t.Setenv("CLAUDE_CONFIG_DIR", personal)
	accounts := Accounts(home, "claude")
	if got, want := dirsOf(accounts), strings.Join([]string{personal, filepath.Join(home, ".claude"), client}, " "); got != want || !accounts[0].Default {
		t.Fatalf("with CLAUDE_CONFIG_DIR:\n got %s\nwant %s", got, want)
	}
	// One outside this home is not followed: a test's home never reaches
	// the real accounts.
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	if a := Accounts(home, "claude")[0]; a.Dir != filepath.Join(home, ".claude") {
		t.Fatalf("default = %s", a.Dir)
	}
}

func TestInstallPutsHooksAndSkillsInEveryAccountOnce(t *testing.T) {
	home, personal, client, codexWork := accountsMachine(t)
	// The client account already has settings of its own, private.
	os.WriteFile(filepath.Join(client, "settings.json"), []byte(`{"model":"opus","env":{"FOO":"1"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}`), 0o600)
	bin := "/home/alex/.local/bin/berthd"
	var out bytes.Buffer
	for _, tool := range []string{"claude", "codex"} {
		if err := InstallTool(home, tool, bin, &out); err != nil {
			t.Fatal(err)
		}
	}
	first := out.String()
	for _, want := range []string{
		"Claude Code: hooks and 7 skills in ~/.claude, ~/.berth/accounts/claude/personal, ~/logins/client-claude\n",
		"hooks added in ~/.berth/accounts/claude/personal/settings.json",
		"MCP server added in ~/.claude.json",
		"MCP server added in ~/logins/client-claude/.claude.json",
		"Codex: hooks in ~/.codex, ~/.berth/accounts/codex/work; 7 skills in ~/.agents/skills",
		"hooks added in ~/.berth/accounts/codex/work/hooks.json",
		"notify added in ~/.berth/accounts/codex/work/config.toml",
	} {
		if !strings.Contains(first, want) {
			t.Errorf("output lacks %q:\n%s", want, first)
		}
	}
	for _, dir := range []string{filepath.Join(home, ".claude"), personal, client} {
		if hooked, current := accountHooks("claude", dir); !hooked || !current {
			t.Errorf("%s: hooked %v current %v", dir, hooked, current)
		}
		if n := len(installedSkills(filepath.Join(dir, "skills"))); n != 7 {
			t.Errorf("%s has %d skills", dir, n)
		}
	}
	for _, dir := range []string{filepath.Join(home, ".codex"), codexWork} {
		if hooked, current := accountHooks("codex", dir); !hooked || !current {
			t.Errorf("%s: hooked %v current %v", dir, hooked, current)
		}
		if b, _ := os.ReadFile(filepath.Join(dir, "config.toml")); !strings.Contains(string(b), "[mcp_servers.berth]") {
			t.Errorf("%s/config.toml = %s", dir, b)
		}
	}
	// Codex reads $HOME/.agents/skills whatever CODEX_HOME is: none per account.
	if _, err := os.Stat(filepath.Join(codexWork, "skills")); !os.IsNotExist(err) {
		t.Errorf("skills written into a Codex account: %v", err)
	}

	// The user's own settings are kept, mode and all.
	root := readJSON(t, filepath.Join(client, "settings.json"))
	if root["model"] != "opus" || root["env"].(map[string]any)["FOO"] != "1" || len(root["hooks"].(map[string]any)["Stop"].([]any)) != 2 {
		t.Fatalf("client settings = %v", root)
	}
	if info, _ := os.Stat(filepath.Join(client, "settings.json")); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode changed to %v", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(client, "settings.json.berth-backup")); err != nil {
		t.Fatal("no backup of the client's settings")
	}

	// Again: nothing changes.
	snapshot := func() map[string]string {
		m := map[string]string{}
		filepath.Walk(home, func(p string, info os.FileInfo, err error) error {
			if err == nil && info.Mode().IsRegular() {
				b, _ := os.ReadFile(p)
				m[p] = string(b)
			}
			return nil
		})
		return m
	}
	before := snapshot()
	out.Reset()
	for _, tool := range []string{"claude", "codex"} {
		if err := InstallTool(home, tool, bin, &out); err != nil {
			t.Fatal(err)
		}
	}
	if strings.Contains(out.String(), "added") {
		t.Errorf("second run added something:\n%s", out.String())
	}
	after := snapshot()
	if len(after) != len(before) {
		t.Fatalf("second run wrote %d files, had %d", len(after), len(before))
	}
	for p, b := range before {
		if after[p] != b {
			t.Errorf("second run changed %s", p)
		}
	}

	// Status and doctor's words.
	summary, missing, outdated := AccountSummary(home, "claude")
	if summary != "hooks and 7 skills in ~/.claude, ~/.berth/accounts/claude/personal, ~/logins/client-claude" || missing != nil || outdated != nil {
		t.Fatalf("summary %q, missing %v, outdated %v", summary, missing, outdated)
	}
	out.Reset()
	Status(home, "berthd", &out)
	for _, want := range []string{
		"Claude Code: hooks and 7 skills in ~/.claude, ~/.berth/accounts/claude/personal, ~/logins/client-claude\n",
		"Codex: hooks in ~/.codex, ~/.berth/accounts/codex/work; 7 skills in ~/.agents/skills\n",
		"Gemini CLI: not found\n",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, out.String())
		}
	}
}

func TestStatusNamesAnAccountWithoutTheIntegrations(t *testing.T) {
	home, personal, _, _ := accountsMachine(t)
	configured(t, nil)
	if err := InstallTool(home, "claude", "berthd", &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	fresh := filepath.Join(home, ".berth", "accounts", "claude", "work")
	os.MkdirAll(fresh, 0o700)
	summary, missing, _ := AccountSummary(home, "claude")
	if summary != "hooks and 7 skills in ~/.claude, ~/.berth/accounts/claude/personal; none in ~/.berth/accounts/claude/work" || len(missing) != 1 {
		t.Fatalf("summary %q, missing %v", summary, missing)
	}
	var out bytes.Buffer
	Status(home, "berthd", &out)
	if !strings.Contains(out.String(), "To fix: berthd integrations install claude") {
		t.Fatalf("status:\n%s", out.String())
	}
	// berthd brings it in line when it starts.
	if done := RefreshHooked(home, "berthd"); strings.Join(done, ",") != "claude in ~/.berth/accounts/claude/work" {
		t.Fatalf("refresh = %v", done)
	}
	if _, missing, _ := AccountSummary(home, "claude"); missing != nil {
		t.Fatalf("still missing %v", missing)
	}
	_ = personal
}

func TestInstallingOneAccount(t *testing.T) {
	home, personal, _, _ := accountsMachine(t)
	var out bytes.Buffer
	if err := InstallAccount(home, "claude", personal, "berthd", &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "Claude Code: hooks and 7 skills in ~/.berth/accounts/claude/personal\n") {
		t.Fatalf("output:\n%s", out.String())
	}
	if hooked, _ := accountHooks("claude", filepath.Join(home, ".claude")); hooked {
		t.Fatal("installed in the default account too")
	}
	if err := InstallAccount(home, "claude", t.TempDir(), "berthd", &out); err == nil {
		t.Fatal("installed in a folder that is no account")
	}
}

func TestASessionOnANewAccountGetsTheIntegrationsFirst(t *testing.T) {
	home, _, _, _ := accountsMachine(t)
	configured(t, nil)
	fresh := filepath.Join(home, ".berth", "accounts", "claude", "work")
	codexFresh := filepath.Join(home, ".berth", "accounts", "codex", "work")
	os.MkdirAll(fresh, 0o700)
	env := []string{"BERTH_SESSION=x", "CLAUDE_CONFIG_DIR=" + fresh, "CODEX_HOME=" + codexFresh, "CLAUDE_CONFIG_DIR_NOT=1"}

	// Nothing until the user has installed them for the default account.
	if done, err := EnsureAccounts(home, "berthd", env); err != nil || done != nil {
		t.Fatalf("before any install: %v %v", done, err)
	}
	if _, err := os.Stat(filepath.Join(fresh, "settings.json")); !os.IsNotExist(err) {
		t.Fatal("installed in an account although the default has no hooks")
	}

	for _, tool := range []string{"claude", "codex"} {
		if err := InstallTool(home, tool, "berthd", &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
	}
	// The default had one skill removed: the new account follows it.
	if _, err := UninstallSkills(home, "claude", []string{"berth-hooks"}); err != nil {
		t.Fatal(err)
	}
	// The accounts appear since: made by hand, or Codex's never made.
	os.RemoveAll(fresh)
	os.RemoveAll(codexFresh)
	os.MkdirAll(fresh, 0o700)
	os.WriteFile(filepath.Join(fresh, "settings.json"), []byte(`{"theme":"dark"}`), 0o600)
	done, err := EnsureAccounts(home, "berthd", env)
	if err != nil || len(done) != 1 || done[0].Dir != fresh || done[0].Agent != "claude" {
		t.Fatalf("ensure: %v %v", done, err)
	}
	if hooked, current := accountHooks("claude", fresh); !hooked || !current {
		t.Fatal("no hooks in the new account")
	}
	if b, _ := os.ReadFile(filepath.Join(fresh, "settings.json")); !strings.Contains(string(b), `"theme": "dark"`) {
		t.Fatalf("settings = %s", b)
	}
	if got := strings.Join(installedSkills(filepath.Join(fresh, "skills")), ","); got != "berth,berth-artifacts,berth-browser,berth-orchestrate,berth-preview,berth-visual-diff" {
		t.Fatalf("skills = %s", got)
	}
	// A folder that does not exist is left for the agent to complain about.
	if _, err := os.Stat(codexFresh); !os.IsNotExist(err) {
		t.Fatal("made a CODEX_HOME that did not exist")
	}
	// Already there: no work.
	if done, err := EnsureAccounts(home, "berthd", env); err != nil || done != nil {
		t.Fatalf("again: %v %v", done, err)
	}
}

func TestAnAccountsSymlinksAreNeverFollowed(t *testing.T) {
	home, personal, _, _ := accountsMachine(t)
	configured(t, nil)
	// The account's settings.json is a link (to a dotfiles repo, or to a
	// file a repository planted): left as it is, the target untouched.
	target := filepath.Join(t.TempDir(), "elsewhere.json")
	os.WriteFile(target, []byte(`{"mine":true}`), 0o644)
	link := filepath.Join(personal, "settings.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := InstallTool(home, "claude", "berthd", &out); err != nil {
		t.Fatalf("one account's link failed the install: %v", err)
	}
	if !strings.Contains(out.String(), "~/.berth/accounts/claude/personal: not installed:") || !strings.Contains(out.String(), "symbolic link") {
		t.Fatalf("output:\n%s", out.String())
	}
	if !strings.HasPrefix(out.String(), "Claude Code: hooks and 7 skills in ~/.claude\n") {
		t.Fatalf("output:\n%s", out.String())
	}
	if b, _ := os.ReadFile(target); string(b) != `{"mine":true}` {
		t.Fatalf("wrote through the link: %s", b)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link was replaced")
	}

	// A skills folder linked elsewhere is not written through either.
	os.Remove(link)
	os.RemoveAll(filepath.Join(personal, "skills"))
	elsewhere := t.TempDir()
	os.Symlink(elsewhere, filepath.Join(personal, "skills"))
	out.Reset()
	InstallTool(home, "claude", "berthd", &out)
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Fatalf("skills written through a linked folder: %v", entries)
	}
	if !strings.Contains(out.String(), "personal: not installed:") {
		t.Fatalf("output:\n%s", out.String())
	}

	// The same through a session's account.
	os.Remove(filepath.Join(personal, "skills"))
	os.Symlink(target, link)
	if _, err := EnsureAccounts(home, "berthd", []string{"CLAUDE_CONFIG_DIR=" + personal}); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("ensure through a link: %v", err)
	}
	if b, _ := os.ReadFile(target); string(b) != `{"mine":true}` {
		t.Fatalf("wrote through the link: %s", b)
	}
}

func TestAnAccountFolderIsNamedAsTheUsagePluginNamesIt(t *testing.T) {
	home, personal, client, codexWork := accountsMachine(t)
	for _, c := range []struct{ agent, dir, want string }{
		{"claude", filepath.Join(home, ".claude"), "default"},
		{"claude", filepath.Join(home, ".claude") + "/", "default"},
		{"claude", personal, "personal"},
		{"claude", client, "~/logins/client-claude"},
		{"claude", "/srv/claude/shared", "/srv/claude/shared"},
		{"codex", filepath.Join(home, ".codex"), "default"},
		{"codex", codexWork, "work"},
		// Claude's accounts folder is no Codex account's.
		{"codex", personal, "~/.berth/accounts/claude/personal"},
	} {
		if got := AccountName(home, c.agent, c.dir); got != c.want {
			t.Errorf("AccountName(%s, %s) = %q, want %q", c.agent, c.dir, got, c.want)
		}
	}
}

func TestASessionsAccountFolderComesFromItsVariable(t *testing.T) {
	home, personal, _, _ := accountsMachine(t)
	for _, c := range []struct{ agent, v, want string }{
		{"claude", "", filepath.Join(home, ".claude")},
		{"claude", personal, personal},
		{"claude", "$HOME/.berth/accounts/claude/personal", personal},
		{"claude", "~/.berth/accounts/claude/personal", personal},
		{"codex", "", filepath.Join(home, ".codex")},
		// No folder: a secret reference, another variable, a relative path.
		{"claude", "op://vault/item/field", ""},
		{"claude", "$WORK/claude", ""},
		{"claude", "claude", ""},
		// An agent without accounts.
		{"opencode", "", ""},
	} {
		if got := AccountDir(home, c.agent, c.v); got != c.want {
			t.Errorf("AccountDir(%s, %q) = %q, want %q", c.agent, c.v, got, c.want)
		}
	}
}

func TestABackedUpAccountIsNotCounted(t *testing.T) {
	home, personal, _, _ := accountsMachine(t)
	// ~/.claude (the default), personal and the client's the config picks.
	if n := AccountCount(home, "claude"); n != 3 {
		t.Fatalf("claude accounts = %d, want 3", n)
	}
	os.MkdirAll(personal+".bak-20260101T120000", 0o700)
	if n := AccountCount(home, "claude"); n != 3 {
		t.Fatalf("with a backup: %d, want 3", n)
	}
	if n := AccountCount(home, "codex"); n != 2 {
		t.Fatalf("codex accounts = %d, want 2", n)
	}
	if n := AccountCount(home, "opencode"); n != 0 {
		t.Fatalf("opencode accounts = %d, want 0", n)
	}
}
