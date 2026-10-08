package integrations

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/cosscom/shipyard/internal/agentpath"
)

// Tool is an agent CLI berth has integrations for.
type Tool struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
	// configDir, under home, is where the tool keeps its settings. Its being
	// there says the tool has run on this machine, even when its command is
	// not on this process's PATH.
	configDir string
	// hookFile and hookMarker find berth's hook in the tool's settings;
	// currentFile and currentMarker, this release's hooks. Claude Code's and
	// Codex's are in each account folder instead (accountHooks).
	hookFile, hookMarker       string
	currentFile, currentMarker string
}

// Tools are the agent CLIs `integrations install` knows, in the order they
// are reported.
var Tools = []Tool{
	{ID: "claude", Name: "Claude Code", Command: "claude", configDir: ".claude"},
	{ID: "codex", Name: "Codex", Command: "codex", configDir: ".codex"},
	// ~/.cursor also belongs to the Cursor editor, so only the CLI counts.
	{ID: "cursor", Name: "Cursor Agent", Command: "cursor-agent",
		hookFile: filepath.Join(".cursor", "hooks.json"), hookMarker: "hook cursor stop",
		currentMarker: "hook cursor beforeSubmitPrompt"},
	{ID: "gemini", Name: "Gemini CLI", Command: "gemini", configDir: ".gemini",
		hookFile: filepath.Join(".gemini", "settings.json"), hookMarker: "hook gemini AfterAgent"},
	{ID: "opencode", Name: "OpenCode", Command: "opencode", configDir: filepath.Join(".config", "opencode"),
		hookFile: filepath.Join(".config", "opencode", "plugin", "berth.js"), hookMarker: "hook opencode"},
	{ID: "grok", Name: "Grok CLI", Command: "grok", configDir: ".grok",
		hookFile: filepath.Join(".grok", "hooks", "berth.json"), hookMarker: "hook grok",
		currentMarker: "hook grok StopCancelled"},
}

// ToolByID finds a tool by its ID.
func ToolByID(id string) (Tool, bool) {
	for _, t := range Tools {
		if t.ID == id {
			return t, true
		}
	}
	return Tool{}, false
}

// Present reports whether t is on this machine: its command found as the
// person's terminal finds it (internal/agentpath: their interactive shell,
// then PATH and where agent CLIs install themselves, nvm, fnm, volta, npm's
// prefix and the like, which an SSH command's or a service's PATH leaves
// out), or its settings folder in home.
func (t Tool) Present(home string) bool {
	if _, ok := finderFor(home).Find(t.Command); ok {
		return true
	}
	if t.configDir != "" {
		if st, err := os.Stat(filepath.Join(home, t.configDir)); err == nil && st.IsDir() {
			return true
		}
	}
	return false
}

// Hooked reports whether berth's hook is in t's settings in home: any berth
// or berthd binary's, so a hook installed from another path counts. For
// Claude Code and Codex it is the default account's; AccountStates has the
// others.
func (t Tool) Hooked(home string) bool {
	if _, ok := AccountVars[t.ID]; ok {
		hooked, _ := accountHooks(t.ID, defaultAccount(home, t.ID).Dir)
		return hooked
	}
	b, err := os.ReadFile(filepath.Join(home, t.hookFile))
	return err == nil && bytes.Contains(b, []byte(t.hookMarker))
}

// Current reports whether t's hooks are this release's: an older berth's
// lack the signals turns need (Claude's PostToolUse, say).
func (t Tool) Current(home string) bool {
	if _, ok := AccountVars[t.ID]; ok {
		_, current := accountHooks(t.ID, defaultAccount(home, t.ID).Dir)
		return current
	}
	if !t.Hooked(home) {
		return false
	}
	if t.currentMarker == "" {
		return true
	}
	file := t.currentFile
	if file == "" {
		file = t.hookFile
	}
	b, err := os.ReadFile(filepath.Join(home, file))
	return err == nil && bytes.Contains(b, []byte(t.currentMarker))
}

// RefreshHooked brings hooks berth installed before up to this release's,
// as an upgrade does, and gives Claude Code and Codex accounts added since
// what their default account has; tools without berth's hooks are left
// alone. It returns what it updated: "claude", or "claude in DIR" for one
// account.
func RefreshHooked(home, bin string) []string {
	var done []string
	for _, t := range Tools {
		if _, ok := AccountVars[t.ID]; ok {
			done = append(done, refreshAccounts(home, t.ID, bin)...)
			continue
		}
		if t.Hooked(home) && !t.Current(home) {
			if InstallTool(home, t.ID, bin, io.Discard) == nil {
				done = append(done, t.ID)
			}
		}
	}
	return done
}

// systemBinDirs are searched after home's, for another home than this
// user's; tests empty it.
var systemBinDirs = []string{"/usr/local/bin", "/opt/homebrew/bin"}

// askShell says this user's home is looked in through their shell; tests
// turn it off.
var askShell = true

// finderFor finds agent CLIs for home: this user's through their shell
// (agentpath.Default), another's in its folders alone.
func finderFor(home string) *agentpath.Finder {
	if d := agentpath.Default(); askShell && filepath.Clean(d.Home) == filepath.Clean(home) {
		return d
	}
	return &agentpath.Finder{Home: home, Env: []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}, NoVersion: true, NoNPM: true, NoCache: true, SystemDirs: append([]string{}, systemBinDirs...)}
}

func isExecutable(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
}

// Detect lists the tools present in home.
func Detect(home string) (present, missing []Tool) {
	for _, t := range Tools {
		if t.Present(home) {
			present = append(present, t)
		} else {
			missing = append(missing, t)
		}
	}
	return present, missing
}

// InstallDetected installs integrations for every tool present in home, for
// the binary at bin, and says what it did on out. command is how to run
// that binary by hand, for the advice about tools that are not there yet.
// A tool that fails is reported and the rest still install; the error
// returned names every failure.
func InstallDetected(home, bin, command string, out io.Writer) error {
	present, missing := Detect(home)
	fmt.Fprintln(out, "Agent integrations (hooks for needs-you, working and done; Shipyard's skills):")
	var failed []string
	for _, t := range present {
		var buf bytes.Buffer
		if err := InstallTool(home, t.ID, bin, &buf); err != nil {
			fmt.Fprintf(out, "  %s: not installed: %v\n", t.Name, err)
			fmt.Fprintf(out, "    Fix that, then run: %s integrations install %s\n", command, t.ID)
			failed = append(failed, t.Name)
			continue
		}
		out.Write(indentLines(buf.Bytes(), "  "))
	}
	if len(present) == 0 {
		names := make([]string, len(Tools))
		for i, t := range Tools {
			names[i] = t.Command
		}
		fmt.Fprintf(out, "  No agent CLIs found (%s).\n", strings.Join(names, ", "))
	}
	if len(missing) > 0 {
		ids := make([]string, len(missing))
		names := make([]string, len(missing))
		for i, t := range missing {
			ids[i], names[i] = t.ID, t.Name
		}
		fmt.Fprintf(out, "  Not found: %s. After installing one, run: %s integrations install %s\n", strings.Join(names, ", "), command, strings.Join(ids, "|"))
	}
	if len(failed) > 0 {
		return fmt.Errorf("integrations for %s did not install", strings.Join(failed, ", "))
	}
	return nil
}

// InstallPresent installs integrations for every tool present in home, for
// the binary at bin, saying what it did on out, and nothing about the
// tools that aren't there.
func InstallPresent(home, bin string, out io.Writer) error {
	present, _ := Detect(home)
	if len(present) == 0 {
		fmt.Fprintln(out, "No agent CLIs on this box yet; Shipyard adds their hooks when you add one from the box's settings.")
		return nil
	}
	var failed []string
	for _, t := range present {
		if err := InstallTool(home, t.ID, bin, out); err != nil {
			fmt.Fprintf(out, "%s: not installed: %v\n", t.Name, err)
			failed = append(failed, t.Name)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("integrations for %s did not install", strings.Join(failed, ", "))
	}
	return nil
}

func indentLines(b []byte, prefix string) []byte {
	if len(b) == 0 {
		return b
	}
	lines := strings.SplitAfter(string(b), "\n")
	var sb strings.Builder
	for _, l := range lines {
		if l != "" {
			sb.WriteString(prefix + l)
		}
	}
	return []byte(sb.String())
}
