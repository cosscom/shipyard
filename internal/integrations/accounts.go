package integrations

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A box can have several logins per agent (the Usage plugin's accounts),
// each in a folder of its own that a variable picks: Claude Code's config
// folder (CLAUDE_CONFIG_DIR) and Codex's home (CODEX_HOME). An agent reads
// its hooks, and Claude Code its skills and MCP servers, from that folder
// alone, so berth installs them in every one of them.

// Account is one login folder of an agent.
type Account struct {
	Agent string `json:"agent"`
	Dir   string `json:"dir"`
	// Default is the folder the agent uses when nothing picks another:
	// ~/.claude and ~/.codex, or berthd's own CLAUDE_CONFIG_DIR and
	// CODEX_HOME.
	Default bool `json:"default,omitempty"`
	// own is the agent's folder in home, or berthd's own pick: the user's,
	// so a link they made below it is followed (files.go).
	own bool
}

// AccountVars are the variables that pick each agent's account folder.
var AccountVars = map[string]string{"claude": "CLAUDE_CONFIG_DIR", "codex": "CODEX_HOME"}

// standardDirs are each agent's folder in home.
var standardDirs = map[string]string{"claude": ".claude", "codex": ".codex"}

// AccountsDir is where the Usage plugin's "Add account…" makes account
// folders, one per agent: ~/.berth/accounts/claude/<name>. It is under
// home whatever BERTH_USER_DIR says, as the plugin's script puts it there.
func AccountsDir(home, agent string) string {
	return filepath.Join(home, ".berth", "accounts", agent)
}

// ConfiguredAccounts, when set, lists the account folders berth's own
// config picks, by agent: the CLAUDE_CONFIG_DIR and CODEX_HOME values in
// the box's ~/.berth/env.json and in projects' box-local configs. berthd
// sets it at start (box.ConfiguredAccountDirs); it is only asked about this
// user's own home.
var ConfiguredAccounts func() map[string][]string

// Accounts lists agent's account folders in home: the default first, then
// ~/.claude or ~/.codex when berthd's own variable picked another default,
// every folder under ~/.berth/accounts/<agent>/, and the folders in home
// the box's and projects' config pick. Only folders that exist count,
// except the default, which installing creates.
func Accounts(home, agent string) []Account {
	std, ok := standardDirs[agent]
	if !ok {
		return nil
	}
	def := defaultAccount(home, agent)
	out := []Account{def}
	add := func(dir string, own bool) {
		if dir == "" || !filepath.IsAbs(dir) || !isDir(dir) {
			return
		}
		dir = filepath.Clean(dir)
		for _, a := range out {
			if sameDir(a.Dir, dir) {
				return
			}
		}
		out = append(out, Account{Agent: agent, Dir: dir, own: own})
	}
	add(filepath.Join(home, std), true)
	if entries, err := os.ReadDir(AccountsDir(home, agent)); err == nil {
		for _, e := range entries {
			add(filepath.Join(AccountsDir(home, agent), e.Name()), false)
		}
	}
	if ConfiguredAccounts != nil && isOwnHome(home) {
		dirs := ConfiguredAccounts()[agent]
		sort.Strings(dirs)
		for _, d := range dirs {
			// One outside home is left to the check when a session starts
			// with it (EnsureAccounts), so a test's home never lists this
			// user's real folders.
			if d := ExpandAccountDir(home, d); within(home, d) {
				add(d, false)
			}
		}
	}
	return out
}

// defaultAccount is the folder agent uses in home when nothing picks
// another. berthd's own CLAUDE_CONFIG_DIR or CODEX_HOME counts only for
// this user's home, and only when it is a folder in it, so a test's home
// (or another user's) never reaches this user's accounts.
func defaultAccount(home, agent string) Account {
	dir := filepath.Join(home, standardDirs[agent])
	if isOwnHome(home) {
		if v := ExpandAccountDir(home, os.Getenv(AccountVars[agent])); v != "" && within(home, v) {
			dir = v
		}
	}
	return Account{Agent: agent, Dir: dir, Default: true, own: true}
}

// ExpandAccountDir is the folder a CLAUDE_CONFIG_DIR or CODEX_HOME value
// names, with ~ and $HOME expanded, or "" when it is not an absolute path
// once they are (one naming another variable, say a worktree's).
func ExpandAccountDir(home, v string) string {
	v = strings.TrimSpace(v)
	switch {
	case v == "~":
		v = home
	case strings.HasPrefix(v, "~/"):
		v = filepath.Join(home, v[2:])
	}
	v = strings.NewReplacer("${HOME}", home, "$HOME", home).Replace(v)
	if strings.Contains(v, "$") || !filepath.IsAbs(v) {
		return ""
	}
	return filepath.Clean(v)
}

func isOwnHome(home string) bool {
	h, err := os.UserHomeDir()
	return err == nil && filepath.Clean(h) == filepath.Clean(home)
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func sameDir(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	sa, err1 := os.Stat(a)
	sb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(sa, sb)
}

// tilde shows p with home as ~, as people write it.
func tilde(home, p string) string {
	if p == home {
		return "~"
	}
	if within(home, p) {
		rel, _ := filepath.Rel(home, p)
		return "~/" + filepath.ToSlash(rel)
	}
	return p
}

// files is where the account's settings are written: its own folder,
// strict unless it is the user's own (files.go).
func (a Account) files() files { return files{root: a.Dir, strict: !a.own} }

// claudeJSON is where Claude Code keeps its profile and MCP servers for
// the account: ~/.claude.json for ~/.claude, otherwise .claude.json inside
// the account's folder.
func (a Account) claudeJSON(home string) (files, string) {
	if sameDir(a.Dir, filepath.Join(home, ".claude")) {
		return files{root: home}, ".claude.json"
	}
	return a.files(), ".claude.json"
}

// accountHooks reports whether berth's hooks are in an account folder
// (any berth binary's), and whether they are this release's.
func accountHooks(agent, dir string) (hooked, current bool) {
	switch agent {
	case "claude":
		b, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
		return bytes.Contains(b, []byte("hook claude Stop")), bytes.Contains(b, []byte("hook claude PostToolUse"))
	case "codex":
		// hooks.json with PreToolUse is this release's; one without it, or a
		// notify line alone, is an older berth's (or a Codex without hooks).
		h, _ := os.ReadFile(filepath.Join(dir, "hooks.json"))
		if bytes.Contains(h, []byte("hook codex Stop")) {
			return true, bytes.Contains(h, []byte("hook codex PreToolUse"))
		}
		c, _ := os.ReadFile(filepath.Join(dir, "config.toml"))
		return bytes.Contains(c, []byte(`"hook", "codex"`)), false
	}
	return false, false
}

// installAccount puts berth's hooks in one account folder, with the named
// skills and the MCP server for Claude Code and the MCP server for Codex
// (whose skills are shared: skills.go). It returns what it did, a line a
// thing.
func installAccount(home string, a Account, bin string, skills []string) ([]string, error) {
	f := a.files()
	show := func(rel string) string { return tilde(home, f.path(rel)) }
	var lines []string
	switch a.Agent {
	case "claude":
		if _, err := installSkillsIn(a.Dir, "skills", skills, f.strict); err != nil {
			return nil, err
		}
		changed, err := installClaudeHooks(f, "settings.json", bin)
		if err != nil {
			return nil, err
		}
		lines = append(lines, fmt.Sprintf("hooks %s in %s", verb(changed), show("settings.json")))
		if mcpBin(bin) {
			mf, rel := a.claudeJSON(home)
			changed, err := installMCP(mf, rel, bin, true)
			if err != nil {
				return nil, err
			}
			lines = append(lines, fmt.Sprintf("MCP server %s in %s", verb(changed), tilde(home, mf.path(rel))))
		}
	case "codex":
		changed, err := installCodexHooks(f, "hooks.json", bin)
		if err != nil {
			return nil, err
		}
		lines = append(lines, fmt.Sprintf("hooks %s in %s (trust them once in Codex with /hooks)", verb(changed), show("hooks.json")))
		changed, err = installCodexNotify(f, "config.toml", bin)
		switch {
		case errors.Is(err, ErrNotifyTaken):
			// config.toml has a single notify setting, and the user already
			// uses it for something else: suggest rather than overwrite.
			lines = append(lines, fmt.Sprintf("%s already sets notify, so berth left it alone. To announce finished turns, make it:\n      %s", show("config.toml"), codexNotify(bin)))
		case err != nil:
			return nil, err
		default:
			lines = append(lines, fmt.Sprintf("notify %s in %s", verb(changed), show("config.toml")))
		}
		if mcpBin(bin) {
			changed, err := installCodexMCP(f, "config.toml", bin)
			if err != nil {
				return nil, err
			}
			lines = append(lines, fmt.Sprintf("MCP server %s in %s", verb(changed), show("config.toml")))
		}
	default:
		return nil, fmt.Errorf("%s has no accounts", a.Agent)
	}
	return lines, nil
}

// installAccounts installs agent's integrations in every account folder in
// home and says what it did on out. The default account failing fails the
// install, as it did before there were accounts; another is reported and
// the rest still install.
func installAccounts(home, agent, bin string, out io.Writer) error {
	return installIn(home, agent, bin, Accounts(home, agent), out)
}

// InstallAccount installs agent's integrations in one of its account
// folders in home (one Accounts lists), as the Usage plugin's "Add
// account…" does for the folder it made, and says what it did on out.
func InstallAccount(home, agent, dir, bin string, out io.Writer) error {
	for _, a := range Accounts(home, agent) {
		if sameDir(a.Dir, dir) {
			// Alone, its failure is the install's.
			return installIn(home, agent, bin, []Account{a}, out)
		}
	}
	if _, ok := AccountVars[agent]; !ok {
		return fmt.Errorf("%s has no accounts; use claude or codex", agent)
	}
	return fmt.Errorf("%s is not one of %s's account folders on this machine", dir, agent)
}

func installIn(home, agent, bin string, accounts []Account, out io.Writer) error {
	names, _ := SkillNames(nil)
	skillsDir := ""
	if agent == "codex" {
		dir, err := installAllSkills(home, "codex")
		if err != nil {
			return err
		}
		skillsDir = dir
	}
	var done, notes []string
	// The first is the default, or the one account asked for.
	for i, a := range accounts {
		lines, err := installAccount(home, a, bin, names)
		if err != nil {
			if i == 0 {
				return err
			}
			notes = append(notes, fmt.Sprintf("  %s: not installed: %v", tilde(home, a.Dir), err))
			continue
		}
		done = append(done, tilde(home, a.Dir))
		for _, l := range lines {
			notes = append(notes, "  "+l)
		}
	}
	switch agent {
	case "claude":
		fmt.Fprintf(out, "Claude Code: hooks and %d skills in %s\n", len(names), strings.Join(done, ", "))
	case "codex":
		fmt.Fprintf(out, "Codex: hooks in %s; %d skills in %s, which every Codex account reads\n", strings.Join(done, ", "), len(names), tilde(home, skillsDir))
	}
	for _, n := range notes {
		fmt.Fprintln(out, n)
	}
	return nil
}

// AccountState is berth's integrations in one account folder.
type AccountState struct {
	Account
	// Hooked: berth's hooks are there; Current: they are this release's.
	Hooked  bool `json:"hooked"`
	Current bool `json:"current"`
	// Skills counts Shipyard's skills installed for the account, current
	// or not. Codex's are shared by every account (~/.agents/skills).
	Skills int `json:"skills"`
}

// AccountStates reports berth's integrations in each of agent's account
// folders in home.
func AccountStates(home, agent string) []AccountState {
	var out []AccountState
	for _, a := range Accounts(home, agent) {
		s := AccountState{Account: a}
		s.Hooked, s.Current = accountHooks(agent, a.Dir)
		dir := filepath.Join(a.Dir, "skills")
		if agent == "codex" {
			dir, _ = SkillDir(home, "codex")
		}
		s.Skills = len(installedSkills(dir))
		out = append(out, s)
	}
	return out
}

// installedSkills are berth's skills in a skills folder, current or not.
func installedSkills(dir string) []string {
	var names []string
	for _, s := range Skills() {
		if st, err := skillStatusIn(dir, s.Name); err == nil && st != SkillMissing {
			names = append(names, s.Name)
		}
	}
	return names
}

// AccountSummary says where agent's integrations are in home, as doctor and
// `berthd integrations status` put it ("hooks and 7 skills in ~/.claude,
// ~/.berth/accounts/claude/personal"), and lists the account folders
// without them or with an older berth's.
func AccountSummary(home, agent string) (summary string, missing, outdated []string) {
	states := AccountStates(home, agent)
	// Accounts with the same number of skills share a phrase.
	var order []int
	groups := map[int][]string{}
	for _, s := range states {
		where := tilde(home, s.Dir)
		switch {
		case !s.Hooked:
			missing = append(missing, where)
			continue
		case !s.Current:
			outdated = append(outdated, where)
		}
		n := s.Skills
		if agent == "codex" {
			n = 0
		}
		if _, ok := groups[n]; !ok {
			order = append(order, n)
		}
		groups[n] = append(groups[n], where)
	}
	var parts []string
	for _, n := range order {
		what := "hooks"
		if agent == "claude" {
			what = fmt.Sprintf("hooks and %d skills", n)
		}
		parts = append(parts, what+" in "+strings.Join(groups[n], ", "))
	}
	if agent == "codex" && len(states) > 0 {
		dir, _ := SkillDir(home, "codex")
		parts = append(parts, fmt.Sprintf("%d skills in %s", states[0].Skills, tilde(home, dir)))
	}
	if len(missing) > 0 {
		parts = append(parts, "none in "+strings.Join(missing, ", "))
	}
	return strings.Join(parts, "; "), missing, outdated
}

// EnsureAccounts installs berth's integrations in the account folders env
// picks (CLAUDE_CONFIG_DIR, CODEX_HOME) before a session starts with it, so
// an account added since berthd last looked never runs without them. An
// account that has them costs a file read or two and nothing more.
//
// Only a folder that exists counts, and only for an agent whose default
// account has berth's hooks: someone who never installed them, or took them
// out, gets none. The account gets the skills the default account has. It
// returns the accounts it installed in.
func EnsureAccounts(home, bin string, env []string) ([]Account, error) {
	var done []Account
	var errs []error
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		agent := ""
		for a, name := range AccountVars {
			if name == k {
				agent = a
			}
		}
		if agent == "" {
			continue
		}
		dir := ExpandAccountDir(home, v)
		if dir == "" {
			continue
		}
		if hooked, current := accountHooks(agent, dir); hooked && current {
			continue
		}
		if !isDir(dir) {
			continue
		}
		def := defaultAccount(home, agent)
		if sameDir(def.Dir, dir) {
			// berthd install looks after the default.
			continue
		}
		if hooked, _ := accountHooks(agent, def.Dir); !hooked {
			continue
		}
		a := Account{Agent: agent, Dir: dir, own: sameDir(dir, filepath.Join(home, standardDirs[agent]))}
		if _, err := installAccount(home, a, bin, defaultSkills(home, def)); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", tilde(home, dir), err))
			continue
		}
		done = append(done, a)
	}
	return done, errors.Join(errs...)
}

// defaultSkills are the skills berth installed for the default account,
// which a new account gets too.
func defaultSkills(home string, def Account) []string {
	if def.Agent != "claude" {
		return nil
	}
	return installedSkills(filepath.Join(def.Dir, "skills"))
}

// refreshAccounts brings agent's accounts in home up to this release's
// hooks and gives accounts added since the default's integrations. It
// returns what it did, as "claude" or "claude in ~/.berth/accounts/claude/work".
func refreshAccounts(home, agent, bin string) []string {
	accounts := Accounts(home, agent)
	hooked, current := accountHooks(agent, accounts[0].Dir)
	if !hooked {
		return nil
	}
	if !current {
		// An upgrade: everything again, as `integrations install` does.
		if installAccounts(home, agent, bin, io.Discard) == nil {
			return []string{agent}
		}
		return nil
	}
	var done []string
	skills := defaultSkills(home, accounts[0])
	for _, a := range accounts[1:] {
		if h, c := accountHooks(agent, a.Dir); h && c {
			continue
		}
		if _, err := installAccount(home, a, bin, skills); err == nil {
			done = append(done, agent+" in "+tilde(home, a.Dir))
		}
	}
	return done
}

// InstallUserSkills writes the named skills for agent for the user whose
// home is home: for Claude Code in every account folder, for Codex in
// ~/.agents/skills, which all its accounts read. It returns the paths
// written; an account that fails is in the error and the rest still get
// them.
func InstallUserSkills(home, agent string, names []string) ([]string, error) {
	return userSkills(home, agent, names, true)
}

// UninstallUserSkills removes the named skills for agent from every place
// InstallUserSkills puts them.
func UninstallUserSkills(home, agent string, names []string) ([]string, error) {
	return userSkills(home, agent, names, false)
}

func userSkills(home, agent string, names []string, install bool) ([]string, error) {
	if agent != "claude" {
		if install {
			return InstallSkills(home, agent, names)
		}
		return UninstallSkills(home, agent, names)
	}
	var paths []string
	var errs []error
	for _, a := range Accounts(home, agent) {
		var done []string
		var err error
		if install {
			done, err = installSkillsIn(a.Dir, "skills", names, !a.own)
		} else {
			done, err = uninstallSkillsIn(a.Dir, "skills", names, !a.own)
		}
		paths = append(paths, done...)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", tilde(home, a.Dir), err))
		}
	}
	return paths, errors.Join(errs...)
}

// UserSkillStatus reports one skill for agent for the user whose home is
// home: for Claude Code, the furthest behind of its account folders, so an
// account without it shows it missing.
func UserSkillStatus(home, agent, name string) (SkillState, error) {
	if agent != "claude" {
		return SkillStatus(home, agent, name)
	}
	rank := map[SkillState]int{SkillInstalled: 0, SkillOutdated: 1, SkillMissing: 2}
	worst := SkillInstalled
	for _, a := range Accounts(home, agent) {
		st, err := skillStatusIn(filepath.Join(a.Dir, "skills"), name)
		if err != nil {
			return "", err
		}
		if rank[st] > rank[worst] {
			worst = st
		}
	}
	return worst, nil
}
