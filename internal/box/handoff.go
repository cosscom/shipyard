package box

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
)

// A handoff packet is what the next agent needs and no more: the source
// agent's own note (Done, Left, Decisions, Gotchas), then what berth knows
// without asking it: the diffstat, the commits, the last check's failing
// tail and the turn log. It is capped at about 2 KB plus file paths, and the
// new agent's first prompt only points at it.

const handoffLimit = 2048

func (h *runHost) handoffPacket(ctx context.Context, x *runs.StepCtx) runs.Result {
	b := h.b
	src := target(x)
	sess, err := b.Sessions.Get(ctx, src)
	if err != nil {
		return fail(err)
	}
	dir := sess.Dir
	agent := agentFor(sess)
	loc, wt, _ := b.worktreeAt(ctx, dir)
	var p strings.Builder
	fmt.Fprintf(&p, "# Handoff from %s (%s)\nBranch %s, from %s\n", src, agent, wt.Branch, dir)
	note, _ := readCapped(filepath.Join(dir, ".berth", "handoff", x.Run.ID+".md"), 1200)
	if strings.TrimSpace(note) == "" {
		note = "(the agent wrote no note)"
	}
	fmt.Fprintf(&p, "\n## Note\n%s\n", strings.TrimSpace(note))
	base := loc.DefaultBranch
	d := diffSummary(ctx, dir, base)
	fmt.Fprintf(&p, "\n## Changes\n%d files +%d -%d against %s, %d commits", d.files, d.added, d.removed, orStr(base, "HEAD"), d.commits)
	if d.subjects != "" {
		fmt.Fprintf(&p, ": %s", d.subjects)
	}
	p.WriteString("\n")
	// Uncommitted work travels as a stash commit, applied in the new
	// worktree; untracked files do not.
	wip := ""
	if out, err := git(ctx, "-C", dir, "stash", "create"); err == nil {
		wip = strings.TrimSpace(string(out))
	}
	if wip != "" {
		p.WriteString("Uncommitted changes were carried over (untracked files were not).\n")
	}
	if fb := x.Vars["steps.check.feedback"]; fb != "" {
		fmt.Fprintf(&p, "\n## Last check failed\n%s\n", tailRunes(fb, 400))
	}
	if b.Turns != nil {
		var lines []string
		for _, tr := range b.Turns.List(src, 5) {
			l := fmt.Sprintf("#%d %s %s", tr.N, tr.Origin, tr.State)
			if !tr.Started.IsZero() && !tr.Ended.IsZero() {
				l += " " + tr.Ended.Sub(tr.Started).Round(time.Second).String()
			}
			lines = append(lines, l)
		}
		if len(lines) > 0 {
			fmt.Fprintf(&p, "\n## Last turns\n%s\n", strings.Join(lines, "; "))
		}
	}
	packet := p.String()
	if len(packet) > handoffLimit {
		packet = packet[:handoffLimit] + "\n…"
	}
	set := map[string]string{"handoff.packet": packet, "handoff.branch": wt.Branch, "handoff.agent": agent, "handoff.dir": dir, "handoff.wip": wip, "location": loc.Name}
	if b.Turns != nil {
		if st, ok := b.Turns.State(src); ok {
			set["handoff.agent_session_id"] = st.AgentSessionID
		}
	}
	return runs.Result{Status: runs.Succeeded, Out: fmt.Sprintf("packet of %d bytes", len(packet)), Set: set}
}

func orStr(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func readCapped(path string, n int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, n))
	return string(b), err
}

// writeHandoff puts the packet in the new worktree, where git ignores it,
// and applies the source's uncommitted work.
func writeHandoff(dir, runID, packet string) error {
	if dir == "" {
		return fmt.Errorf("no worktree to hand off to")
	}
	hd := filepath.Join(dir, ".berth", "handoff")
	if err := os.MkdirAll(hd, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(hd, runID+".md"), []byte(packet), 0o644); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if out, err := git(ctx, "-C", dir, "rev-parse", "--git-path", "info/exclude"); err == nil {
		ex := strings.TrimSpace(string(out))
		if !filepath.IsAbs(ex) {
			ex = filepath.Join(dir, ex)
		}
		cur, _ := os.ReadFile(ex)
		if !strings.Contains(string(cur), ".berth/handoff/") {
			os.MkdirAll(filepath.Dir(ex), 0o755)
			f, err := os.OpenFile(ex, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			if err == nil {
				f.WriteString("\n.berth/handoff/\n")
				f.Close()
			}
		}
	}
	return nil
}

// applyWIP applies the source's stash commit in the new worktree.
func applyWIP(dir, sha string) {
	if sha == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	git(ctx, "-C", dir, "stash", "apply", sha)
}

var claudeProjectChars = regexp.MustCompile(`[^A-Za-z0-9]`)

// claudeProjectDir is where Claude Code keeps the conversations of dir.
func claudeProjectDir(home, dir string) string {
	return filepath.Join(home, ".claude", "projects", claudeProjectChars.ReplaceAllString(dir, "-"))
}

// nativeResume starts the next agent from the source agent's own
// conversation when both are the same vendor on this box: Claude forks it
// (copied into the new worktree's project, as Claude looks a session up by
// folder), Codex resumes it.
func nativeResume(p AgentPreset, agent string, vars map[string]string, dir, prompt string) (string, string) {
	sid := vars["handoff.agent_session_id"]
	if sid == "" || vars["handoff.agent"] != agent || !regexp.MustCompile(`^[A-Za-z0-9-]{8,80}$`).MatchString(sid) {
		return "", ""
	}
	switch agent {
	case "claude":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", ""
		}
		from := filepath.Join(claudeProjectDir(home, vars["handoff.dir"]), sid+".jsonl")
		to := filepath.Join(claudeProjectDir(home, dir), sid+".jsonl")
		b, err := os.ReadFile(from)
		if err != nil {
			return "", ""
		}
		os.MkdirAll(filepath.Dir(to), 0o700)
		if os.WriteFile(to, b, 0o600) != nil {
			return "", ""
		}
		return p.Command + " --resume " + shellQuote(sid) + " --fork-session " + shellQuote(prompt), "forked Claude session " + sid[:8]
	case "codex":
		return codexCommand(p) + " resume " + shellQuote(sid) + " " + shellQuote(prompt), "resumed Codex session " + sid[:8]
	}
	return "", ""
}

// SessionUsage reads what an agent session spent from the agent's own
// session log: token counts only, never content. It is the usage plugin's
// parser, box-side. since limits it to entries from then on.
func SessionUsage(agent, sid, cwd string, since time.Time) *runs.Usage {
	home, err := os.UserHomeDir()
	if err != nil || sid == "" || strings.ContainsAny(sid, "/\\") {
		return nil
	}
	switch agent {
	case "claude":
		path := filepath.Join(claudeProjectDir(home, cwd), sid+".jsonl")
		if _, err := os.Stat(path); err != nil {
			m, _ := filepath.Glob(filepath.Join(home, ".claude", "projects", "*", sid+".jsonl"))
			if len(m) == 0 {
				return nil
			}
			path = m[0]
		}
		return claudeUsage(path, since)
	case "codex":
		m, _ := filepath.Glob(filepath.Join(home, ".codex", "sessions", "*", "*", "*", "rollout-*"+sid+"*.jsonl"))
		if len(m) == 0 {
			return nil
		}
		return codexUsage(m[0], since)
	}
	return nil
}

func eachLine(path string, want []string, fn func(map[string]any)) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		line := sc.Text()
		hit := false
		for _, w := range want {
			hit = hit || strings.Contains(line, w)
		}
		if !hit {
			continue
		}
		var o map[string]any
		if json.Unmarshal(sc.Bytes(), &o) == nil {
			fn(o)
		}
	}
}

func after(o map[string]any, since time.Time) bool {
	if since.IsZero() {
		return true
	}
	ts, _ := o["timestamp"].(string)
	t, err := time.Parse(time.RFC3339, ts)
	return err != nil || !t.Before(since)
}

func claudeUsage(path string, since time.Time) *runs.Usage {
	u := &runs.Usage{}
	seen := map[string]bool{}
	num := func(v any) int64 { f, _ := v.(float64); return int64(f) }
	eachLine(path, []string{`"usage"`, `"cost-state"`}, func(o map[string]any) {
		switch o["type"] {
		case "cost-state":
			// The session's running total: only for the whole session.
			if c, ok := o["totalCostUSD"].(float64); ok && since.IsZero() {
				u.USD = c
			}
		case "assistant":
			if !after(o, since) {
				return
			}
			m, _ := o["message"].(map[string]any)
			us, _ := m["usage"].(map[string]any)
			if us == nil {
				return
			}
			key := fmt.Sprint(m["id"], o["requestId"])
			if seen[key] {
				return
			}
			seen[key] = true
			u.Input += num(us["input_tokens"])
			u.Output += num(us["output_tokens"])
			u.CacheRead += num(us["cache_read_input_tokens"])
			u.CacheWrite += num(us["cache_creation_input_tokens"])
		}
	})
	if u.Tokens() == 0 && u.USD == 0 {
		return nil
	}
	return u
}

func codexUsage(path string, since time.Time) *runs.Usage {
	var first, last map[string]any
	eachLine(path, []string{"token_count"}, func(o map[string]any) {
		p, _ := o["payload"].(map[string]any)
		info, _ := p["info"].(map[string]any)
		total, _ := info["total_token_usage"].(map[string]any)
		if total == nil {
			return
		}
		if first == nil && !after(o, since) {
			return
		}
		if first == nil {
			first = map[string]any{}
		}
		last = total
	})
	if last == nil {
		return nil
	}
	num := func(v any) int64 { f, _ := v.(float64); return int64(f) }
	cached := num(last["cached_input_tokens"])
	return &runs.Usage{Input: num(last["input_tokens"]) - cached, CacheRead: cached, Output: num(last["output_tokens"])}
}
