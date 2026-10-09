package integrations

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/statefile"
)

// InstallClaudeHooks adds berth's hooks to a Claude Code settings file,
// keeping every existing setting and hook. It reports whether it changed
// anything; running it again is a no-op.
func InstallClaudeHooks(settingsPath, bin string) (bool, error) {
	f, rel := fileAt(settingsPath)
	return installClaudeHooks(f, rel, bin)
}

func installClaudeHooks(f files, rel, bin string) (bool, error) {
	return editJSON(f, rel, func(root map[string]any) bool {
		hooks := object(root, "hooks")
		changed := false
		// UserPromptSubmit and PostToolUse mark the agent busy again, so a
		// "needs you" state clears once someone answers it.
		for _, event := range ClaudeHookEvents {
			if addNested(hooks, event, hookCommand(bin, "claude", event)) {
				changed = true
			}
		}
		return changed
	})
}

// ClaudeHookEvents are the Claude Code hooks berth installs.
var ClaudeHookEvents = []string{"SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd"}

// addNested adds command under event in Claude's nested hook shape, which
// Codex's and Gemini's hooks share, unless it is there already.
func addNested(hooks map[string]any, event, command string) bool {
	list, _ := hooks[event].([]any)
	if containsCommand(list, command) {
		return false
	}
	hooks[event] = append(list, map[string]any{
		"hooks": []any{map[string]any{"type": "command", "command": command}},
	})
	return true
}

// InstallCodexHooks adds berth's hooks to Codex's hooks.json. Codex runs
// them only once they are trusted in Codex (/hooks); until then notify
// still reports finished turns.
func InstallCodexHooks(path, bin string) (bool, error) {
	f, rel := fileAt(path)
	return installCodexHooks(f, rel, bin)
}

func installCodexHooks(f files, rel, bin string) (bool, error) {
	return editJSON(f, rel, func(root map[string]any) bool {
		hooks := object(root, "hooks")
		changed := false
		// PreToolUse says when Codex asks a question (its question box is a
		// tool); it and PostToolUse mark the agent busy again after one.
		for _, event := range []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"} {
			if addNested(hooks, event, hookCommand(bin, "codex", event)) {
				changed = true
			}
		}
		return changed
	})
}

// InstallGeminiHooks adds berth's hooks to Gemini CLI's settings.json,
// keeping every other setting.
func InstallGeminiHooks(path, bin string) (bool, error) {
	f, rel := fileAt(path)
	return editJSON(f, rel, func(root map[string]any) bool {
		hooks := object(root, "hooks")
		changed := false
		for _, event := range []string{"SessionStart", "BeforeAgent", "Notification", "AfterAgent", "SessionEnd"} {
			if addNested(hooks, event, hookCommand(bin, "gemini", event)) {
				changed = true
			}
		}
		return changed
	})
}

// InstallOpenCodePlugin writes berth's OpenCode plugin. It is berth's own
// file, so it is replaced when it differs.
func InstallOpenCodePlugin(path, bin string) (bool, error) {
	want := []byte(adapters.OpenCodePlugin(bin))
	if have, err := os.ReadFile(path); err == nil && string(have) == string(want) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	return true, statefile.Write(path, want)
}

// InstallCursorHooks appends berth's hook to Cursor's hooks file, after any
// hooks other tools (such as Orca) already registered there.
func InstallCursorHooks(hooksPath, bin string) (bool, error) {
	f, rel := fileAt(hooksPath)
	return editJSON(f, rel, func(root map[string]any) bool {
		if _, ok := root["version"]; !ok {
			root["version"] = 1
		}
		hooks := object(root, "hooks")
		changed := false
		for _, event := range []string{"sessionStart", "beforeSubmitPrompt", "stop"} {
			command := hookCommand(bin, "cursor", event)
			list, _ := hooks[event].([]any)
			if containsCommand(list, command) {
				continue
			}
			hooks[event] = append(list, map[string]any{"command": command, "timeout": 10})
			changed = true
		}
		return changed
	})
}

// ErrNotifyTaken means Codex's config already sets notify to something
// other than berth's hook. Codex runs a single notify program, so berth does
// not replace it.
var ErrNotifyTaken = errors.New("codex already has a notify program")

// notifyKey finds a notify setting anywhere in a config.toml. Any table's
// counts: adding a second top-level one is only safe when there is none.
var notifyKey = regexp.MustCompile(`(?m)^[ \t]*notify[ \t]*=`)

// InstallCodexNotify makes Codex run berth's hook when a turn finishes, by
// adding a notify setting to its config.toml. A config that already has a
// notify setting is left alone: ErrNotifyTaken unless it is berth's.
func InstallCodexNotify(configPath, bin string) (bool, error) {
	f, rel := fileAt(configPath)
	return installCodexNotify(f, rel, bin)
}

func installCodexNotify(f files, rel, bin string) (bool, error) {
	before, err := f.read(rel)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	if notifyKey.Match(before) {
		if strings.Contains(string(before), `"hook", "codex"`) {
			return false, nil
		}
		return false, ErrNotifyTaken
	}
	// Top-level keys come before the first table, so the line goes first.
	after := codexNotify(bin) + "\n" + string(before)
	if len(before) > 0 {
		if err := f.backup(rel, before); err != nil {
			return false, err
		}
	}
	return true, f.write(rel, []byte(after), 0o644)
}

func codexNotify(bin string) string {
	return fmt.Sprintf(`notify = [%q, "hook", "codex", "notify"]`, bin)
}

func hookCommand(bin, tool, event string) string {
	return fmt.Sprintf("%s hook %s %s", shellQuote(bin), tool, event)
}

func shellQuote(s string) string {
	if !strings.ContainsAny(s, " '\"$`\\") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func object(root map[string]any, key string) map[string]any {
	if m, ok := root[key].(map[string]any); ok {
		return m
	}
	m := map[string]any{}
	root[key] = m
	return m
}

// containsCommand looks through both hook shapes, Cursor's flat
// {"command": …} and Claude's nested {"hooks": [{"command": …}]}.
func containsCommand(list []any, command string) bool {
	for _, item := range list {
		m, _ := item.(map[string]any)
		if m["command"] == command {
			return true
		}
		inner, _ := m["hooks"].([]any)
		for _, h := range inner {
			if hm, _ := h.(map[string]any); hm["command"] == command {
				return true
			}
		}
	}
	return false
}

// editJSON applies change to a JSON object file, rel below f, and writes
// it back only when something changed, keeping the previous contents at
// rel+".berth-backup" and the file's mode. A file that is not a JSON object
// is left untouched.
func editJSON(f files, rel string, change func(map[string]any) bool) (bool, error) {
	root := map[string]any{}
	before, err := f.read(rel)
	switch {
	case err == nil:
		if err := json.Unmarshal(before, &root); err != nil {
			return false, fmt.Errorf("%s is not valid JSON, so berth left it alone: %w", f.path(rel), err)
		}
	case !os.IsNotExist(err):
		return false, err
	}
	if !change(root) {
		return false, nil
	}
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return false, err
	}
	if len(before) > 0 {
		if err := f.backup(rel, before); err != nil {
			return false, err
		}
	}
	return true, f.write(rel, append(out, '\n'), 0o644)
}

// berth's MCP server is `berthd mcp`: only the box daemon serves it, as it
// talks to the box's own socket.
func mcpBin(bin string) bool { return filepath.Base(bin) == "berthd" }

// InstallMCP adds berth's MCP server to a JSON settings file's mcpServers
// (Claude Code's ~/.claude.json, Gemini CLI's settings.json).
func InstallMCP(path, bin string, claude bool) (bool, error) {
	f, rel := fileAt(path)
	return installMCP(f, rel, bin, claude)
}

func installMCP(f files, rel, bin string, claude bool) (bool, error) {
	return editJSON(f, rel, func(root map[string]any) bool {
		servers := object(root, "mcpServers")
		want := map[string]any{"command": bin, "args": []any{"mcp"}}
		if claude {
			want["type"] = "stdio"
		}
		if cur, ok := servers["berth"].(map[string]any); ok && cur["command"] == bin {
			return false
		}
		servers["berth"] = want
		return true
	})
}

// InstallCodexMCP adds [mcp_servers.berth] to Codex's config.toml.
func InstallCodexMCP(configPath, bin string) (bool, error) {
	f, rel := fileAt(configPath)
	return installCodexMCP(f, rel, bin)
}

func installCodexMCP(f files, rel, bin string) (bool, error) {
	before, err := f.read(rel)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	if strings.Contains(string(before), "[mcp_servers.berth]") {
		return false, nil
	}
	after := string(before)
	if after != "" && !strings.HasSuffix(after, "\n") {
		after += "\n"
	}
	after += fmt.Sprintf("\n[mcp_servers.berth]\ncommand = %q\nargs = [\"mcp\"]\n", bin)
	if len(before) > 0 {
		if err := f.backup(rel, before); err != nil {
			return false, err
		}
	}
	return true, f.write(rel, []byte(after), 0o600)
}
