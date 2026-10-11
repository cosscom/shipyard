// Package boxcmd implements the commands that act on a box's locations,
// worktrees, sessions, shares, and events. `berthd` runs them against its
// own box; `berth` runs them against a paired box after stripping the box
// name from the command line.
package boxcmd

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/events"
)

// usageColumn is where descriptions start in Usage; a command line too long
// to fit puts its description on the next line, at the same column.
const usageColumn = 50

// usageSections lists the box commands. In each command, %[1]s is the
// program, %[2]s the box prefix of a reference (BOX/ or nothing), %[3]s a
// standalone box argument (" BOX" or nothing) and %[4]s the flags only the
// laptop takes. A description may run to several lines.
var usageSections = []struct {
	title string
	lines [][2]string
}{
	{"Locations and worktrees", [][2]string{
		{"%[1]s locations%[3]s [--json]", "List locations and their worktrees"},
		{"%[1]s location add %[2]sNAME PATH", "Register a repo or directory"},
		{"%[1]s location rm %[2]sNAME", "Forget a location (files are untouched)"},
		{"%[1]s location scripts %[2]sNAME [--setup CMD] [--archive CMD] [--clear]", "Worktree setup/archive scripts (default: the repo's .berth/config.json)"},
		{"%[1]s location config %[2]sNAME [--json] [--trust HASH|--untrust]", "The repo's, the box's and the effective config; trust the repo's to run it"},
		{"%[1]s services%[3]s [--json]", "Which worktree each running server belongs to"},
		{"%[1]s service list|start|stop|restart|log %[2]sLOC/WORKTREE [SERVICE]", "A worktree's services from the repo's config"},
		{"%[1]s preview %[2]s[LOC/WORKTREE] [PORT] [--path /x]", "Open a worktree's page in the Shipyard app"},
		{"%[1]s worktree new %[2]sLOC/NAME [--branch B] [--base REF] [--pr N [--ref REF]] [--parent NAME]", "Create a git worktree and run its setup; --pr checks out a\npull request (BRANCH should be its head branch; a fork's head\nis fetched from REF, default pull/N/head); --parent nests it\nunder another worktree of the location"},
		{"%[1]s worktree rm %[2]sLOC/NAME [--force]", "Remove a worktree"},
		{"%[1]s worktree rename %[2]sLOC/NAME [TITLE]", "Give a worktree a display name (its branch and folder keep\ntheir names; no TITLE clears it)"},
		{"%[1]s reviews%[3]s [--idle-days N] [--json]", "Pull requests opened for review here; --idle-days sets how long\none may sit unused before it is cleaned up (0: never)"},
		{"%[1]s review-button %[2]s[LOC/WT] [--as EMAIL] [--path /x] [--clear] [--json]", "The \"Review in Shipyard\" button on the worktree's PR; --as and\n--path set what it opens with"},
		{"%[1]s login users %[2]s[LOC[/WT]] [--json]", "Who the project's worktrees can be logged in as"},
	}},
	{"Agent sessions", [][2]string{
		{"%[1]s sessions%[3]s [--json]", "List sessions"},
		{"%[1]s agents%[3]s [--json]", "Agent CLIs this box can start"},
		{"%[1]s task new %[2]sLOC/NAME [--agent ID] [--prompt TEXT] [--title T] [--open split|tab] [--branch B] [--base REF] [--no-notify] [-- COMMAND...]", "A worktree with an agent (or COMMAND) running in it; run from\nan agent, it hears back when the first turn ends"},
		{"%[1]s session new %[2]sLOC[/WORKTREE] [--name N] [--agent ID [--prompt TEXT]] [--title T] [--open split|tab] [-- COMMAND...]", "Start an agent or COMMAND (default: a shell) there"},
		{"%[1]s session rename %[2]sNAME [TITLE]", "Name a session's work (no TITLE clears it; a prompt names an untitled one)"},
		{"%[1]s session screen %[2]sNAME [--history N]", "Print what the session shows"},
		{"%[1]s session send %[2]sNAME TEXT [--when now|idle] [--force] [--idem KEY] [--no-enter] [--wait [--timeout 30m]] [--no-notify]%[4]s", "Type a prompt into a session (or hold it until the agent is idle), and wait for its turn"},
		{"%[1]s session wait %[2]sNAME [--turn ID] [--for finished,waiting] [--timeout 30m]", "Wait for a turn, or its agent's current one, to end"},
		{"%[1]s session turns %[2]sNAME [--limit 10] [--json]", "List a session's turns"},
		{"%[1]s exec %[2]sLOC[/WORKTREE] [--timeout 10m] [--detach [--no-notify]] -- COMMAND...", "Run a command there and print its output (--detach: as a run)"},
		{"%[1]s loop %[2]sSESSION --check CMD [--prompt TEXT] [--max 5] [--turn-timeout 30m]\n         [--cancel-on-exit] [--detach]", "Prompt, wait, check, and feed failures back: a durable\nrun on the box (Ctrl-C detaches)"},
		{"%[1]s session kill %[2]sNAME", "Stop a session"},
	}},
	{"Artifacts (what agents make for you to look at)", [][2]string{
		{"%[1]s artifact add FILE --title T [--kind chart|table|diagram|page|notes] [--id ID] [--note N]\n         [--by HELPER] [--in LOC/WT]", "Show a berth.chart JSON, CSV, Mermaid, Markdown or one HTML file in\nthe Shipyard app; rewriting the file updates it live"},
		{"%[1]s artifact list [%[2]sLOC/WT] [--json]", "A worktree's artifacts"},
		{"%[1]s artifact show ID [--content [--version N]] [--json]", "One artifact and its versions, or its content"},
		{"%[1]s artifact rm ID", "Forget an artifact"},
	}},
	{"Runs (durable, on the box)", [][2]string{
		{"%[1]s runs%[3]s [--status active|done|S] [--template T] [--limit 20] [--json]", "List runs"},
		{"%[1]s run templates%[3]s [--json]", "The templates and their parameters"},
		{"%[1]s run start%[3]s --template T [--param k=v]... [--follow] [--idem KEY] [--no-notify] [--json]", "Start a run (loop, review, handoff, broadcast, attempts, ...)"},
		{"%[1]s run get %[2]sRUN [--json]", "A run's steps, gate, attempts and tokens"},
		{"%[1]s run logs %[2]sRUN [--since N] [--follow] [--json]", "Its journal, as it happens"},
		{"%[1]s run approve|reject %[2]sRUN [STEP] [--pick N] [--note TEXT]", "Decide the gate it waits at"},
		{"%[1]s run cancel %[2]sRUN", "Stop a run"},
		{"%[1]s flow secret%[3]s FLOW [--scope S] [--json]", "Make a webhook flow's signing secret (shown once)"},
	}},
	{"Agent browser (a headless browser on the box, per worktree)", [][2]string{
		{"%[1]s browser open %[2]s[LOC/WT] [PATH|URL] [--as EMAIL] [--path /x] [--size WxH|PRESET] [--scale N]", "Open the worktree's page ($BERTH_URL), logged in as EMAIL with --as;\nprints a compact snapshot with @refs"},
		{"%[1]s browser resize %[2]s[LOC/WT] WxH|PRESET [--scale N]", "Set the page's size (default 1920x1080; phone 390x844, tablet, laptop); kept until changed"},
		{"%[1]s browser snapshot %[2]s[LOC/WT] [--full] [--delta] [--selector SEL] [--depth N]", "The page's elements (interactive by default; capped)"},
		{"%[1]s browser click|hover|check %[2]s[LOC/WT] @REF", "Act on an element; prints what changed"},
		{"%[1]s browser fill|select %[2]s[LOC/WT] @REF VALUE", "Fill a field or pick an option"},
		{"%[1]s browser press %[2]s[LOC/WT] [@REF] KEY", "Press Enter, Tab, Escape…"},
		{"%[1]s browser wait %[2]s[LOC/WT] --text T | --url U | --idle [--timeout 10s]", "Wait for the page"},
		{"%[1]s browser shot %[2]s[LOC/WT] [--el @REF] [--full] [--width 800 | --native]", "Save a screenshot; prints its path and size"},
		{"%[1]s browser console %[2]s[LOC/WT] [--all]", "New console errors and warnings since the last look"},
		{"%[1]s browser network %[2]s[LOC/WT]", "Failed requests since the last look"},
		{"%[1]s browser eval %[2]s[LOC/WT] JS", "Run JavaScript in the page (output capped at 2 KB)"},
		{"%[1]s browser status|close %[2]s[LOC/WT]", "Whether it runs, or close it"},
		{"%[1]s browser list%[3]s [--json]", "Browsers running on the box"},
		{"%[1]s browser allow%[3]s ORIGIN", "Let agents' browsers load a public origin (the box owner's)"},
		{"%[1]s browser reap%[3]s [--dry-run] [--json]", "Close agent-browser (Vercel's CLI) sessions left by ended berth sessions"},
	}},
	{"Visual diffs (before/after screenshots of a worktree's pages)", [][2]string{
		{"%[1]s shots compare %[2]s[LOC/WT] [--pages / /login] [--sizes 375 768 1280]\n         [--base main|turn-start|accepted|NAME] [--mask SEL]... [--color-scheme light|dark|both]\n         [--as EMAIL] [--title T] [--note N] [--new]", "Shoot the worktree's pages and the base's, diff them, and\nkeep a visual diff (a new version on a re-run)"},
		{"%[1]s shots baseline %[2]s[LOC/WT] [--name turn-start] [--pages …] [--sizes …]", "Save the worktree's pages as a baseline to compare with later"},
		{"%[1]s shots accept %[2]s[LOC/WT] ID", "Keep a visual diff's after-shots as the accepted baseline"},
	}},
	{"Ports and sharing", [][2]string{
		{"%[1]s ports%[3]s [--json]", "What is listening on the box"},
		{"%[1]s stats%[3]s [--json]", "Memory, disk, load, and agents running or waiting"},
		{"%[1]s ps%[3]s [--json]", "Browsers on the box (who started each, CPU, memory, age) and\nwhat each session's processes use"},
		{"%[1]s ps stop%[3]s ID", "Stop a browser from that list, or end a session (s-NAME)"},
		{"%[1]s info%[3]s", "The box's name, OS, build, tools and agent presets, as JSON"},
		{"%[1]s share%[3]s PORT", "Make a port public (Cloudflare quick tunnel)"},
		{"%[1]s shares%[3]s [--json]", "List public shares"},
		{"%[1]s unshare%[3]s ID", "Stop a share"},
	}},
	{"Units", [][2]string{
		{"%[1]s units%[3]s [--json]", "Managed units"},
		{"%[1]s unit add %[2]sNAME -- COMMAND...", "Install and start a unit"},
		{"%[1]s unit get %[2]sNAME [--json]", "A unit's state and where its log is"},
		{"%[1]s unit log %[2]sNAME", "What a unit has written, for one that will not stay up"},
		{"%[1]s unit restart %[2]sNAME", "Start a unit again"},
		{"%[1]s unit rm %[2]sNAME", "Stop and remove a unit (its log stays)"},
	}},
	{"Skills for agents", [][2]string{
		{"%[1]s skills%[3]s [list|install|uninstall] [SKILL...] [--agent claude|codex|all]\n         [--target user|project] [--location LOC] [--commit]", "Teach Claude Code and Codex to use berth"},
	}},
	{"Secrets", [][2]string{
		{"%[1]s secret test%[3]s REF", "Check this box can resolve op://vault/item/field or env://NAME\n(prints the value's length, never the value)"},
	}},
	{"Events", [][2]string{
		{"%[1]s emit%[3]s TYPE [key=value...] [--origin TOOL]", "Announce an event, e.g. agent.finished"},
		{"%[1]s events%[3]s [--json]", "Stream the box's events"},
	}},
}

// Usage lists the commands with box-relative references. prefix is "" on the
// box and "<box>/" on the laptop.
func Usage(cmd, prefix string) string {
	b := strings.TrimSuffix(prefix, "/")
	boxArg, laptopFlags := "", ""
	if b != "" {
		boxArg, laptopFlags = " "+b, " [--queue]"
	}
	indent := strings.Repeat(" ", usageColumn)
	var s strings.Builder
	for i, sec := range usageSections {
		if i > 0 {
			s.WriteString("\n")
		}
		s.WriteString(sec.title + "\n")
		for _, l := range sec.lines {
			if b != "" && strings.HasPrefix(l[0], "%[1]s events") {
				continue // berth's own events command lists it, with or without a box
			}
			use := "  " + fmt.Sprintf(l[0], cmd, prefix, boxArg, laptopFlags)
			desc := strings.ReplaceAll(l[1], "\n", "\n"+indent)
			if strings.Contains(use, "\n") || len(use) > usageColumn-2 {
				s.WriteString(use + "\n" + indent + desc + "\n")
			} else {
				s.WriteString(use + strings.Repeat(" ", usageColumn-len(use)) + desc + "\n")
			}
		}
	}
	return s.String()
}

// Queue, when set, keeps a prompt that could not be sent for later: the
// laptop's berth sets it to hand the prompt to its agent, which types it in
// once the box is back. It returns the queued prompt's id, or cause itself
// when the send failed for another reason (the prompt may have arrived, or
// the box refused it). session send --queue uses it.
var Queue func(ctx context.Context, session, text string, enter bool, cause error) (id string, err error)

// Commands names every command this package handles and how many words it
// takes before its first argument.
var Commands = map[string]int{
	"locations": 1, "location": 2, "worktree": 2,
	"sessions": 1, "session": 2, "task": 2, "agents": 1, "exec": 1, "loop": 1,
	"services": 1, "info": 1, "stats": 1, "ps": 1,
	"ports": 1, "share": 1, "shares": 1, "unshare": 1,
	"emit": 1, "events": 1,
	"skills": 1, "preview": 1, "service": 2,
	"units": 1, "unit": 2,
	"secret": 2,
	"runs":   1, "run": 2, "flow": 2, "browser": 2, "shots": 2,
	"artifact": 2,
	"reviews":  1, "review-button": 1, "login": 2,
}

// Run executes args, which start with the command words, against c.
func Run(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("missing command")
	}
	words := Commands[args[0]]
	if words == 0 || len(args) < words {
		return fmt.Errorf("unknown command %q", strings.Join(args, " "))
	}
	cmd := strings.Join(args[:words], " ")
	rest := args[words:]
	switch cmd {
	case "locations":
		return locations(ctx, c, rest, out)
	case "location add":
		fs, asJSON := flags(rest)
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 2 {
			return usageErr("location add NAME PATH")
		}
		loc, err := c.AddLocation(ctx, pos[0], pos[1])
		if err != nil {
			return err
		}
		return show(out, *asJSON, loc, func() {
			kind := "directory"
			if loc.Repo {
				kind = fmt.Sprintf("git repository, %d worktree(s)", len(loc.Worktrees))
			}
			fmt.Fprintf(out, "Added location %s → %s (%s)\n", loc.Name, loc.Path, kind)
		})
	case "location config":
		return locationConfig(ctx, c, rest, out)
	case "service list", "service start", "service stop", "service restart", "service log":
		return service(ctx, c, strings.TrimPrefix(cmd, "service "), rest, out)
	case "skills":
		return skills(ctx, c, rest, out)
	case "secret test":
		fs, asJSON := flags(rest)
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 1 {
			return usageErr("secret test REF")
		}
		res, err := c.TestSecret(ctx, pos[0])
		if err != nil {
			return err
		}
		if err := show(out, *asJSON, res, func() {
			if res.OK && res.Length != nil {
				fmt.Fprintf(out, "Resolved %s: %d characters\n", pos[0], *res.Length)
			}
		}); err != nil {
			return err
		}
		if !res.OK {
			return fmt.Errorf("could not resolve %s: %s", pos[0], res.Error)
		}
		return nil
	case "preview":
		return preview(ctx, c, rest, out)
	case "runs":
		return runsCmd(ctx, c, rest, out)
	case "flow secret":
		return flowSecret(ctx, c, rest, out)
	case "browser open", "browser resize", "browser snapshot", "browser click", "browser fill", "browser press", "browser select", "browser hover", "browser check",
		"browser wait", "browser shot", "browser console", "browser network", "browser status", "browser close", "browser eval", "browser allow", "browser list", "browser reap":
		return browserCmd(ctx, c, strings.TrimPrefix(cmd, "browser "), rest, out)
	case "shots compare", "shots baseline", "shots accept":
		return shotsCmd(ctx, c, strings.TrimPrefix(cmd, "shots "), rest, out)
	case "reviews":
		return reviewsCmd(ctx, c, rest, out)
	case "review-button":
		return reviewButtonCmd(ctx, c, rest, out)
	case "login users":
		return loginUsersCmd(ctx, c, rest, out)
	case "artifact add", "artifact list", "artifact ls", "artifact show", "artifact rm":
		return artifactCmd(ctx, c, strings.TrimPrefix(cmd, "artifact "), rest, out)
	case "run start", "run get", "run logs", "run cancel", "run approve", "run reject", "run templates":
		return runCmd(ctx, c, strings.TrimPrefix(cmd, "run "), rest, out)
	case "location scripts":
		fs, asJSON := flags(rest)
		setup := fs.String("setup", "", "command to run after a worktree is created")
		archive := fs.String("archive", "", "command to run before a worktree is removed")
		clear := fs.Bool("clear", false, "remove this location's own scripts and use the repository's")
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 1 {
			return usageErr("location scripts NAME [--setup CMD] [--archive CMD] [--clear]")
		}
		if *setup != "" || *archive != "" || *clear {
			if _, err := c.SetScripts(ctx, pos[0], *setup, *archive); err != nil {
				return err
			}
		}
		locs, err := c.Locations(ctx)
		if err != nil {
			return err
		}
		for _, l := range locs {
			if l.Name != pos[0] {
				continue
			}
			return show(out, *asJSON, l.Scripts, func() {
				if l.Scripts.Setup == "" && l.Scripts.Archive == "" {
					fmt.Fprintf(out, "%s has no lifecycle scripts (none set here, none in "+box.RepoConfigFile+").\n", l.Name)
					return
				}
				fmt.Fprintf(out, "%s scripts (from %s):\n  setup:   %s\n  archive: %s\n", l.Name, l.Scripts.From, l.Scripts.Setup, l.Scripts.Archive)
			})
		}
		return errors.New("no location with that name")
	case "services":
		fs, asJSON := flags(rest)
		parse(fs, rest)
		all, err := c.Services(ctx)
		if err != nil {
			return err
		}
		return show(out, *asJSON, all, func() {
			if len(all) == 0 {
				fmt.Fprintln(out, "No servers are running in any location.")
				return
			}
			w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "LOCATION\tWORKTREE\tPORT\tPROCESS")
			for _, s := range all {
				fmt.Fprintf(w, "%s\t%s\t%d\t%s\n", s.Location, s.Worktree, s.Port, s.Process)
			}
			w.Flush()
		})
	case "info":
		fs, _ := flags(rest)
		parse(fs, rest)
		i, err := c.Info(ctx)
		if err != nil {
			return err
		}
		return show(out, true, i, func() {})
	case "ps":
		return ps(ctx, c, rest, out)
	case "stats":
		fs, asJSON := flags(rest)
		parse(fs, rest)
		st, err := c.Stats(ctx)
		if err != nil {
			return err
		}
		return show(out, *asJSON, st, func() {
			fmt.Fprintf(out, "%s  %d CPUs  load %v\n", st.Hostname, st.CPUs, st.Load)
			fmt.Fprintf(out, "memory  %s of %s\n", gib(st.Memory.Used), gib(st.Memory.Total))
			for _, d := range st.Disks {
				fmt.Fprintf(out, "disk %s  %s of %s\n", d.Mount, gib(d.Used), gib(d.Total))
			}
			waiting := 0
			for _, a := range st.Agents {
				if a.State == "waiting" {
					waiting++
				}
			}
			fmt.Fprintf(out, "agents  %d running, %d waiting for you\n", len(st.Agents), waiting)
		})
	case "location rm":
		if len(rest) != 1 {
			return usageErr("location rm NAME")
		}
		if err := c.RemoveLocation(ctx, rest[0]); err != nil {
			return err
		}
		fmt.Fprintf(out, "Removed location %s; its files are untouched.\n", rest[0])
		return nil
	case "worktree new":
		return worktreeNew(ctx, c, rest, out)
	case "worktree rm":
		fs, _ := flags(rest)
		force := fs.Bool("force", false, "remove even with uncommitted changes")
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 1 {
			return usageErr("worktree rm LOC/NAME [--force]")
		}
		loc, name, ok := strings.Cut(pos[0], "/")
		if !ok {
			return usageErr("worktree rm LOC/NAME [--force]")
		}
		archive, err := c.RemoveWorktree(ctx, loc, name, box.RemoveOptions{Force: *force})
		if err != nil {
			return err
		}
		if archive != "" {
			fmt.Fprintf(out, "Archiving %s/%s: running %s, then removing it if that succeeds. Watch with the events command.\n", loc, name, archive)
			return nil
		}
		fmt.Fprintf(out, "Removed worktree %s/%s\n", loc, name)
		return nil
	case "worktree rename":
		fs, asJSON := flags(rest)
		pos, err := parse(fs, rest)
		if err != nil || len(pos) < 1 || len(pos) > 2 {
			return usageErr("worktree rename LOC/NAME [TITLE]")
		}
		loc, name, ok := strings.Cut(pos[0], "/")
		if !ok || name == "" {
			return usageErr("worktree rename LOC/NAME [TITLE]")
		}
		title := ""
		if len(pos) == 2 {
			title = pos[1]
		}
		wt, err := c.RenameWorktree(ctx, loc, name, title)
		if err != nil {
			// An older berthd has DELETE on this path but not PATCH.
			if strings.Contains(err.Error(), "405") {
				return fmt.Errorf("this box runs an older berthd without worktree names; update it (berth upgrade) and try again")
			}
			return err
		}
		return show(out, *asJSON, wt, func() {
			if wt.Title == "" {
				fmt.Fprintf(out, "%s/%s shows by its name again\n", loc, wt.Name)
			} else {
				fmt.Fprintf(out, "%s/%s shows as %q (its branch %s is unchanged)\n", loc, wt.Name, wt.Title, wt.Branch)
			}
		})
	case "sessions":
		return sessions(ctx, c, rest, out)
	case "session new":
		return sessionNew(ctx, c, rest, out)
	case "task new":
		return taskNew(ctx, c, rest, out)
	case "session send":
		fs, asJSON := flags(rest)
		noEnter := fs.Bool("no-enter", false, "type the text without pressing Enter")
		wait := fs.Bool("wait", false, "then wait for the turn it starts to end (finished or waiting)")
		timeout := fs.Duration("timeout", 30*time.Minute, "with --wait, give up after this long")
		when := fs.String("when", "now", "now, or idle: hold it on the box until the agent is idle")
		force := fs.Bool("force", false, "type even into an agent that is waiting for someone")
		idem := fs.String("idem", "", "a key that makes a retried send return the turn it already made")
		queue := fs.Bool("queue", false, "if the box cannot be reached, queue the prompt to send when it is back")
		noNotify := fs.Bool("no-notify", false, "don't tell this agent (BERTH_SESSION) when the turn ends")
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 2 {
			return usageErr("session send NAME TEXT [--when now|idle] [--force] [--idem KEY] [--no-enter] [--wait [--timeout 30m]] [--queue] [--no-notify]")
		}
		if *queue && Queue == nil {
			return errors.New("--queue is for the laptop: berth session send BOX/NAME TEXT --queue")
		}
		enter := !*noEnter
		// One who waits here sees the end itself.
		res, err := reportBack(c, *noNotify || *wait).Send(ctx, pos[0], box.SendRequest{Text: pos[1], Enter: &enter, When: *when, Force: *force, IdemKey: *idem})
		if err != nil {
			if !*queue {
				return err
			}
			id, qerr := Queue(ctx, pos[0], pos[1], enter, err)
			if qerr != nil {
				return qerr
			}
			return show(out, *asJSON, map[string]any{"queued": true, "id": id}, func() {
				fmt.Fprintf(out, "Could not reach the box (%v).\nQueued as %s: the berth agent types it into %s once the box is back. See berth queue.\n", err, id, pos[0])
			})
		}
		if !*wait {
			return show(out, *asJSON, res, func() {
				switch {
				case res.Queued:
					fmt.Fprintf(out, "Held for %s until its agent is idle (turn %s)\n", pos[0], res.Turn)
				case res.Turn != "":
					fmt.Fprintf(out, "Sent to %s (turn %s)\n", pos[0], res.Turn)
				default:
					fmt.Fprintf(out, "Sent to %s\n", pos[0])
				}
			})
		}
		w, err := waitSent(ctx, c, pos[0], res, []string{"finished", "waiting"}, *timeout)
		if err != nil {
			return err
		}
		return show(out, *asJSON, w, func() { printWait(out, w, *timeout) })
	case "session wait":
		fs, asJSON := flags(rest)
		states := fs.String("for", "finished,waiting", "states that end the wait")
		turn := fs.String("turn", "", "wait for this turn (from session send) rather than the agent's state")
		timeout := fs.Duration("timeout", 30*time.Minute, "give up after this long")
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 1 {
			return usageErr("session wait NAME [--turn ID] [--for finished,waiting] [--timeout 30m]")
		}
		if *turn != "" {
			w, err := waitTurn(ctx, c, *turn, strings.Contains(*states, "waiting"), *timeout)
			if err != nil {
				return err
			}
			return show(out, *asJSON, w, func() { printWait(out, w, *timeout) })
		}
		// The agent's state now counts: waiting for an agent that is
		// already idle returns at once. To wait for the turn a prompt
		// starts, use session send --wait or --turn.
		res, err := waitFor(ctx, c, pos[0], strings.Split(*states, ","), time.Time{}, *timeout)
		if err != nil {
			return err
		}
		return show(out, *asJSON, res, func() {
			if res.TimedOut {
				fmt.Fprintf(out, "Still %s after %v\n", res.State, *timeout)
				return
			}
			fmt.Fprintln(out, res.State)
		})
	case "session turns":
		fs, asJSON := flags(rest)
		limit := fs.Int("limit", 10, "how many of the latest turns")
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 1 {
			return usageErr("session turns NAME [--limit 10] [--json]")
		}
		turns, err := c.Turns(ctx, pos[0], *limit)
		if err != nil {
			return err
		}
		return show(out, *asJSON, turns, func() {
			if len(turns) == 0 {
				fmt.Fprintln(out, "No turns yet.")
				return
			}
			w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "TURN\tSTATE\tFROM\tSTARTED\tTOOK\tWAITED")
			for _, t := range turns {
				started, took := "-", "-"
				if !t.Started.IsZero() {
					started = t.Started.Local().Format("15:04:05")
					if !t.Ended.IsZero() {
						took = t.Ended.Sub(t.Started).Round(time.Second).String()
					}
				}
				waited := "-"
				if len(t.Waits) > 0 {
					waited = fmt.Sprintf("%d×", len(t.Waits))
				}
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", t.ID, t.State, t.Origin, started, took, waited)
			}
			w.Flush()
		})
	case "exec":
		return execCmd(ctx, c, rest, out)
	case "loop":
		return loop(ctx, c, rest, out)
	case "agents":
		fs, asJSON := flags(rest)
		parse(fs, rest)
		i, err := c.Info(ctx)
		if err != nil {
			return err
		}
		return show(out, *asJSON, i.Agents, func() {
			if len(i.Agents) == 0 {
				fmt.Fprintln(out, "No agent CLIs found on this box (claude, codex, opencode, gemini, cursor-agent).")
				return
			}
			w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tNAME\tCOMMAND")
			for _, a := range i.Agents {
				fmt.Fprintf(w, "%s\t%s\t%s\n", a.ID, a.Name, a.Command)
			}
			w.Flush()
		})
	case "session screen":
		fs, _ := flags(rest)
		history := fs.Int("history", 0, "earlier lines to include")
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 1 {
			return usageErr("session screen NAME [--history N]")
		}
		text, err := c.Screen(ctx, pos[0], *history)
		if err != nil {
			return err
		}
		fmt.Fprint(out, text)
		return nil
	case "session rename":
		fs, asJSON := flags(rest)
		pos, err := parse(fs, rest)
		if err != nil || len(pos) < 1 || len(pos) > 2 {
			return usageErr("session rename NAME [TITLE]")
		}
		title := ""
		if len(pos) == 2 {
			title = pos[1]
		}
		sess, err := c.RenameSession(ctx, pos[0], title)
		if err != nil {
			return err
		}
		return show(out, *asJSON, sess, func() {
			if sess.Title == "" {
				fmt.Fprintf(out, "Cleared the title of %s\n", sess.Name)
			} else {
				fmt.Fprintf(out, "Renamed %s to %q\n", sess.Name, sess.Title)
			}
		})
	case "session kill":
		if len(rest) != 1 {
			return usageErr("session kill NAME")
		}
		if err := c.KillSession(ctx, rest[0]); err != nil {
			return err
		}
		fmt.Fprintf(out, "Stopped session %s\n", rest[0])
		return nil
	case "ports":
		return ports(ctx, c, rest, out)
	case "share":
		fs, asJSON := flags(rest)
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 1 {
			return usageErr("share PORT")
		}
		port, err := strconv.Atoi(pos[0])
		if err != nil {
			return usageErr("share PORT")
		}
		sh, err := c.AddShare(ctx, port)
		if err != nil {
			return err
		}
		return show(out, *asJSON, sh, func() {
			fmt.Fprintf(out, "Port %d is public at %s\nNew links take about 10 seconds to resolve. Anyone with the link can reach it; stop it with: unshare %s\n", sh.Port, sh.URL, sh.ID)
		})
	case "shares":
		fs, asJSON := flags(rest)
		parse(fs, rest)
		all, err := c.Shares(ctx)
		if err != nil {
			return err
		}
		return show(out, *asJSON, all, func() {
			if len(all) == 0 {
				fmt.Fprintln(out, "Nothing is shared publicly.")
				return
			}
			w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tPORT\tURL\tSINCE")
			for _, s := range all {
				fmt.Fprintf(w, "%s\t%d\t%s\t%s\n", s.ID, s.Port, s.URL, s.Started.Local().Format("15:04"))
			}
			w.Flush()
		})
	case "units":
		fs, asJSON := flags(rest)
		parse(fs, rest)
		all, err := c.Units(ctx)
		if err != nil {
			return err
		}
		return show(out, *asJSON, all, func() {
			if len(all) == 0 {
				fmt.Fprintln(out, "No managed units.")
				return
			}
			w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "NAME\tSTATE\tLOG")
			for _, u := range all {
				fmt.Fprintf(w, "%s\t%s\t%s\n", u.Name, u.State, u.LogPath)
			}
			w.Flush()
		})
	case "unit add":
		if len(rest) < 2 {
			return usageErr("unit add NAME -- COMMAND...")
		}
		name, command := rest[0], rest[1:]
		if command[0] == "--" {
			command = command[1:]
		}
		if len(command) == 0 {
			return usageErr("unit add NAME -- COMMAND...")
		}
		u, err := c.AddUnit(ctx, box.UnitRequest{Name: name, Program: command[0], Args: command[1:]})
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Unit %s is %s; its output goes to %s\n", u.Name, u.State, u.LogPath)
		return nil
	case "unit get":
		fs, asJSON := flags(rest)
		pos, err := parse(fs, rest)
		if err != nil || len(pos) != 1 {
			return usageErr("unit get NAME")
		}
		u, err := c.Unit(ctx, pos[0])
		if err != nil {
			return err
		}
		return show(out, *asJSON, u, func() {
			fmt.Fprintf(out, "%s is %s; its output goes to %s\n", u.Name, u.State, u.LogPath)
		})
	case "unit log":
		if len(rest) != 1 {
			return usageErr("unit log NAME")
		}
		// The whole reason a unit writes to a file berthd owns is so this
		// can read it: a unit that will not stay up explains itself here.
		log, err := c.UnitLog(ctx, rest[0], 1<<20)
		if err != nil {
			return err
		}
		if len(log) == 0 {
			fmt.Fprintf(out, "Unit %s has written nothing yet.\n", rest[0])
			return nil
		}
		out.Write(log)
		if log[len(log)-1] != '\n' {
			fmt.Fprintln(out)
		}
		return nil
	case "unit restart":
		if len(rest) != 1 {
			return usageErr("unit restart NAME")
		}
		u, err := c.RestartUnit(ctx, rest[0])
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Unit %s is %s; its output goes to %s\n", u.Name, u.State, u.LogPath)
		return nil
	case "unit rm":
		if len(rest) != 1 {
			return usageErr("unit rm NAME")
		}
		u, err := c.RemoveUnit(ctx, rest[0])
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Stopped and removed unit %s; its log is still at %s\n", u.Name, u.LogPath)
		return nil
	case "unshare":
		if len(rest) != 1 {
			return usageErr("unshare ID")
		}
		sh, err := c.RemoveShare(ctx, rest[0])
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Stopped sharing port %d; %s no longer works.\n", sh.Port, sh.URL)
		return nil
	case "emit":
		return emit(ctx, c, rest, out)
	case "events":
		fs, asJSON := flags(rest)
		parse(fs, rest)
		enc := json.NewEncoder(out)
		return c.Events(ctx, func(e events.Event) {
			if *asJSON {
				enc.Encode(e)
				return
			}
			fmt.Fprintln(out, Describe(e))
		})
	}
	return fmt.Errorf("unknown command %q", cmd)
}

// Describe renders an event as one human-readable line.
func Describe(e events.Event) string {
	line := e.Time.Local().Format("15:04:05") + "  " + e.Type
	if e.Box != "" {
		line += "  " + e.Box
	}
	for _, k := range []string{"location", "name", "path", "port", "url", "command", "variable", "ref"} {
		if v, ok := e.Data[k]; ok && fmt.Sprint(v) != "" {
			line += fmt.Sprintf("  %s=%v", k, v)
		}
	}
	if e.Origin != "" && e.Origin != "berth" {
		line += "  via " + e.Origin
	}
	if e.Error != "" {
		line += "  (" + e.Error + ")"
	}
	return line
}

func flags(args []string) (*flag.FlagSet, *bool) {
	fs := flag.NewFlagSet("", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs, fs.Bool("json", false, "print JSON")
}

func usageErr(s string) error { return errors.New("usage: " + s) }

// parse accepts flags before, between, and after positional arguments, so
// the box reference can come first as in "worktree new devl/shop/x --base main".
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		rest := fs.Args()
		if len(rest) == 0 {
			return positional, nil
		}
		positional = append(positional, rest[0])
		args = rest[1:]
	}
}

func show(out io.Writer, asJSON bool, v any, human func()) error {
	if asJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(v)
	}
	human()
	return nil
}

func locations(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	parse(fs, args)
	all, err := c.Locations(ctx)
	if err != nil {
		return err
	}
	return show(out, *asJSON, all, func() {
		if len(all) == 0 {
			fmt.Fprintln(out, "No locations. Add one with: location add NAME PATH")
			return
		}
		for _, l := range all {
			fmt.Fprintf(out, "%s  %s\n", l.Name, l.Path)
			for _, w := range l.Worktrees {
				if w.Main {
					continue
				}
				branch := w.Branch
				if branch == "" {
					branch = "detached " + w.Head
				}
				if w.Title != "" {
					fmt.Fprintf(out, "  %s/%s  %q  %s  (%s)\n", l.Name, w.Name, w.Title, w.Path, branch)
					continue
				}
				fmt.Fprintf(out, "  %s/%s  %s  (%s)\n", l.Name, w.Name, w.Path, branch)
			}
		}
	})
}

func worktreeNew(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	var req box.WorktreeRequest
	fs.StringVar(&req.Branch, "branch", "", "branch to create (default: the worktree name)")
	fs.StringVar(&req.Base, "base", "", "ref to branch from")
	fs.IntVar(&req.PR, "pr", 0, "pull request to check out: origin's --branch if it has one, else REF")
	fs.StringVar(&req.Ref, "ref", "", "ref holding the pull request's head (default: pull/N/head)")
	fs.StringVar(&req.Parent, "parent", "", "another worktree of the location to nest this one under")
	pos, err := parse(fs, args)
	if err != nil || len(pos) != 1 || req.PR < 0 || (req.Ref != "" && req.PR == 0) {
		return usageErr("worktree new LOC/NAME [--branch B] [--base REF] [--pr N [--ref REF]] [--parent NAME]")
	}
	loc, name, ok := strings.Cut(pos[0], "/")
	if !ok || name == "" {
		return usageErr("worktree new LOC/NAME")
	}
	req.Name = name
	wt, err := c.AddWorktree(ctx, loc, req)
	if err != nil {
		return err
	}
	return show(out, *asJSON, wt, func() {
		fmt.Fprintf(out, "Created %s/%s at %s on %s\n", loc, wt.Name, wt.Path, wt.Branch)
	})
}

func sessions(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	parse(fs, args)
	all, err := c.Sessions(ctx)
	if err != nil {
		return err
	}
	return show(out, *asJSON, all, func() {
		if len(all) == 0 {
			fmt.Fprintln(out, "No sessions. Start one with: session new LOC[/WORKTREE] -- COMMAND")
			return
		}
		w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tTITLE\tLOCATION\tCOMMAND\tSTATE\tSTARTED")
		for _, s := range all {
			state := "running"
			if s.Exited {
				state = "exited"
			} else if s.AgentState != "" {
				state = s.Agent + " " + s.AgentState
			}
			if s.Attached > 0 {
				state += ", attached"
			}
			cmd := s.Command
			if cmd == "" {
				cmd = "(shell)"
			}
			title := s.Title
			if title == "" {
				title = "-"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", s.Name, title, s.Location, cmd, state, s.Created.Local().Format("Jan 2 15:04"))
		}
		w.Flush()
	})
}

func sessionNew(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	var command []string
	for i, a := range args {
		if a == "--" {
			command = args[i+1:]
			args = args[:i]
			break
		}
	}
	fs, asJSON := flags(args)
	var req box.SessionRequest
	fs.StringVar(&req.Name, "name", "", "session name (default: location, command, and a suffix)")
	fs.StringVar(&req.Agent, "agent", "", "start this agent (see: agents) instead of a command")
	fs.StringVar(&req.Prompt, "prompt", "", "the agent's first prompt")
	fs.StringVar(&req.Open, "open", "", "show it in the Shipyard app: split (beside the current terminal) or tab")
	fs.StringVar(&req.Title, "title", "", "name the work (default: the prompt's first line)")
	pos, err := parse(fs, args)
	if err != nil || len(pos) != 1 {
		return usageErr("session new LOC[/WORKTREE] [--name N] [--agent ID [--prompt TEXT]] [--title T] [--open split|tab] [-- COMMAND...]")
	}
	req.Location, req.Command = pos[0], commandLine(command)
	sess, err := c.StartSession(ctx, req)
	if err != nil {
		return err
	}
	return show(out, *asJSON, sess, func() {
		fmt.Fprintf(out, "Started session %s in %s\n", sess.Name, sess.Dir)
	})
}

// commandLine turns the words after -- back into one shell command. A
// single word is taken as a command line already, so `-- "a && b"` works;
// several are quoted one by one, so `-- claude "fix it, don't stop"` gives
// claude one argument, apostrophe and all.
func commandLine(words []string) string {
	if len(words) == 1 {
		return words[0]
	}
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = shellWord(w)
	}
	return strings.Join(quoted, " ")
}

func shellWord(w string) string {
	if w != "" && strings.Trim(w, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./:=@%+,") == "" {
		return w
	}
	return "'" + strings.ReplaceAll(w, "'", `'\''`) + "'"
}

// waitFor waits in steps, since one long request could outlive a proxy or a
// network change between the laptop and the box.
// waitSent waits for the turn a send started: by its ID when the box keeps
// turns, else from the box's own time of the send (never this machine's
// clock, which may differ).
func waitSent(ctx context.Context, c *box.Client, session string, res box.SendResult, states []string, timeout time.Duration) (box.WaitResult, error) {
	if res.Turn != "" {
		untilWaiting := false
		for _, s := range states {
			untilWaiting = untilWaiting || s == "waiting"
		}
		return waitTurn(ctx, c, res.Turn, untilWaiting, timeout)
	}
	after := res.At
	if after.IsZero() {
		after = time.Now()
	}
	return waitFor(ctx, c, session, states, after, timeout)
}

// waitTurn long-polls a turn in steps of at most five minutes.
func waitTurn(ctx context.Context, c *box.Client, id string, untilWaiting bool, timeout time.Duration) (box.WaitResult, error) {
	deadline := time.Now().Add(timeout)
	for {
		step := min(time.Until(deadline), 5*time.Minute)
		w, err := c.WaitTurn(ctx, id, untilWaiting, max(step, time.Second))
		if err != nil {
			return box.WaitResult{}, err
		}
		if !w.TimedOut || time.Now().After(deadline) {
			return box.WaitResult{State: w.State, TimedOut: w.TimedOut, Turn: w.Turn.ID}, nil
		}
	}
}

func printWait(out io.Writer, w box.WaitResult, timeout time.Duration) {
	if w.TimedOut {
		fmt.Fprintf(out, "Still %s after %v\n", w.State, timeout)
		return
	}
	fmt.Fprintln(out, w.State)
}

func waitFor(ctx context.Context, c *box.Client, session string, states []string, after time.Time, timeout time.Duration) (box.WaitResult, error) {
	deadline := time.Now().Add(timeout)
	for {
		step := min(time.Until(deadline), 5*time.Minute)
		res, err := c.Wait(ctx, session, states, after, max(step, time.Second))
		if err != nil || !res.TimedOut || time.Now().After(deadline) {
			return res, err
		}
	}
}

func execCmd(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	var command []string
	for i, a := range args {
		if a == "--" {
			command, args = args[i+1:], args[:i]
			break
		}
	}
	fs, asJSON := flags(args)
	timeout := fs.String("timeout", "10m", "stop the command after this long")
	detach := fs.Bool("detach", false, "run it as a run on the box and return its ID")
	noNotify := fs.Bool("no-notify", false, "with --detach, don't tell this agent (BERTH_SESSION) when it ends")
	pos, err := parse(fs, args)
	if err != nil || len(pos) != 1 || len(command) == 0 {
		return usageErr("exec LOC[/WORKTREE] [--timeout 10m] [--detach [--no-notify]] -- COMMAND...")
	}
	if *detach {
		var started struct {
			Run string `json:"run"`
		}
		if err := reportBack(c, *noNotify).Call(ctx, "POST", "/v1/exec", box.ExecRequest{Location: pos[0], Command: commandLine(command), Timeout: *timeout, Detach: true}, &started); err != nil {
			return err
		}
		return show(out, *asJSON, started, func() { fmt.Fprintf(out, "Running as %s; see: run get %s\n", started.Run, started.Run) })
	}
	res, err := c.Exec(ctx, box.ExecRequest{Location: pos[0], Command: commandLine(command), Timeout: *timeout})
	if err != nil {
		return err
	}
	if *asJSON {
		return show(out, true, res, nil)
	}
	fmt.Fprint(out, res.Output)
	if res.ExitCode != 0 {
		return fmt.Errorf("exited with %d", res.ExitCode)
	}
	return nil
}

// loop prompts an agent, waits for its turn to end, runs a check, and feeds
// failures back until the check passes or the rounds run out.
func loop(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, _ := flags(args)
	prompt := fs.String("prompt", "", "the first prompt")
	check := fs.String("check", "", "command that passes when the work is done, e.g. pnpm test")
	rounds := fs.Int("max", 5, "most rounds to try")
	timeout := fs.Duration("turn-timeout", 30*time.Minute, "longest an agent's turn may take")
	cancelOnExit := fs.Bool("cancel-on-exit", false, "cancel the run when you stop following it")
	detach := fs.Bool("detach", false, "start it and return")
	pos, err := parse(fs, args)
	usage := "loop SESSION --check COMMAND [--prompt TEXT] [--max 5] [--turn-timeout 30m] [--cancel-on-exit] [--detach]"
	if err != nil || len(pos) != 1 || *check == "" {
		return usageErr(usage)
	}
	session := pos[0]
	if hasRuns(ctx, c) {
		// One loop, on the box: it survives the laptop sleeping and berthd
		// restarting. Below is the old client loop, for older boxes.
		return loopRun(ctx, c, session, *prompt, *check, *rounds, *timeout, *cancelOnExit, *detach, out)
	}
	all, err := c.Sessions(ctx)
	if err != nil {
		return err
	}
	where := ""
	for _, s := range all {
		if s.Name == session {
			where = s.Location
		}
	}
	if where == "" {
		return fmt.Errorf("no session named %s", session)
	}
	text := *prompt
	run := strconv.FormatInt(time.Now().UnixNano(), 36)
	for round := 1; round <= *rounds; round++ {
		if text != "" {
			// The turn ID ties the wait to this prompt, so a turn the agent
			// was already in cannot end it; refused if the agent waits for
			// someone.
			res, err := c.Send(ctx, session, box.SendRequest{Text: text, When: "now", IdemKey: "loop-" + run + "-" + strconv.Itoa(round)})
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "Round %d: prompted %s, waiting for its turn to end…\n", round, session)
			w, err := waitSent(ctx, c, session, res, []string{"finished", "waiting"}, *timeout)
			if err != nil {
				return err
			}
			switch {
			case w.TimedOut:
				return fmt.Errorf("%s was still %s after %v", session, w.State, *timeout)
			case w.State == "waiting":
				return fmt.Errorf("%s is waiting for you; answer it, then run the loop again", session)
			case w.State == "exited" || w.State == "lost":
				return fmt.Errorf("%s has %s", session, w.State)
			}
		}
		fmt.Fprintf(out, "Round %d: checking with %q…\n", round, *check)
		res, err := c.Exec(ctx, box.ExecRequest{Location: where, Command: *check, Timeout: "30m"})
		if err != nil {
			return err
		}
		if res.ExitCode == 0 {
			fmt.Fprintf(out, "Passed after %d round(s).\n", round)
			return nil
		}
		// Only what failed goes back: every byte is the agent's to read.
		text = fmt.Sprintf("`%s` failed (exit %d):\n```\n%s\n```\nFix it.", *check, res.ExitCode, box.CheckFeedback(res.Output, 3000))
	}
	return fmt.Errorf("the check still fails after %d rounds", *rounds)
}

func taskNew(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	var req box.TaskRequest
	for i, a := range args {
		if a == "--" {
			req.Command = commandLine(args[i+1:])
			args = args[:i]
			break
		}
	}
	fs, asJSON := flags(args)
	fs.StringVar(&req.Agent, "agent", "", "agent to start (see: agents)")
	fs.StringVar(&req.Prompt, "prompt", "", "the agent's first prompt")
	fs.StringVar(&req.Open, "open", "", "show it in the Shipyard app: split or tab")
	fs.StringVar(&req.Branch, "branch", "", "branch to create (default: the worktree name)")
	fs.StringVar(&req.Base, "base", "", "ref to branch from")
	fs.StringVar(&req.Title, "title", "", "name the work (default: the prompt's first line)")
	noNotify := fs.Bool("no-notify", false, "don't tell this agent (BERTH_SESSION) when the new agent's first turn ends")
	pos, err := parse(fs, args)
	usage := "task new LOC/NAME [--agent ID] [--prompt TEXT] [--title T] [--open split|tab] [--branch B] [--base REF] [--no-notify] [-- COMMAND...]"
	if err != nil || len(pos) != 1 {
		return usageErr(usage)
	}
	loc, name, ok := strings.Cut(pos[0], "/")
	if !ok || name == "" {
		return usageErr(usage)
	}
	req.Location, req.Name = loc, name
	// From an agent's session, the new worktree nests under that agent's.
	req.FromSession = os.Getenv("BERTH_SESSION")
	task, err := reportBack(c, *noNotify).AddTask(ctx, req)
	if err != nil {
		return err
	}
	return show(out, *asJSON, task, func() {
		fmt.Fprintf(out, "Created %s/%s at %s on %s\n", loc, task.Worktree.Name, task.Worktree.Path, task.Worktree.Branch)
		fmt.Fprintf(out, "Started session %s\n", task.Session.Name)
	})
}

func ports(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs, asJSON := flags(args)
	parse(fs, args)
	all, err := c.Ports(ctx)
	if err != nil {
		return err
	}
	return show(out, *asJSON, all, func() {
		w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "PORT\tADDRESS\tPROCESS\tCOMMAND")
		for _, p := range all {
			cmd := p.Command
			if len(cmd) > 60 {
				cmd = cmd[:60] + "…"
			}
			fmt.Fprintf(w, "%d\t%s\t%s\t%s\n", p.Port, p.Address, p.Process, cmd)
		}
		w.Flush()
	})
}

func emit(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	origin := fs.String("origin", "", "tool the event comes from")
	positional, err := parse(fs, args)
	if err != nil || len(positional) == 0 {
		return usageErr("emit TYPE [key=value...] [--origin TOOL]")
	}
	data := map[string]any{}
	for _, kv := range positional[1:] {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			return fmt.Errorf("expected key=value, got %q", kv)
		}
		data[k] = v
	}
	if *origin != "" {
		c.Origin = *origin
	}
	if err := c.Emit(ctx, positional[0], data); err != nil {
		return err
	}
	fmt.Fprintf(out, "Emitted %s at %s\n", positional[0], time.Now().Format("15:04:05"))
	return nil
}

func gib(b uint64) string { return fmt.Sprintf("%.1f GiB", float64(b)/(1<<30)) }
