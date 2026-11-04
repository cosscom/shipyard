package box

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/groups"
	"github.com/cosscom/shipyard/internal/hooks"
)

// Scripts are a location's worktree lifecycle commands. They get
// BERTH_ROOT_PATH, BERTH_WORKTREE_PATH and BERTH_WORKTREE_NAME, and Orca's
// ORCA_* names for the same values, so a script written for Orca runs
// unchanged.
type Scripts struct {
	Setup   string `json:"setup,omitempty"`
	Archive string `json:"archive,omitempty"`
	// From says where the scripts came from: "berth" when set on the
	// location, "kit" from its kit, "repo" from the repository's
	// .berth/config.json.
	From string `json:"from,omitempty"`
}

// RepoConfigFile is where a repository describes how berth sets up its
// worktrees, committed alongside the code so every box does the same.
const RepoConfigFile = ".berth/config.json"

// RepoConfig is a repository's .berth/config.json.
type RepoConfig struct {
	Setup   string `json:"setup,omitempty"`
	Archive string `json:"archive,omitempty"`
	// Check is the command that says the work is right ("pnpm test && pnpm
	// lint"): what Try N ways and loops verify with unless told otherwise.
	Check string `json:"check,omitempty"`
	// Agents adds ways to start agents here, or replaces built-ins by ID,
	// e.g. {"id": "claude", "command": "claude --model opus"}.
	Agents []AgentPreset `json:"agents,omitempty"`
	// Ports is how many ports each worktree needs ($BERTH_PORT,
	// $BERTH_PORT_1, …). Every worktree has at least one.
	Ports int `json:"ports,omitempty"`
	// Env is added to everything run in a worktree, with $BERTH_* expanded:
	// {"DATABASE_URL": "postgres://localhost/$BERTH_WORKTREE_SLUG"}.
	Env map[string]string `json:"env,omitempty"`
	// Services run in every worktree, such as its dev server.
	Services []WorktreeService `json:"services,omitempty"`
	// Hooks run for this repository's events only, in the worktree.
	Hooks []hooks.Hook `json:"hooks,omitempty"`
	// Flows are automations for this repository's worktrees.
	Flows []Flow `json:"flows,omitempty"`
	// BrowserAllow asks for public origins an agent's browser may load in
	// this repository's worktrees (a sign-in provider, say). It applies once
	// the box trusts the repository's config.
	BrowserAllow []string `json:"browser_allow,omitempty"`
	// Shots is what `berthd shots compare` screenshots and diffs by
	// default: pages, sizes, and selectors to mask (shots.go).
	Shots *ShotsConfig `json:"shots,omitempty"`
	// Login logs a worktree in as a dev user: a script that prints the
	// session's cookies, and the users it may log in (login.go).
	Login *LoginConfig `json:"login,omitempty"`
	// ReviewButton adds a "Review in Shipyard" button to the description of
	// each pull request opened from the project's worktrees
	// (reviewbutton.go). Off unless a layer, or the team's team.json, says.
	ReviewButton *bool `json:"review_button,omitempty"`
	// KeepMain keeps the default branch current: a new branch from it
	// fetches it first and fast-forwards the local one (freshbase.go). On
	// unless a layer says false.
	KeepMain *bool `json:"keep_main,omitempty"`
	// Secrets is where this project's secret requests save, over the
	// box's default (secretstore.go). Only the box's own config sets it,
	// never a repository's file.
	Secrets *SecretStoreChoice `json:"secrets,omitempty"`
}

// ReadRepoConfig reads repo's .berth/config.json; ok is false without one.
// It is the file as committed, trusted or not: what runs comes from
// repoLayer.
func ReadRepoConfig(repo string) (c RepoConfig, ok bool, err error) {
	c, _, ok, err = readRepoFile(repo)
	return c, ok, err
}

// scriptsFor is the location's own scripts if set, otherwise the
// repository's.
func scriptsFor(saved savedLocation) Scripts {
	repo, _, _ := repoLayer(saved)
	local := RepoConfig{Setup: saved.Setup, Archive: saved.Archive}
	if saved.Config != nil {
		local = merge(local, *saved.Config)
	}
	c := layered(repo, saved.Kit, local)
	from := ""
	switch {
	case local.Setup != "" || local.Archive != "":
		from = "berth"
	case saved.Kit != nil && (saved.Kit.Config.Setup != "" || saved.Kit.Config.Archive != ""):
		from = "kit"
	case repo.Setup != "" || repo.Archive != "":
		from = "repo"
	}
	return Scripts{Setup: c.Setup, Archive: c.Archive, From: from}
}

// runScript runs a lifecycle script in the worktree through a login shell, so
// tools the user installed are on PATH, logging to logPath.
// quietEnv keeps setup that runs unattended (a team project's init, a
// worktree's setup script) from stopping at a question nobody sees:
// corepack asks before it downloads the yarn or pnpm a repository pins.
var quietEnv = []string{"COREPACK_ENABLE_DOWNLOAD_PROMPT=0"}

func runScript(ctx context.Context, script, repo, dir, name, logPath string, timeout time.Duration, extra []string) error {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return err
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := groups.CommandContext(ctx, shell, "-lc", script)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"BERTH_ROOT_PATH="+repo, "BERTH_WORKTREE_PATH="+dir, "BERTH_WORKTREE_NAME="+name,
		"ORCA_ROOT_PATH="+repo, "ORCA_WORKTREE_PATH="+dir, "ORCA_WORKSPACE_NAME="+name)
	// A script has no terminal to answer a question in: corepack fetches
	// the yarn or pnpm a repository pins without asking. The repository's
	// own env (extra) can say otherwise.
	cmd.Env = append(cmd.Env, quietEnv...)
	cmd.Env = append(cmd.Env, extra...)
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Run(); err != nil {
		// What the script said last is why it failed: the error carries it,
		// so the app's Details can show it without a trip to the box.
		if tail := logTail(logPath, 40, 4096); tail != "" {
			return fmt.Errorf("%v (log: %s)\n%s", err, logPath, tail)
		}
		return fmt.Errorf("%v (log: %s)", err, logPath)
	}
	return nil
}

// logTail is the last lines of a log, at most max bytes of them.
func logTail(path string, lines, max int) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	if len(b) > max {
		b = b[len(b)-max:]
	}
	all := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return strings.TrimSpace(strings.Join(all, "\n"))
}
