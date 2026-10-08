package box

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/wire"
)

// AgentPreset is a way to start a coding agent: what the app offers when it
// starts one, and what a task runs.
type AgentPreset struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
	// PromptFlag passes a first prompt; empty means it is the last argument.
	PromptFlag string `json:"prompt_flag,omitempty"`
	// ModelFlag passes a model ("--model"); empty means berth offers no
	// model choice for this agent.
	ModelFlag string `json:"model_flag,omitempty"`
	// EffortFlag passes an effort: a flag ("--effort"), or a word ending in
	// "=" that takes the value with no space ("-c model_reasoning_effort=").
	EffortFlag string `json:"effort_flag,omitempty"`
	// Models and Efforts are what the app offers, as the CLI's own names
	// (aliases where it has them, so the list does not go stale). Leaving one
	// out means the CLI's default. A repository's .berth/config.json can set
	// them for a built-in agent by giving its id and no command.
	Models  []string `json:"models,omitempty"`
	Efforts []string `json:"efforts,omitempty"`
}

// builtinAgents are the agent CLIs berth knows how to start, by binary.
// The model and effort flags are each CLI's own, from its --help: Claude
// Code's --model takes aliases (opus, sonnet, haiku) and --effort low to max;
// Codex takes -m/--model and its reasoning effort as the config key
// model_reasoning_effort; OpenCode and Cursor Agent take --model; Grok CLI
// takes --model and --effort (none through max, only the levels the model
// advertises). Grok's first prompt is the last argument, like Claude.
var builtinAgents = []AgentPreset{
	{ID: "claude", Name: "Claude Code", Command: "claude", ModelFlag: "--model", EffortFlag: "--effort",
		Models: []string{"opus", "sonnet", "haiku"}, Efforts: []string{"low", "medium", "high", "xhigh", "max"}},
	{ID: "codex", Name: "Codex", Command: "codex", ModelFlag: "--model", EffortFlag: "-c model_reasoning_effort=",
		Efforts: []string{"minimal", "low", "medium", "high"}},
	{ID: "opencode", Name: "OpenCode", Command: "opencode", PromptFlag: "--prompt", ModelFlag: "--model"},
	{ID: "gemini", Name: "Gemini CLI", Command: "gemini", PromptFlag: "-i"},
	{ID: "cursor", Name: "Cursor Agent", Command: "cursor-agent", ModelFlag: "--model"},
	{ID: "grok", Name: "Grok CLI", Command: "grok", ModelFlag: "--model", EffortFlag: "--effort",
		Efforts: []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}},
}

// Presets are the built-in agents this box has, then the location's own from
// its repository's .berth/config.json, which may replace a built-in by ID.
func Presets(loc *Location) []AgentPreset {
	var out []AgentPreset
	for _, p := range builtinAgents {
		if _, ok := agentFound(p.Command); ok {
			out = append(out, p)
		}
	}
	if loc == nil {
		return out
	}
	for _, own := range loc.Agents {
		replaced := false
		for i := range out {
			if out[i].ID != own.ID {
				continue
			}
			replaced = true
			if own.Command == "" {
				// Only its lists: the built-in's command and flags stay.
				if own.Models != nil {
					out[i].Models = own.Models
				}
				if own.Efforts != nil {
					out[i].Efforts = own.Efforts
				}
				continue
			}
			out[i] = own
		}
		if !replaced && own.Command != "" {
			out = append(out, own)
		}
	}
	return out
}

// presetFor finds the preset with id, or a built-in even when it is not on
// PATH, so the error comes from the session rather than a guess.
func presetFor(loc *Location, id string) (AgentPreset, bool) {
	for _, p := range Presets(loc) {
		if p.ID == id {
			return p, true
		}
	}
	for _, p := range builtinAgents {
		if p.ID == id {
			return p, true
		}
	}
	return AgentPreset{}, false
}

// AgentCommand is the command line that starts p with a first prompt.
func AgentCommand(p AgentPreset, prompt string) string {
	cmd, _ := AgentCommandWith(p, prompt, "", "")
	return cmd
}

// modelWord is what a model or effort may be: a CLI's name for one, never
// anything a shell would read as more than one word.
var modelWord = regexp.MustCompile(`^[A-Za-z0-9._:/-]+$`)

// AgentCommandWith is the command line that starts p with a first prompt, a
// model and an effort; empty means the CLI's default. A value that is not a
// plain name, or one the agent has no flag for, is refused.
func AgentCommandWith(p AgentPreset, prompt, model, effort string) (string, error) {
	cmd := p.Command
	if model != "" {
		if !modelWord.MatchString(model) || strings.HasPrefix(model, "-") {
			return "", badRequest("%q is not a model name", model)
		}
		if p.ModelFlag == "" {
			return "", badRequest("berth does not know how to pick a model for %s", p.Name)
		}
		cmd += " " + p.ModelFlag + " " + model
	}
	if effort != "" {
		if !modelWord.MatchString(effort) || strings.HasPrefix(effort, "-") {
			return "", badRequest("%q is not an effort level", effort)
		}
		if p.EffortFlag == "" {
			return "", badRequest("berth does not know how to set the effort for %s", p.Name)
		}
		if strings.HasSuffix(p.EffortFlag, "=") {
			cmd += " " + p.EffortFlag + effort
		} else {
			cmd += " " + p.EffortFlag + " " + effort
		}
	}
	if prompt == "" {
		return cmd, nil
	}
	if max := maxPromptArg(); len(prompt) > max {
		return "", httpError{http.StatusRequestEntityTooLarge, fmt.Sprintf(
			"the prompt is %d KB, but an agent gets its first prompt as one argument, which this box's kernel caps at %d KB: start it with the start of it and send the rest once it runs, or attach it as a file",
			len(prompt)>>10, max>>10)}
	}
	if p.PromptFlag != "" {
		return cmd + " " + p.PromptFlag + " " + shellQuote(prompt), nil
	}
	return cmd + " " + shellQuote(prompt), nil
}

// maxPromptArg is the longest first prompt an agent can be started with:
// the program gets it as one argument, which Linux caps at 128 KB
// (MAX_ARG_STRLEN) and macOS at its 1 MB for every argument and the
// environment together. A prompt sent to a running agent has no such cap.
func maxPromptArg() int {
	if runtime.GOOS == "linux" {
		return 128<<10 - 1
	}
	return 896 << 10
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// agentOf names the agent a session's command runs, or "" for anything else.
// It looks past what commonly wraps an agent: env and its assignments,
// exec, nohup, npx and the like, `op run --`, and a package name such as
// @anthropic-ai/claude-code.
func agentOf(command string) string {
	fields := strings.Fields(command)
	for i, f := range fields {
		if i >= 8 {
			break
		}
		bin := filepath.Base(f)
		for _, p := range builtinAgents {
			if bin == p.Command {
				return p.ID
			}
		}
		pkg := f
		if i := strings.LastIndex(pkg, "@"); i > 0 {
			pkg = pkg[:i] // a version: @anthropic-ai/claude-code@latest
		}
		if id, ok := agentPackages[pkg]; ok {
			return id
		}
		if !wrapperWord(f) {
			return ""
		}
	}
	return ""
}

// agentPackages are agents' npm packages, as npx and friends run them.
var agentPackages = map[string]string{
	"@anthropic-ai/claude-code": "claude",
	"@openai/codex":             "codex",
	"@google/gemini-cli":        "gemini",
	"opencode-ai":               "opencode",
}

// wrapperWord is a word that runs the command after it.
func wrapperWord(f string) bool {
	switch filepath.Base(f) {
	case "env", "exec", "nohup", "command", "time", "npx", "bunx", "pnpx", "dlx", "pnpm", "yarn", "op", "run", "--", "caffeinate", "nice":
		return true
	}
	if strings.HasPrefix(f, "-") {
		return true
	}
	k, _, ok := strings.Cut(f, "=")
	return ok && k != "" && !strings.ContainsAny(k, "/ ")
}

// agentFor is the agent a session runs: its preset when berth started it
// with one, else what its command looks like. A service's terminal runs
// none, whatever its command.
func agentFor(s Session) string {
	if s.Service != "" {
		return ""
	}
	if s.Preset != "" {
		for _, p := range builtinAgents {
			if p.ID == s.Preset {
				return p.ID
			}
		}
		if a := agentOf(s.Command); a != "" {
			return a
		}
		return s.Preset
	}
	return agentOf(s.Command)
}

// TaskRequest makes a worktree and starts an agent in it, in one step.
type TaskRequest struct {
	Location string `json:"location"`
	Name     string `json:"name"`
	Branch   string `json:"branch,omitempty"`
	Base     string `json:"base,omitempty"`
	PR       int    `json:"pr,omitempty"`
	Ref      string `json:"ref,omitempty"`
	// Agent is a preset ID; Command, when set, is run instead.
	Agent   string `json:"agent,omitempty"`
	Command string `json:"command,omitempty"`
	Prompt  string `json:"prompt,omitempty"`
	// Model and Effort pick the agent's model and effort, by the CLI's own
	// names (see AgentPreset); empty is the CLI's default.
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
	// FromSession names the session handing this work off, if any.
	FromSession string `json:"from_session,omitempty"`
	// Open asks the app to show the new session: "split" or "tab".
	Open string `json:"open,omitempty"`
	// Title names the work; without one, the prompt's first line does.
	Title string `json:"title,omitempty"`
}

type Task struct {
	Worktree Worktree `json:"worktree"`
	Session  Session  `json:"session"`
}

func (b *Box) addTask(w http.ResponseWriter, r *http.Request) error {
	var req TaskRequest
	if err := decodeLimit(r, &req, maxPromptBody); err != nil {
		return err
	}
	if req.Location == "" || req.Name == "" {
		return badRequest("a task needs a location and a name")
	}
	// Without tmux there is nothing to run the agent in: say so before
	// making a worktree that would only be removed again.
	if _, err := tmuxPath(); err != nil {
		return err
	}
	ctx := r.Context()
	loc, err := b.Locations.Get(ctx, req.Location)
	if err != nil {
		return err
	}
	command := req.Command
	if command == "" && req.Agent != "" {
		p, ok := presetFor(&loc, req.Agent)
		if !ok {
			return badRequest("unknown agent %q", req.Agent)
		}
		if command, err = AgentCommandWith(p, req.Prompt, req.Model, req.Effort); err != nil {
			return err
		}
	} else if req.Model != "" || req.Effort != "" {
		return badRequest("a model or an effort needs an agent, not a command")
	}
	data := map[string]any{"location": req.Location, "name": req.Name, "branch": req.Branch, "base": req.Base, "agent": req.Agent, "command": command}
	if err := b.before(r, "task.create", data); err != nil {
		return err
	}
	wt, err := b.createWorktree(r, loc, WorktreeRequest{Name: req.Name, Branch: req.Branch, Base: req.Base, PR: req.PR, Ref: req.Ref})
	if err != nil {
		return err
	}
	// Handed off from an agent's worktree: it nests under that one.
	if parent := b.parentFor(ctx, loc, req.FromSession); parent != "" {
		if err := b.Locations.SetWorktreeParent(req.Location, wt.Path, parent); err == nil {
			wt.Parent = parent
		}
	}
	where := req.Location + "/" + wt.Name
	preset := ""
	if req.Command == "" {
		preset = req.Agent
	}
	sess, err := b.startSession(r, defaultSessionName(where, command), where, wt.Path, command, preset, preset != "" && req.Prompt != "")
	if err != nil {
		// A task is a worktree with an agent in it: without the agent, the
		// worktree it made goes too, so a retry starts clean.
		if rmErr := b.Locations.RemoveWorktree(context.WithoutCancel(r.Context()), req.Location, wt.Name, true); rmErr != nil {
			return fmt.Errorf("created %s, but could not start its session (%w); removing the worktree failed too: %v", wt.Path, err, rmErr)
		}
		b.publish(r, "worktree.removed", map[string]any{"location": req.Location, "name": wt.Name, "path": wt.Path, "reason": "task failed"})
		return fmt.Errorf("could not start the task's session, so its worktree was removed: %w", err)
	}
	sess = b.titleNew(ctx, sess, req.Title, req.Prompt)
	b.publish(r, "task.created", map[string]any{
		"location": req.Location, "name": wt.Name, "path": wt.Path, "branch": wt.Branch,
		"session": sess.Name, "agent": req.Agent, "from_session": req.FromSession,
	})
	b.announceOpen(r, sess, req.Open)
	b.watchCaller(r, Watch{Kind: "task", Session: sess.Name})
	writeJSON(w, Task{Worktree: wt, Session: sess})
	return nil
}

// before asks the hooks gating typ, the box's and then the repository's,
// whether the request may go ahead.
func (b *Box) before(r *http.Request, typ string, data map[string]any) error {
	e := events.Event{Type: typ, Box: b.Name, Origin: gateOrigin(r), Data: data}
	if b.Hooks != nil {
		if err := b.Hooks.Before(r.Context(), e); err != nil {
			return httpError{http.StatusForbidden, err.Error()}
		}
	}
	return b.beforeRepo(r, e)
}

// gateOrigin is the origin a gate sees. A gate scoped to a tool lets that
// tool's own actions through, so the claim must be one the box can vouch for:
// only callers on its own socket (the box user's tools, which could edit the
// hooks anyway) may name a tool. A paired laptop or the phone is named by who
// it authenticated as, which no tool name can equal.
func gateOrigin(r *http.Request) string {
	if wire.IsLocal(r.Context()) {
		return origin(r)
	}
	if p := wire.PeerFrom(r.Context()); p.Name != "" {
		return "laptop:" + p.Name
	}
	return "remote"
}

// enrich adds what each session's agent is doing, from the turn ledger.
func (b *Box) enrich(ctx context.Context, all []Session) []Session {
	for i := range all {
		s := &all[i]
		if u, ok := b.Sessions.scopeUsage(ctx, *s); ok && !s.Exited {
			s.Usage = &u
		}
		s.Agent = agentFor(*s)
		if s.Agent == "" {
			continue
		}
		if s.Exited {
			if b.Turns != nil {
				b.Turns.Exited(s.Name)
			}
			continue
		}
		s.AgentState = "running"
		if b.Turns != nil {
			st := b.Turns.Track(*s)
			if st.State != "" && st.State != "exited" {
				s.AgentState, s.StateSince = st.State, st.Since
			}
			s.Turn, s.StateSeq, s.Fidelity = st.Turn, st.Seq, st.Fidelity
			s.Queued = st.Queued
			if s.AgentState == "waiting" {
				s.Ask = st.Ask
			}
		}
	}
	return all
}
