package boxcmd

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/box/runs"
)

// Durable runs from the command line: start one from a template, follow
// it, list them, decide their gates. They run on the box, so following one
// can stop (Ctrl-C) without stopping it.

func runsCmd(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	status := fs.String("status", "", "only runs with this status (or active, done)")
	template := fs.String("template", "", "only runs of this template")
	limit := fs.Int("limit", 20, "how many")
	if pos, err := parse(fs, args); err != nil || len(pos) > 0 {
		return usageErr("runs [--status active|done|S] [--template T] [--limit 20] [--json]")
	}
	all, err := c.Runs(ctx, runs.Filter{Status: *status, Template: *template, Limit: *limit})
	if err != nil {
		return err
	}
	return show(out, *asJSON, all, func() {
		w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "RUN\tTEMPLATE\tSTATUS\tSTARTED\tTITLE")
		for _, s := range all {
			title := s.Title
			if s.Gate != nil {
				title += "  [gate: " + s.Gate.Title + "]"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", s.ID, s.Template, s.Status, s.Created.Local().Format("Jan 2 15:04"), title)
		}
		w.Flush()
	})
}

// params reads --param k=v flags; a value that is JSON (a number, a list,
// an object, true) is taken as such.
type paramFlags map[string]any

func (p paramFlags) String() string { return "" }
func (p paramFlags) Set(v string) error {
	k, val, ok := strings.Cut(v, "=")
	if !ok || k == "" {
		return errors.New("a param is key=value")
	}
	var j any
	if json.Unmarshal([]byte(val), &j) == nil {
		switch j.(type) {
		case float64, bool, []any, map[string]any:
			p[k] = j
			return nil
		}
	}
	p[k] = val
	return nil
}

func runCmd(ctx context.Context, c *box.Client, sub string, args []string, out io.Writer) error {
	switch sub {
	case "start":
		return runStart(ctx, c, args, out)
	case "templates":
		return runTemplates(ctx, c, args, out)
	case "get":
		return runGet(ctx, c, args, out)
	case "logs":
		return runLogs(ctx, c, args, out)
	case "cancel":
		pos, err := parse(flag0(), args)
		if err != nil || len(pos) != 1 {
			return usageErr("run cancel RUN")
		}
		if err := c.CancelRun(ctx, pos[0]); err != nil {
			return err
		}
		fmt.Fprintf(out, "Cancelled %s\n", pos[0])
		return nil
	case "approve", "reject":
		return runDecide(ctx, c, sub == "approve", args, out)
	case "judge":
		pos, err := parse(flag0(), args)
		if err != nil || len(pos) != 1 {
			return usageErr("run judge RUN")
		}
		ev, err := c.RejudgeRun(ctx, pos[0])
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Judging %s again (evaluation %d); it stays waiting for your pick\n", pos[0], ev.N)
		return nil
	}
	return fmt.Errorf("unknown command run %s", sub)
}

func flag0() *flag.FlagSet {
	fs, _ := flags(nil)
	return fs
}

func runStart(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	template := fs.String("template", "", "template: loop, review, handoff, broadcast, attempts, fix-ci, address-review, exec")
	follow := fs.Bool("follow", false, "follow it until it ends (Ctrl-C detaches)")
	idem := fs.String("idem", "", "idempotency key: a retried start returns the same run")
	params := paramFlags{}
	fs.Var(params, "param", "a template parameter, key=value (repeatable)")
	noNotify := fs.Bool("no-notify", false, "don't tell this agent (BERTH_SESSION) when it ends or waits at a gate")
	pos, err := parse(fs, args)
	if err != nil || *template == "" || len(pos) > 0 {
		return usageErr("run start --template T [--param k=v]... [--follow] [--idem KEY] [--no-notify] [--json]")
	}
	s, err := reportBack(c, *noNotify || *follow).StartRun(ctx, box.RunRequest{Template: *template, Params: params}, *idem)
	if err != nil {
		return err
	}
	if !*follow {
		return show(out, *asJSON, s, func() { fmt.Fprintf(out, "Started run %s (%s)\n", s.ID, s.Status) })
	}
	fmt.Fprintf(out, "Started run %s\n", s.ID)
	return followRun(ctx, c, s.ID, out, false)
}

func runTemplates(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	if pos, err := parse(fs, args); err != nil || len(pos) > 0 {
		return usageErr("run templates [--json]")
	}
	ts, err := c.RunTemplates(ctx)
	if err != nil {
		return err
	}
	return show(out, *asJSON, ts, func() {
		for _, t := range ts {
			var ps []string
			for k, p := range t.Params {
				if p.Required {
					k += "*"
				}
				ps = append(ps, k)
			}
			slices.Sort(ps)
			fmt.Fprintf(out, "%s: %s\n  params: %s\n", t.Name, t.Description, strings.Join(ps, ", "))
		}
	})
}

func runGet(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	pos, err := parse(fs, args)
	if err != nil || len(pos) != 1 {
		return usageErr("run get RUN [--json]")
	}
	r, err := c.Run(ctx, pos[0])
	if err != nil {
		return err
	}
	return show(out, *asJSON, r, func() { printRun(out, r) })
}

func runLogs(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	since := fs.Int("since", 0, "the journal record to start from")
	follow := fs.Bool("follow", false, "keep following")
	pos, err := parse(fs, args)
	if err != nil || len(pos) != 1 {
		return usageErr("run logs RUN [--since N] [--follow] [--json]")
	}
	return c.RunEvents(ctx, pos[0], *since, *follow, func(rec box.RunRecord) {
		if *asJSON {
			b, _ := json.Marshal(rec)
			fmt.Fprintln(out, string(b))
			return
		}
		if line := recordLine(rec.Record); line != "" {
			fmt.Fprintln(out, line)
		}
	})
}

func runDecide(ctx context.Context, c *box.Client, approve bool, args []string, out io.Writer) error {
	fs, _ := flags(args)
	note := fs.String("note", "", "a note with the decision")
	pick := fs.Int("pick", 0, "the attempt to pick (1-based), at a pick gate")
	pos, err := parse(fs, args)
	if err != nil || len(pos) < 1 || len(pos) > 2 {
		return usageErr("run approve|reject RUN [STEP] [--pick N] [--note TEXT]")
	}
	step := ""
	if len(pos) == 2 {
		step = pos[1]
	}
	d := box.GateDecision{Approve: approve, Note: *note}
	if *pick > 0 {
		p := *pick - 1
		d.Pick = &p
	}
	if err := c.DecideGate(ctx, pos[0], step, d); err != nil {
		return err
	}
	fmt.Fprintf(out, "%s %s\n", map[bool]string{true: "Approved", false: "Rejected"}[approve], pos[0])
	return nil
}

// followRun prints a run's progress until it ends. Interrupted, it leaves
// the run going (or cancels it with cancelOnExit).
func followRun(ctx context.Context, c *box.Client, id string, out io.Writer, cancelOnExit bool) error {
	since := 0
	for {
		err := c.RunEvents(ctx, id, since, true, func(rec box.RunRecord) {
			since = rec.N + 1
			if line := recordLine(rec.Record); line != "" {
				fmt.Fprintln(out, line)
			}
		})
		if ctx.Err() != nil {
			if cancelOnExit {
				cctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				c.CancelRun(cctx, id)
				fmt.Fprintf(out, "\nCancelled %s.\n", id)
				return ctx.Err()
			}
			fmt.Fprintf(out, "\nDetached. The run goes on on the box: run get %s\n", id)
			return nil
		}
		r, gerr := c.Run(ctx, id)
		if gerr == nil && runs.Terminal(r.Status) {
			if r.Status != runs.Succeeded {
				return fmt.Errorf("run %s %s: %s", id, r.Status, r.Error)
			}
			return nil
		}
		if err != nil {
			// The stream dropped (a restart of berthd, say): pick it up again.
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func recordLine(r runs.Record) string {
	at := r.At.Local().Format("15:04:05")
	switch r.T {
	case "run.created":
		if r.Run != nil {
			return fmt.Sprintf("%s  run %s (%s) created", at, r.Run.ID, r.Run.Template)
		}
	case "step.finished":
		if r.Step == nil || r.Step.Status == "skipped" || r.Step.Kind == "" {
			return ""
		}
		line := fmt.Sprintf("%s  %-10s %-12s %s", at, r.Step.Path, r.Step.Kind, r.Step.Status)
		if r.Step.Duration != "" {
			line += " (" + r.Step.Duration + ")"
		}
		if o := firstLineOf(r.Step.Output); o != "" {
			line += "  " + o
		}
		if r.Step.Error != "" {
			line += "  " + r.Step.Error
		}
		return line
	case "gate.opened":
		if r.Gate != nil {
			return fmt.Sprintf("%s  waiting at gate %q (%s): %s", at, r.Gate.Title, r.Path, gateWays(r.Gate))
		}
	case "gate.decided":
		if r.Decided != nil {
			return fmt.Sprintf("%s  gate %s %s by %s", at, r.Path, map[bool]string{true: "approved", false: "rejected"}[r.Decided.Approve], r.Decided.By)
		}
	case "run.finished":
		line := fmt.Sprintf("%s  run %s", at, r.Status)
		if r.Error != "" {
			line += ": " + r.Error
		}
		return line
	}
	return ""
}

// gateWays is how to decide a gate: approve or reject, or the two ways on
// it names (retry publishing, or finish without a pull request).
func gateWays(g *runs.Gate) string {
	if g.ApproveLabel == "" || g.RejectLabel == "" {
		return "run approve|reject RUN"
	}
	return "run approve RUN to " + strings.ToLower(g.ApproveLabel) + ", run reject RUN to " + strings.ToLower(g.RejectLabel)
}

func firstLineOf(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 80 {
		s = s[:80] + "…"
	}
	return s
}

func printRun(out io.Writer, r runs.Run) {
	fmt.Fprintf(out, "%s  %s  %s\n", r.ID, r.Template, r.Status)
	if r.Title != "" {
		fmt.Fprintf(out, "  %s\n", r.Title)
	}
	if r.Error != "" {
		fmt.Fprintf(out, "  error: %s\n", r.Error)
	}
	if r.Gate != nil {
		fmt.Fprintf(out, "  waiting at gate %q (%s)\n", r.Gate.Title, r.Gate.Path)
		if r.Gate.ApproveLabel != "" {
			fmt.Fprintf(out, "  %s\n", gateWays(r.Gate))
		}
	}
	if r.Usage != nil {
		fmt.Fprintf(out, "  agents used %d tokens", r.Usage.Tokens())
		if r.Usage.USD > 0 {
			fmt.Fprintf(out, ", $%.2f", r.Usage.USD)
		}
		fmt.Fprintln(out)
	}
	var walk func([]runs.StepRun, string)
	walk = func(steps []runs.StepRun, indent string) {
		for _, s := range steps {
			if s.Status == "skipped" {
				continue
			}
			label := s.Kind
			if label == "" {
				label = s.ID
			}
			fmt.Fprintf(out, "%s%-8s %-12s %-10s %s\n", indent, s.Path, label, s.Status, firstLineOf(s.Output+" "+s.Error))
			walk(s.Children, indent+"  ")
		}
	}
	walk(r.Steps, "  ")
	for _, c := range r.Candidates {
		check := "failed"
		if c.Verify.Passed {
			check = "passed"
		}
		pick := ""
		if c.Picked {
			pick = "  ← picked"
		}
		fmt.Fprintf(out, "  attempt %d  %-7s %s  +%d -%d  check %s  rank %d%s\n", c.Index+1, c.Agent, c.Worktree, c.Diff.Added, c.Diff.Removed, check, c.Judge.Rank, pick)
	}
}

// loopRun is loop on a box with durable runs: a run of the loop template,
// followed. Ctrl-C detaches; --cancel-on-exit cancels instead.
func loopRun(ctx context.Context, c *box.Client, session, prompt, check string, max int, turnTimeout time.Duration, cancelOnExit, detach bool, out io.Writer) error {
	params := map[string]any{"session": session, "check": check, "max": max, "timeout": turnTimeout.String()}
	if prompt != "" {
		params["prompt"] = prompt
	}
	s, err := c.StartRun(ctx, box.RunRequest{Template: "loop", Params: params}, "loop-"+session+"-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Loop run %s started on the box", s.ID)
	if detach {
		fmt.Fprintln(out, ".")
		return nil
	}
	fmt.Fprintln(out, "; Ctrl-C stops following, not the loop.")
	return followRun(ctx, c, s.ID, out, cancelOnExit)
}

// hasRuns reports whether the box runs durable runs.
func hasRuns(ctx context.Context, c *box.Client) bool {
	info, err := c.Info(ctx)
	if err != nil {
		return false
	}
	return slices.Contains(info.Capabilities, "runs")
}

// flowSecret makes a webhook flow's signing secret, shown once.
func flowSecret(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	scope := fs.String("scope", "", "box or repo:LOCATION, when two flows share the id")
	pos, err := parse(fs, args)
	if err != nil || len(pos) != 1 {
		return usageErr("flow secret FLOW [--scope S] [--json]")
	}
	var res map[string]string
	if err := c.Call(ctx, "POST", "/v1/flows/"+pos[0]+"/secret", map[string]string{"scope": *scope}, &res); err != nil {
		return err
	}
	return show(out, *asJSON, res, func() {
		fmt.Fprintf(out, "Secret for %s (%s), shown once:\n  %s\nPOST %s with X-Berth-Timestamp and\nX-Berth-Signature: sha256=HMAC(secret, timestamp + \".\" + body).\n", res["flow"], res["scope"], res["secret"], res["path"])
	})
}
