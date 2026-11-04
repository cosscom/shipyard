package box

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/statefile"
)

// Headless workers: one non-interactive agent turn (claude -p, codex exec,
// gemini -p) run inside tmux, so a person can still attach and watch it,
// while berth reads its structured output: the final message, the tokens
// and cost, and the agent's own session ID. Judges and reviewers use them.

// headlessDone is what `berthd headless` leaves beside its output when the
// agent ends.
type headlessDone struct {
	Final     string      `json:"final"`
	Exit      int         `json:"exit"`
	Error     string      `json:"error,omitempty"`
	SessionID string      `json:"session_id,omitempty"`
	Usage     *runs.Usage `json:"usage,omitempty"`
}

func pathSlug(p string) string { return unsafeName.ReplaceAllString(p, "-") }

func eventAs(b *Box, origin, typ string, data map[string]any) events.Event {
	return events.Event{Type: typ, Box: b.Name, Origin: origin, Data: data}
}

func (h *runHost) headless(ctx context.Context, x *runs.StepCtx) runs.Result {
	b := h.b
	s := x.Step
	agent := runs.ExpandText(s.Agent, x.Vars)
	if agent == "" {
		agent = "claude"
	}
	dir := x.Vars["worktree.path"]
	if src := runs.ExpandText(s.Session, x.Vars); src != "" {
		if sess, err := b.Sessions.Get(ctx, src); err == nil {
			dir = sess.Dir
		}
	}
	work := filepath.Join(b.Runs.Dir, x.Run.ID+".d")
	if err := os.MkdirAll(work, 0o700); err != nil {
		return fail(err)
	}
	if dir == "" {
		// A judge works in a folder of its own, with nothing to edit.
		dir = filepath.Join(work, "scratch")
		os.MkdirAll(dir, 0o700)
	}
	base := filepath.Join(work, pathSlug(x.Path)+fmt.Sprintf("-%d", x.Attempt))
	out, donePath, promptPath := base+".jsonl", base+".done", base+".prompt"
	name := runSessionName(x.Run.ID, "h", agent, x.Path)
	timeout := stepTimeout(s, 20*time.Minute)
	if d, ok := readDone(donePath); ok {
		return d.result() // finished before a restart: never asked again
	}
	if sess, err := b.Sessions.Get(ctx, name); err != nil || sess.Exited {
		if err == nil {
			b.Sessions.Kill(ctx, name)
		}
		loc, _, _ := b.worktreeAt(ctx, dir)
		var p AgentPreset
		if pp, ok := presetFor(&loc, agent); ok {
			p = pp
		} else {
			return fail(fmt.Errorf("unknown agent %q", agent))
		}
		prompt := expand(s.Text, x.Vars)
		var addDirs []string
		if len(x.Candidates) > 0 && (strings.HasSuffix(x.Path, ".ask") || strings.HasSuffix(x.Path, ".ask2")) {
			for _, c := range x.Candidates {
				if c.Path != "" {
					addDirs = append(addDirs, c.Path)
				}
			}
			if s.Diff {
				prompt += candidateDiffs(ctx, x.Candidates, x.Vars["params.base"])
			}
		}
		if err := os.WriteFile(promptPath, []byte(prompt), 0o600); err != nil {
			return fail(err)
		}
		exe, err := os.Executable()
		if err != nil {
			return fail(err)
		}
		args := []string{shellQuote(exe), "headless", "--agent", shellQuote(agent), "--bin", shellQuote(p.Command), "--out", shellQuote(out), "--prompt-file", shellQuote(promptPath)}
		if strings.Contains(x.Path, ".ask") || x.Run.Template == "review" {
			args = append(args, "--read-only")
		}
		for _, d := range addDirs {
			args = append(args, "--add-dir", shellQuote(d))
		}
		command := strings.Join(args, " ")
		// The agent's CLI is found with the PATH it was found with, as an
		// agent's own session finds it.
		command = withPATH(sessionShell(), launchPATH("", agent), command)
		where := "headless"
		if l, wt, ok := b.worktreeAt(ctx, dir); ok {
			where = l.Name + "/" + wt.Name
		}
		if err := b.beforeAs(ctx, origOf(x), "session.start", map[string]any{"path": dir, "command": command, "agent": agent, "headless": true}); err != nil {
			return fail(err)
		}
		if _, err := b.startUnseen(dir, func() (Session, error) { return b.Sessions.create(ctx, name, where, dir, command, "", nil, nil, nil) }); err != nil {
			return fail(err)
		}
		b.Events.Publish(eventAs(b, origOf(x), "session.started", map[string]any{"name": name, "location": where, "path": dir, "agent": agent, "headless": true, "run": x.Run.ID}))
	}
	// Wait for the done file, the session ending without one, or the time.
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		if d, ok := readDone(donePath); ok {
			return d.result()
		}
		if sess, err := b.Sessions.Get(ctx, name); err != nil || sess.Exited {
			time.Sleep(300 * time.Millisecond)
			if d, ok := readDone(donePath); ok {
				return d.result()
			}
			screen, _ := b.Sessions.Screen(ctx, name, 20)
			return runs.Result{Status: runs.Failed, Code: 1, Err: "the headless agent ended without an answer", Out: tailRunes(strings.TrimSpace(screen), 1500)}
		}
		select {
		case <-ctx.Done():
			return runs.Result{Status: runs.Failed, Err: "stopped"}
		case <-deadline.C:
			b.Sessions.Kill(context.WithoutCancel(ctx), name)
			return runs.Result{Status: runs.Failed, Code: -1, Err: fmt.Sprintf("no answer within %v", timeout)}
		case <-tick.C:
		}
	}
}

func readDone(path string) (headlessDone, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return headlessDone{}, false
	}
	var d headlessDone
	if json.Unmarshal(b, &d) != nil {
		return headlessDone{}, false
	}
	return d, true
}

func (d headlessDone) result() runs.Result {
	res := runs.Result{Status: runs.Succeeded, Out: tailRunes(strings.TrimSpace(d.Final), 4000), Usage: d.Usage, Code: d.Exit,
		Set: map[string]string{"headless.session_id": d.SessionID}}
	if d.Exit != 0 || d.Error != "" {
		res.Status, res.Err = runs.Failed, d.Error
		if res.Err == "" {
			res.Err = fmt.Sprintf("exited with %d", d.Exit)
		}
	}
	return res
}

// candidateDiffs is each candidate's diff, capped at 4 KB, for a judge
// asked to see them.
func candidateDiffs(ctx context.Context, cands []runs.Candidate, base string) string {
	var b strings.Builder
	for _, c := range cands {
		ref := "HEAD"
		if base != "" {
			if out, err := git(ctx, "-C", c.Path, "merge-base", "HEAD", base); err == nil {
				ref = strings.TrimSpace(string(out))
			}
		}
		out, _ := git(ctx, "-C", c.Path, "diff", ref)
		d := string(out)
		if len(d) > 4096 {
			d = d[:4096] + "\n… (cut at 4 KB)"
		}
		fmt.Fprintf(&b, "\n--- attempt %d diff ---\n%s", c.Index+1, d)
	}
	return b.String()
}

// RunHeadless is `berthd headless`: it runs one agent turn without its TUI,
// keeps the agent's JSON output in --out, shows a readable version on the
// terminal, and writes --out.done (without the .jsonl) when it ends.
func RunHeadless(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("headless", flag.ContinueOnError)
	agent := fs.String("agent", "claude", "agent: claude, codex or gemini")
	bin := fs.String("bin", "", "the agent's command (default: the agent's name)")
	out := fs.String("out", "", "where to keep its JSON output")
	promptFile := fs.String("prompt-file", "", "the prompt")
	readOnly := fs.Bool("read-only", false, "let it read, never edit")
	var addDirs multiFlag
	fs.Var(&addDirs, "add-dir", "another folder it may read (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *out == "" || *promptFile == "" {
		return errors.New("usage: berthd headless --agent A --out FILE.jsonl --prompt-file FILE")
	}
	prompt, err := os.ReadFile(*promptFile)
	if err != nil {
		return err
	}
	command := strings.Fields(*bin)
	if len(command) == 0 {
		command = []string{*agent}
	}
	argv := HeadlessArgs(*agent, command, string(prompt), *readOnly, addDirs)
	donePath := strings.TrimSuffix(*out, ".jsonl") + ".done"
	writeDone := func(d headlessDone) {
		b, _ := json.Marshal(d)
		statefile.Write(donePath, b)
	}
	f, err := os.OpenFile(*out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	fmt.Fprintf(stdout, "berth: headless %s (%s)\n", *agent, strings.Join(argv[:min(len(argv), 3)], " "))
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stderr = os.Stderr
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		writeDone(headlessDone{Exit: 127, Error: err.Error()})
		return err
	}
	p := &headlessParser{agent: *agent}
	sc := bufio.NewScanner(pipe)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		line := sc.Bytes()
		f.Write(append(append([]byte(nil), line...), '\n'))
		if s := p.line(line); s != "" {
			fmt.Fprintln(stdout, s)
		}
	}
	err = cmd.Wait()
	d := p.done()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			d.Exit = ee.ExitCode()
		} else {
			d.Exit, d.Error = 1, err.Error()
		}
	}
	writeDone(d)
	fmt.Fprintf(stdout, "berth: done (exit %d)\n", d.Exit)
	return nil
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

// HeadlessArgs is the command line of one non-interactive turn.
func HeadlessArgs(agent string, command []string, prompt string, readOnly bool, addDirs []string) []string {
	argv := append([]string(nil), command...)
	switch agent {
	case "claude":
		argv = append(argv, "-p", "--output-format", "stream-json", "--verbose")
		if readOnly {
			argv = append(argv, "--allowedTools", "Read,Grep,Glob,LS", "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash")
		}
		for _, d := range addDirs {
			argv = append(argv, "--add-dir", d)
		}
		return append(argv, prompt)
	case "codex":
		argv = append(argv, "exec", "--json", "--skip-git-repo-check")
		if readOnly {
			argv = append(argv, "--sandbox", "read-only")
		}
		return append(argv, prompt)
	case "gemini":
		return append(argv, "-p", prompt, "--output-format", "json")
	}
	return append(argv, prompt)
}

// headlessParser reads an agent's JSON output as it streams.
type headlessParser struct {
	agent string
	final string
	sid   string
	usage runs.Usage
	whole strings.Builder // gemini prints one JSON document
	plain strings.Builder
}

func (p *headlessParser) line(b []byte) string {
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		if p.agent == "gemini" {
			p.whole.Write(b)
			p.whole.WriteByte('\n')
		} else {
			if p.plain.Len() < 16<<10 {
				p.plain.Write(b)
				p.plain.WriteByte('\n')
			}
		}
		return string(b)
	}
	num := func(v any) int64 {
		f, _ := v.(float64)
		return int64(f)
	}
	switch p.agent {
	case "claude":
		switch m["type"] {
		case "system":
			if s, _ := m["session_id"].(string); s != "" {
				p.sid = s
			}
		case "assistant":
			msg, _ := m["message"].(map[string]any)
			content, _ := msg["content"].([]any)
			var out []string
			for _, c := range content {
				cm, _ := c.(map[string]any)
				switch cm["type"] {
				case "text":
					out = append(out, fmt.Sprint(cm["text"]))
				case "tool_use":
					out = append(out, "  [tool] "+fmt.Sprint(cm["name"]))
				}
			}
			return strings.Join(out, "\n")
		case "result":
			p.final, _ = m["result"].(string)
			if s, _ := m["session_id"].(string); s != "" {
				p.sid = s
			}
			if u, ok := m["usage"].(map[string]any); ok {
				p.usage.Input, p.usage.Output = num(u["input_tokens"]), num(u["output_tokens"])
				p.usage.CacheRead, p.usage.CacheWrite = num(u["cache_read_input_tokens"]), num(u["cache_creation_input_tokens"])
			}
			p.usage.USD, _ = m["total_cost_usd"].(float64)
			return "--- result ---\n" + p.final
		}
	case "codex":
		switch m["type"] {
		case "thread.started":
			p.sid, _ = m["thread_id"].(string)
		case "item.completed":
			it, _ := m["item"].(map[string]any)
			if it["type"] == "agent_message" {
				p.final, _ = it["text"].(string)
				return p.final
			}
			return "  [" + fmt.Sprint(it["type"]) + "]"
		case "turn.completed":
			if u, ok := m["usage"].(map[string]any); ok {
				cached := num(u["cached_input_tokens"])
				p.usage.Input += num(u["input_tokens"]) - cached
				p.usage.CacheRead += cached
				p.usage.Output += num(u["output_tokens"])
			}
		}
	case "gemini":
		p.whole.Write(b)
		p.whole.WriteByte('\n')
	}
	return ""
}

func (p *headlessParser) done() headlessDone {
	d := headlessDone{Final: p.final, SessionID: p.sid}
	if p.agent == "gemini" {
		var g struct {
			Response string `json:"response"`
			Stats    struct {
				Models map[string]struct {
					Tokens struct {
						Prompt     int64 `json:"prompt"`
						Candidates int64 `json:"candidates"`
						Cached     int64 `json:"cached"`
					} `json:"tokens"`
				} `json:"models"`
			} `json:"stats"`
		}
		if json.Unmarshal([]byte(p.whole.String()), &g) == nil {
			d.Final = g.Response
			for _, m := range g.Stats.Models {
				p.usage.Input += m.Tokens.Prompt - m.Tokens.Cached
				p.usage.CacheRead += m.Tokens.Cached
				p.usage.Output += m.Tokens.Candidates
			}
		}
	}
	if d.Final == "" {
		d.Final = p.plain.String()
	}
	if p.usage.Tokens() > 0 || p.usage.USD > 0 {
		u := p.usage
		d.Usage = &u
	}
	return d
}
