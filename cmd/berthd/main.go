// Command berthd runs on a box: it holds the box identity, issues pairing
// links, and serves paired laptops.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/boxcmd"
	"github.com/cosscom/shipyard/internal/debugserver"
	"github.com/cosscom/shipyard/internal/doctor"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/identity"
	"github.com/cosscom/shipyard/internal/integrations"
	"github.com/cosscom/shipyard/internal/mcpserver"
	"github.com/cosscom/shipyard/internal/pairing"
	"github.com/cosscom/shipyard/internal/service"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/trust"
	"github.com/cosscom/shipyard/internal/version"
	"github.com/cosscom/shipyard/internal/wire"
)

const (
	defaultPort = "7444"
	defaultTTL  = 10 * time.Minute
)

const usage = `berthd — the berth daemon for a development box

  berthd serve [--listen ADDR]            Serve paired laptops (default: tailnet address only)
  berthd install [--listen ADDR] [--keep-listen] [--no-integrations] [--no-tools] [--dry-run]
                                          Run serve as a user service (systemd/launchd), and install
                                          hooks and skills for the agent CLIs found here; --keep-listen
                                          keeps an installed non-tailnet address, --dry-run only checks.
                                          Installs tmux and git first if they are missing and that needs
                                          no password, else says the command to run (--no-tools skips it)
  berthd uninstall                        Remove that service
  berthd pair [--address HOST[:PORT]] [--ttl 10m] [--json]
                                          Print a single-use pairing link
  berthd clients                          List paired laptops
  berthd revoke <name|fingerprint>        Stop trusting a laptop
  berthd id                               Print this box's fingerprint
  berthd doctor [--json]                  Check this box's setup and how to fix it
  berthd version                          Print this build's version
  berthd session attach NAME              Attach to a session in this terminal
  berthd secret exec [--socket PATH] -- PROGRAM [ARGS...]
                                          Resolve secret references, then run PROGRAM (sessions and
                                          services use it)
  berthd secret signin [--check]          Sign op in to 1Password here, for berthd's op:// reads
                                          (--check: only say whether it can read now)
  berthd mcp                              A stdio MCP server of berth's tools for agents on this box
                                          (integrations install adds it to Claude, Codex and Gemini)
  berthd agents install [--integrations] [--markers] claude|codex|cursor|opencode ...
                                          Install agent CLIs into ~/.local/bin, without sudo (each is
                                          skipped when it is already here)
  berthd agents list [--json]             Which agent CLIs are here, and how to add the others
  berthd browser install                  Download a Chromium (Playwright's headless shell) for agents' browsers
  berthd headless --agent A --out FILE.jsonl --prompt-file FILE [--read-only] [--add-dir D]
                                          One non-interactive agent turn, as runs start in tmux

Runs use ~/.berth/runs.json: {"max_concurrent_runs": 10, "max_concurrent_agents": 6,
"triggers_listen": "tailnet"} (the last serves signed webhook triggers on port 7482).
Hooks run from ~/.berth/hooks.json and ~/.berth/plugins; see https://docs.berthd.app/guides/hooks
BERTH_HOME overrides the state directory.
`

// helpText is what berthd help prints: the daemon's commands, then the box
// commands, then the integrations.
func helpText() string {
	return usage + "\n" + boxcmd.Usage("berthd", "") + "\n" + fmt.Sprintf(integrations.Usage, "berthd")
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		// A command that already said why ends with its own status.
		var code exitCode
		if errors.As(err, &code) {
			os.Exit(int(code))
		}
		fmt.Fprintln(os.Stderr, "berthd:", err)
		os.Exit(1)
	}
}

type boxHome struct {
	dir string
}

func (b boxHome) socket() string { return filepath.Join(b.dir, "berthd.sock") }

// spool holds agent hooks that ran while berthd was down.
func (b boxHome) spool() string { return filepath.Join(b.dir, "spool") }

func (b boxHome) identity() (*identity.Identity, error) {
	return identity.LoadOrCreate(filepath.Join(b.dir, "identity.pem"))
}
func (b boxHome) clients() *trust.Store { return trust.NewStore(filepath.Join(b.dir, "clients.json")) }
func (b boxHome) pending() *pairing.Pending {
	return pairing.NewPending(filepath.Join(b.dir, "pairing.json"))
}

func run(args []string) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		fmt.Print(helpText())
		return nil
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Println(version.Line("berthd"))
		return nil
	}
	home, err := statefile.Home()
	if err != nil {
		return err
	}
	b := boxHome{dir: filepath.Join(home, "box")}
	// Agent accounts the box's env.json and projects' local configs pick
	// get berth's hooks and skills too (integrations/accounts.go).
	if userDir, err := statefile.UserDir(); err == nil {
		integrations.ConfiguredAccounts = func() map[string][]string {
			return box.ConfiguredAccountDirs(filepath.Join(userDir, "env.json"), filepath.Join(b.dir, "locations.json"))
		}
	}
	switch args[0] {
	case "serve":
		return serve(b, args[1:])
	case "pair":
		return pair(b, args[1:])
	case "install":
		return install(b, args[1:])
	case "uninstall":
		path, err := service.Uninstall(daemonService(b, ""))
		if err != nil {
			return err
		}
		if path == "" {
			fmt.Println("berthd is not installed as a service.")
		} else {
			fmt.Println("Removed " + path)
		}
		return nil
	case "clients":
		return listClients(b)
	case "revoke":
		if len(args) != 2 {
			return errors.New("usage: berthd revoke <name|fingerprint>")
		}
		p, err := b.clients().Remove(args[1])
		if err != nil {
			return err
		}
		// A running daemon closes the shells and streams this laptop still
		// has open: at once when told, otherwise within a second or two.
		if _, err := os.Stat(b.socket()); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			box.NewClient(box.NewLocal(b.socket())).Call(ctx, http.MethodPost, "/v1/clients/changed", nil, nil)
			cancel()
		}
		fmt.Printf("Revoked %s (%s); its open connections close within a few seconds.\n", p.Name, p.Fingerprint.Short())
		return nil
	case "id":
		id, err := b.identity()
		if err != nil {
			return err
		}
		fmt.Println(id.Fingerprint())
		return nil
	}
	switch args[0] {
	case "doctor":
		return runDoctor(b, args[1:])
	case "hook":
		integrations.Hook(args[1:], os.Stdin, os.Stdout, os.Stderr, func(e events.Event) error {
			// While berthd is down (an upgrade, a restart), the hook is kept
			// in the spool and published when it is back.
			if _, err := os.Stat(b.socket()); err != nil {
				return integrations.Spool(b.spool(), e)
			}
			c := box.NewClient(box.NewLocal(b.socket()))
			c.Origin = e.Origin
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := c.Emit(ctx, e.Type, e.Data)
			if err != nil && integrations.Unreachable(err) {
				return integrations.Spool(b.spool(), e)
			}
			return err
		})
		return nil
	case "headless":
		return box.RunHeadless(args[1:], os.Stdout)
	case "mcp":
		return mcpserver.Serve(context.Background(), b.socket(), os.Stdin, os.Stdout)
	case "agents":
		return agents(args[1:], os.Stdout)
	case "integrations":
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		return integrations.Install(args[1:], exe, os.Stdout)
	}
	if len(args) >= 2 && args[0] == "browser" && args[1] == "install" {
		return box.InstallChromium(os.Stdout)
	}
	if len(args) >= 2 && args[0] == "session" && args[1] == "attach" {
		return attachLocal(args[2:])
	}
	if len(args) >= 2 && args[0] == "secret" && args[1] == "exec" {
		return secretExec(b, args[2:])
	}
	if len(args) >= 2 && args[0] == "secret" && args[1] == "signin" {
		return secretSignin(b, args[2:])
	}
	if _, ok := boxcmd.Commands[args[0]]; ok {
		return runLocal(b, args)
	}
	return fmt.Errorf("unknown command %q; run berthd help", args[0])
}

// utf8Locale gives berthd, and so its tmux server and every session, a
// UTF-8 locale when it was started with none, as launchd always starts it
// and systemd can: a terminal gives one, and agents' screens and shells
// need it. A locale someone set is left alone.
func utf8Locale() {
	for _, k := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		if os.Getenv(k) != "" {
			return
		}
	}
	if runtime.GOOS == "darwin" {
		os.Setenv("LANG", "en_US.UTF-8")
	} else {
		os.Setenv("LANG", "C.UTF-8")
	}
}

func serve(b boxHome, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	listen := fs.String("listen", "", "address to listen on (default: this box's tailnet address only)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		// A plist from an older install gives launchd's bare PATH, without
		// Homebrew's tmux; find it anyway.
		service.AugmentPATH()
	}
	utf8Locale()
	if *listen == "" {
		addr, err := defaultListen(interfaceIPs())
		if err != nil {
			return err
		}
		*listen = addr
	}
	id, err := b.identity()
	if err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	hostname = trust.NameFromHostname(hostname, "box")
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// pair reads this to advertise the address that actually answers.
	if err := statefile.Write(filepath.Join(b.dir, "listen"), []byte(ln.Addr().String())); err != nil {
		ln.Close()
		return err
	}
	logger := log.New(os.Stderr, "", log.LstdFlags)
	s := &wire.Server{
		Identity: id,
		Clients:  b.clients(),
		Pending:  b.pending(),
		Name:     hostname,
		Log:      logger,
	}
	sessions, err := box.NewSessions(b.dir)
	if err != nil {
		ln.Close()
		return err
	}
	journal, err := events.OpenJournal(filepath.Join(b.dir, "journal"))
	if err != nil {
		ln.Close()
		return fmt.Errorf("event journal: %w", err)
	}
	defer journal.Close()
	bus := &events.Bus{Journal: journal}
	// A new laptop, by the name it gave and its key; laptops' lists of who
	// the box trusts follow it.
	s.OnPaired = func(p trust.Peer) {
		bus.Publish(events.Event{Type: "client.paired", Box: hostname, Data: map[string]any{"name": p.Name, "fingerprint": p.Fingerprint.String()}})
	}
	shares := &box.Shares{OnStop: func(sh box.Share) {
		bus.Publish(events.Event{Type: "share.stopped", Box: hostname, Error: sh.Error, Data: map[string]any{"id": sh.ID, "port": sh.Port, "url": sh.URL}})
	}}
	// Nothing may stay public once the daemon managing it is gone.
	defer shares.StopAll()
	locations := box.NewLocations(filepath.Join(b.dir, "locations.json"))
	watcher := &box.Watcher{Locations: locations, Events: bus, Box: hostname}
	go watcher.Run(ctx)
	turns := &box.Turns{
		Path:        filepath.Join(b.dir, "turns.json"),
		LegacyPath:  filepath.Join(b.dir, "agent-states.json"),
		InboxPath:   filepath.Join(b.dir, "inbox.json"),
		ArchivePath: filepath.Join(b.dir, "turns-archive.jsonl"),
	}
	turns.Attach(bus)
	exe, err := os.Executable()
	if err != nil {
		ln.Close()
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	userDir, err := statefile.UserDir()
	if err != nil {
		ln.Close()
		return err
	}
	hookRunner := &hooks.Runner{Path: filepath.Join(userDir, "hooks.json"), PluginsDir: filepath.Join(userDir, "plugins"), Log: logger}
	bx := &box.Box{
		Name:         hostname,
		Locations:    locations,
		Sessions:     sessions,
		Shares:       shares,
		Events:       bus,
		Watcher:      watcher,
		DaemonChecks: func() []doctor.Check { return daemonChecks(b, ln.Addr().String(), *listen) },
		LogDir:       filepath.Join(b.dir, "logs"),
		Units:        &box.Units{Dir: filepath.Join(b.dir, "units")},
		Turns:        turns,
		Hooks:        hookRunner,
		Flows:        box.FlowsAt(userDir, b.dir),
		KitsDir:      filepath.Join(b.dir, "kits"),
		EnvFile:      filepath.Join(userDir, "env.json"),
		Paused:       &box.PauseStore{Path: filepath.Join(b.dir, "paused.json")},
		Secrets:      b.boxSecrets(),
		Socket:       b.socket(),
		Phone:        &box.Phone{Path: filepath.Join(b.dir, "phone.json"), Addr: tailnetAddr, Log: logger},
		Guard:        &box.Guard{Path: filepath.Join(userDir, "guard.json")},
		TurnCheck:    &box.TurnCheck{Path: filepath.Join(userDir, "turncheck.json"), KeyPath: filepath.Join(b.dir, "turncheck.key"), Log: logger},
		Invites:      &box.Invites{Address: func() string { return pairAddress(b) }, TTL: defaultTTL},
		Update: &box.SelfUpdate{
			Executable:    exe,
			Fingerprint:   id.Fingerprint().String(),
			BeforeRestart: func() { shares.StopAll(); ln.Close() },
		},
	}
	bx.AutoFix = &box.AutoFixStore{Path: filepath.Join(b.dir, "autofix.json")}
	bx.Triggers = &box.TriggerSecrets{Path: filepath.Join(b.dir, "trigger-secrets.json")}
	rc := box.LoadRunsConfig(filepath.Join(userDir, "runs.json"))
	bx.NewRuns(filepath.Join(b.dir, "runs"), rc.MaxConcurrentRuns, rc.MaxConcurrentAgents, logger.Printf)
	bx.BrowserProxies = &box.BrowserProxies{Path: filepath.Join(b.dir, "browser-proxies.json")}
	defer bx.BrowserProxies.CloseAll()
	bx.NewBrowsers(filepath.Join(b.dir, "browser"), rc.MaxBrowsers)
	bx.ShotsDir = filepath.Join(b.dir, "shots")
	// agent-browser sessions (Vercel's CLI) go with the berth session that
	// started them.
	bx.AgentBrowsers = box.NewAgentBrowsers(bx.Sessions)
	// Each new session runs in a systemd scope of its own where the box
	// has a user manager, so ending it stops all it started.
	bx.Sessions.Scopes = box.NewSystemdScopes()
	bx.Sessions.MemoryHigh = bx.Guard.SessionMemoryHigh
	// A session on an agent account without berth's hooks and skills gets
	// them before its agent starts.
	bx.Sessions.Prepare = bx.PrepareAccounts
	bx.Artifacts = &box.ArtifactStore{Dir: filepath.Join(b.dir, "artifacts"), Events: bus, Box: hostname}
	go bx.Artifacts.Run(ctx)
	go bx.RunShots(ctx)
	bx.Team = &box.TeamRunner{Dir: filepath.Join(b.dir, "team")}
	defer bx.Team.Stop()
	// Pull requests opened for review: their settings, and their clean-up
	// once merged, closed or idle.
	bx.Reviews = &box.ReviewStore{Path: filepath.Join(b.dir, "reviews.json")}
	go bx.RunReviewSweeps(ctx)
	// The "Review in Shipyard" button on PRs opened from worktrees of
	// projects that turn it on.
	bx.ReviewButtons = &box.ReviewButtons{Path: filepath.Join(b.dir, "review-buttons.json")}
	go bx.RunReviewButtons(ctx)
	bx.Mount(s)
	bx.ResumeTeams()
	// Hooks that ran while berthd was down, in order, before anything new.
	if n := integrations.DrainSpool(b.spool(), func(e events.Event) { bus.Publish(e) }); n > 0 {
		logger.Printf("published %d agent hooks spooled while berthd was down", n)
	}
	if home, err := os.UserHomeDir(); err == nil {
		if done := integrations.RefreshHooked(home, exe); len(done) > 0 {
			logger.Printf("updated berth's hooks for %s", strings.Join(done, ", "))
		}
	}
	go turns.Run(ctx, bx)
	// Agents hear back about work they started, after the ledger has it.
	bx.Reports = &box.Notifier{Path: filepath.Join(b.dir, "notify.json")}
	go bx.Reports.Run(ctx, bx)
	go bx.RunRepoHooks(ctx, logger)
	// Runs that were going when berthd stopped carry on from their journals.
	bx.Runs.Resume(ctx)
	defer func() {
		done := make(chan struct{})
		go func() { bx.Runs.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	}()
	go bx.Flows.Run(ctx, bx)
	go bx.AgentBrowsers.Run(ctx, logger.Printf)
	browsersDone := make(chan struct{})
	go func() { bx.Browsers.Run(ctx); close(browsersDone) }()
	// Chromium goes with berthd.
	defer func() {
		select {
		case <-browsersDone:
		case <-time.After(10 * time.Second):
		}
	}()
	if addr := rc.TriggersListen; addr != "" {
		if addr == "tailnet" {
			if host, err := tailnetAddr(); err == nil {
				addr = net.JoinHostPort(host, "7482")
			}
		}
		if err := bx.TriggerListener(ctx, addr); err != nil {
			logger.Printf("webhook triggers: %v", err)
		} else {
			logger.Printf("webhook triggers on http://%s/v1/triggers/", addr)
		}
	}
	go bx.Phone.Run(ctx, bx)
	go bx.Guard.Run(ctx, bx)
	go bx.WatchSessionMemory(ctx)
	go bx.TurnCheck.Run(ctx, bx)

	os.Remove(b.socket())
	local, err := net.Listen("unix", b.socket())
	if err != nil {
		ln.Close()
		return err
	}
	defer os.Remove(b.socket())
	if err := os.Chmod(b.socket(), 0o600); err != nil {
		ln.Close()
		local.Close()
		return err
	}
	// Hooks that spooled while the socket was being made.
	integrations.DrainSpool(b.spool(), func(e events.Event) { bus.Publish(e) })
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				integrations.DrainSpool(b.spool(), func(e events.Event) { bus.Publish(e) })
			}
		}
	}()
	go s.ServeLocal(ctx, local)
	go hookRunner.Run(ctx, bus)
	// BERTH_DEBUG_ADDR: goroutines, open files and profiles, for measuring.
	debugserver.Start(ctx, logger.Printf)

	logger.Printf("berthd serving %s as %q (%s); local API %s", ln.Addr(), hostname, id.Fingerprint().Short(), b.socket())
	return s.Serve(ctx, ln)
}

// runLocal runs a box command against this box's own daemon.
func runLocal(b boxHome, args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if _, err := os.Stat(b.socket()); err != nil {
		return errors.New("berthd serve is not running on this box; start it with berthd install")
	}
	return boxcmd.Run(ctx, box.NewClient(box.NewLocal(b.socket())), args, os.Stdout)
}

// attachLocal replaces this process with a tmux client for the session, so
// attaching on the box itself needs no stream at all.
func attachLocal(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: berthd session attach NAME")
	}
	tmux, err := box.TmuxPath()
	if err != nil {
		return err
	}
	return syscall.Exec(tmux, []string{"tmux", "-u", "-L", "berth", "attach-session", "-t", "=" + args[0]}, os.Environ())
}

func pair(b boxHome, args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	address := fs.String("address", "", "address laptops should dial (default: best guess, port "+defaultPort+")")
	ttl := fs.Duration("ttl", defaultTTL, "how long the link stays valid")
	asJSON := fs.Bool("json", false, "print the link and where laptops will dial as JSON, for the laptop agent")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *ttl <= 0 || *ttl > time.Hour {
		return errors.New("--ttl must be between 0 and 1h")
	}
	target := *address
	if target == "" {
		target = pairAddress(b)
	}
	if _, _, err := net.SplitHostPort(target); err != nil {
		target = net.JoinHostPort(target, defaultPort)
	}
	id, err := b.identity()
	if err != nil {
		return err
	}
	code, err := b.pending().Issue(*ttl, time.Now())
	if err != nil {
		return err
	}
	link := pairing.Token{Address: target, Fingerprint: id.Fingerprint(), Code: code}.String()
	if *asJSON {
		// The laptop agent pairs this computer with its own berthd this way
		// (Use this Mac), with nothing to copy.
		return json.NewEncoder(os.Stdout).Encode(map[string]string{
			"link":        link,
			"address":     target,
			"fingerprint": id.Fingerprint().String(),
			"expires":     time.Now().Add(*ttl).UTC().Format(time.RFC3339),
		})
	}
	fmt.Printf("Pairing link (single use, valid for %s):\n\n  %s\n\n", ttl, link)
	fmt.Printf("On your laptop:  berth pair '%s'\n\n", link)
	fmt.Println("Laptops will dial " + target + "; pass --address if that is not reachable.")
	fmt.Println("berthd serve must be running on this box to accept the pairing.")
	return nil
}

// pairAddress is the address a pairing link tells laptops to dial: where
// serve listens, or its best guess.
func pairAddress(b boxHome) string {
	hostname, _ := os.Hostname()
	ips := interfaceIPs()
	listening, _ := os.ReadFile(filepath.Join(b.dir, "listen"))
	if len(listening) == 0 {
		// serve may not have recorded its address yet, right after an
		// install; it will listen where defaultListen says.
		if addr, err := defaultListen(ips); err == nil {
			listening = []byte(addr)
		}
	}
	return advertise(string(listening), ips, hostname)
}

func listClients(b boxHome) error {
	peers, err := b.clients().List()
	if err != nil {
		return err
	}
	if len(peers) == 0 {
		fmt.Println("No paired laptops. Run berthd pair to add one.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tFINGERPRINT\tPAIRED")
	for _, p := range peers {
		fmt.Fprintf(w, "%s\t%s\t%s\n", p.Name, p.Fingerprint.Short(), p.PairedAt.Local().Format("2006-01-02 15:04"))
	}
	return w.Flush()
}
