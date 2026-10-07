package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/agent"
	"github.com/cosscom/shipyard/internal/agentcli"
	"github.com/cosscom/shipyard/internal/guided"
	"github.com/cosscom/shipyard/internal/pairing"
	"github.com/cosscom/shipyard/internal/sshsetup"
	"github.com/cosscom/shipyard/internal/trust"
	"github.com/cosscom/shipyard/internal/wire"
)

// daemonFor maps `uname -sm` output to the berthd build for that box.
func daemonFor(uname string) (string, error) {
	f := strings.Fields(strings.ToLower(uname))
	if len(f) != 2 {
		return "", fmt.Errorf("could not read the box's platform from %q", uname)
	}
	arch := map[string]string{"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}[f[1]]
	if arch == "" || (f[0] != "linux" && f[0] != "darwin") {
		return "", fmt.Errorf("berthd does not support %s", uname)
	}
	return "berthd-" + f[0] + "-" + arch, nil
}

var linkPattern = regexp.MustCompile(`berth://\S+`)

// findLink pulls the pairing link out of `berthd pair` output.
func findLink(out []byte) (string, error) {
	link := linkPattern.Find(out)
	if link == nil {
		return "", errors.New("the box did not print a pairing link")
	}
	return strings.TrimRight(string(link), "'\""), nil
}

// addSSH installs berthd on a machine you can already SSH to and pairs
// with it. SSH is used for this one setup only; afterwards berth talks to
// the box directly and never needs your SSH agent again.
func addSSH(l laptop, args []string) error {
	err := addSSHSteps(l, args)
	var f *sshsetup.Failure
	if errors.As(err, &f) && os.Getenv(sshsetup.FailureEnv) == "1" {
		if data, jerr := json.Marshal(f); jerr == nil {
			fmt.Fprintln(os.Stderr, sshsetup.FailurePrefix+string(data))
		}
	}
	return err
}

const addSSHUsage = "usage: berth add ssh [user@]HOST [--name N] [--agents claude,codex|none] [--guided] [--yes] [--from STEP] [--network NET] [--listen ADDR] [--address ADDR] [--identity FILE] [--trust-host-key SHA256:…] [--no-integrations] [-- SSH OPTIONS]"

func addSSHSteps(l laptop, args []string) error {
	var sshArgs []string
	for i, a := range args {
		if a == "--" {
			sshArgs = args[i+1:]
			args = args[:i]
			break
		}
	}
	fs := flag.NewFlagSet("add ssh", flag.ContinueOnError)
	name := fs.String("name", "", "local name for the box")
	listen := fs.String("listen", "", "where berthd listens (default: the box's tailnet address only)")
	address := fs.String("address", "", "address this laptop dials, when it differs from --listen")
	via := fs.String("network", "", "reach the box through this network, for SSH and afterwards")
	identity := fs.String("identity", "", "an SSH private key file to log in with (as ssh -i)")
	trustKey := fs.String("trust-host-key", "", "trust the box's host key if its fingerprint is this SHA256:… (a new box only; a changed key is never trusted)")
	noIntegrations := fs.Bool("no-integrations", false, "don't install hooks and skills for the agent CLIs on the box")
	agentList := fs.String("agents", strings.Join(agentcli.Defaults(), ","), "agent CLIs to install on the box: claude, codex, cursor, opencode, grok, or none")
	yes := fs.Bool("yes", false, "ask nothing: don't wait for Enter, and stop with the command to run where sudo would ask for a password")
	guidedFlag := fs.Bool("guided", false, "show the whole plan first, wait for Enter, and run every step in one terminal; without it, steps run on their own and only one that needs sudo's password asks")
	from := fs.String("from", "", "start from this step (connect, berthd, linger, tools, agents, integrations, pair); the ones before it are kept")
	pos, err := parseAnywhere(fs, args)
	if err != nil || len(pos) != 1 {
		return errors.New(addSSHUsage)
	}
	target := pos[0]
	if err := checkName(*name); err != nil {
		return err
	}
	if err := checkNetwork(*via); err != nil {
		return err
	}
	chosen, err := agentcli.ParseList(*agentList)
	if err != nil {
		return err
	}
	fromIdx := 0
	if *from != "" {
		if fromIdx = guided.Index(*from); fromIdx < 0 {
			return fmt.Errorf("--from %s is not a step; the steps are %s", *from, strings.Join(guided.Order, ", "))
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if *via != "" {
		// SSH to the box through the same network berth will use. ssh runs
		// ProxyCommand with a shell, so every word is quoted.
		sshArgs = append([]string{"-o", proxyCommand(exe, *via)}, sshArgs...)
	}
	if *identity != "" {
		path, err := expandHome(*identity)
		if err != nil {
			return err
		}
		if st, err := os.Stat(path); err != nil || !st.Mode().IsRegular() {
			return fmt.Errorf("no key file at %s", *identity)
		}
		sshArgs = append([]string{"-i", path}, sshArgs...)
	}
	// ConnectTimeout bounds reaching the box, not logging in: a key
	// manager's approval prompt can take as long as the person needs.
	if !hasOption(sshArgs, "ConnectTimeout") {
		sshArgs = append([]string{"-o", "ConnectTimeout=20"}, sshArgs...)
	}

	// The app runs this in a terminal of its own and reads the steps as
	// markers; a person in their own terminal sees them drawn.
	markers := os.Getenv(guided.StepsEnv) == "1"
	interactive := isTerminal(os.Stdin) && !*yes
	rep := newStepReporter(os.Stdout, markers)
	opts := guided.Options{Target: target, Agents: chosen, Listen: *listen, Address: *address, NoIntegrations: *noIntegrations, Ask: interactive}
	rep.setPlan(guided.Plan(opts, nil))

	// What ssh will do, from ~/.ssh/config, and the agent berth hands it
	// when this process has none of its own (started by launchd or the app).
	finder := sshsetup.DefaultFinder()
	cfg, err := sshsetup.ReadConfig(context.Background(), sshArgs, target)
	if err != nil {
		return err
	}
	plan := finder.MakePlan(target, cfg, "")
	env := askpassEnv(exe)
	if plan.Inject != "" {
		env = withEnv(env, "SSH_AUTH_SOCK", plan.Inject)
	}
	rep.start(guided.StepConnect)
	fmt.Fprintf(rep, "    %s\r\n", plan.Summary)
	// Failures name the host as it was typed, the way the person knows it.
	host := target[strings.LastIndex(target, "@")+1:]
	connectFailed := func(err error) error {
		rep.fail(guided.StepConnect, err.Error())
		return err
	}
	if *trustKey != "" {
		hk, err := sshsetup.FetchHostKey(context.Background(), sshsetup.Exec, env, sshArgs, target)
		if err != nil {
			return connectFailed(err)
		}
		if err := sshsetup.TrustHostKey(hk, *trustKey, finder.KnownHostsFile(cfg)); err != nil {
			return connectFailed(err)
		}
		fmt.Fprintf(rep, "    Trusted %s's host key (%s).\r\n", host, *trustKey)
	} else if (!interactive || markers) && cfg.StrictHostKeyChecking == "ask" {
		// Without a person at a terminal, and in the app, which asks about
		// it with the fingerprint beside a button, an unknown host key comes
		// back as a failure, not ssh's own question.
		sshArgs = append([]string{"-o", "StrictHostKeyChecking=yes"}, sshArgs...)
	}

	// The steps share one connection, so a password or host key question is
	// asked once. /tmp keeps the socket path under macOS's 104-byte limit.
	control, err := os.MkdirTemp("/tmp", "cpssh")
	if err != nil {
		return err
	}
	defer os.RemoveAll(control)
	sshArgs = append([]string{"-o", "ControlPath=" + filepath.Join(control, "%C")}, sshArgs...)
	fail := func(stderr string, agent *sshsetup.Agent) *sshsetup.Failure {
		f := sshsetup.Classify(stderr, host, cfg.Port, agent, plan.IdentityFiles)
		if f.Kind == "host-key-unknown" && f.Fingerprint == "" {
			if hk, err := sshsetup.FetchHostKey(context.Background(), sshsetup.Exec, env, sshArgs, target); err == nil {
				f.Fingerprint = hk.PickFingerprint(sshsetup.UnknownKeyType(stderr))
			}
			if f.Fingerprint != "" && !markers {
				f.Message += " Its fingerprint is " + f.Fingerprint + "; to trust it, run again with --trust-host-key " + f.Fingerprint + "."
			}
		}
		return f
	}
	approve := func(url string) { rep.event(guided.Event{Step: guided.StepConnect, State: guided.Open, Message: url}) }
	if stderr, err := openMaster(sshArgs, target, env, control, approve); err != nil {
		first := fail(stderr, plan.Agent)
		if first.Kind != "auth" || hasOption(sshArgs, "IdentityAgent") {
			return connectFailed(first)
		}
		// Every key was refused. Keys kept in a key manager are only offered
		// where something names its agent; try the others that are running.
		tried := ""
		if plan.Agent != nil {
			tried = plan.Agent.Socket
		}
		ok := false
		offered := first.Tried
		for _, other := range finder.Others(tried) {
			fmt.Fprintf(rep, "    Trying the keys in %s…\r\n", other.Name)
			retry := append([]string{"-o", "IdentityAgent=" + other.Socket}, sshArgs...)
			stderr, err := openMaster(retry, target, env, control, approve)
			if err == nil {
				sshArgs, ok = retry, true
				break
			}
			if f := sshsetup.Classify(stderr, host, cfg.Port, &other, nil); f.Kind == "auth" {
				offered = append(offered, f.Tried...)
			}
		}
		if !ok {
			return connectFailed(sshsetup.AuthFailure(host, cfg.Port, offered, first.Detail))
		}
	}
	defer exec.Command("ssh", append(append([]string{}, sshArgs...), "-O", "exit", target)...).Run()
	ssh := func(stdin []byte, remote string) ([]byte, error) {
		cmd := exec.Command("ssh", append(append([]string{}, sshArgs...), target, remote)...)
		cmd.Env = env
		if stdin != nil {
			cmd.Stdin = bytes.NewReader(stdin)
		}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) && ee.ExitCode() != 255 {
				// The remote command failed, not ssh: its own words say why.
				return out, fmt.Errorf("on %s, %s failed: %s", host, strings.Fields(remote)[0], strings.TrimSpace(stderr.String()))
			}
			return out, fail(stderr.String(), plan.Agent)
		}
		return out, nil
	}

	// What is on the box already decides the plan: tmux and git, the
	// package manager, lingering, which agents.
	out, err := ssh(nil, guided.ProbeScript)
	if err != nil {
		return connectFailed(err)
	}
	probe, err := guided.ParseProbe(string(out))
	if err != nil {
		return connectFailed(err)
	}
	if probe.UID == 0 {
		return connectFailed(fmt.Errorf("you logged in to %s as root. Shipyard installs as the user your agents will run as, never root: log in as that user (make one with: adduser me && usermod -aG sudo me) and set the box up again", host))
	}
	daemon, err := daemonFor(probe.OS + " " + map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[probe.Arch])
	if err != nil {
		return connectFailed(err)
	}
	var tmux []byte
	if probe.OS == "linux" && !probe.Tmux {
		tmux, _ = readDaemon(exe, guided.TmuxName(probe.Arch))
	}
	opts.BundledTmux = tmux != nil
	steps := guided.Plan(opts, &probe)
	rep.setPlan(steps)
	rep.done(guided.StepConnect, fmt.Sprintf("%s@%s, %s/%s", probe.User, host, probe.OS, probe.Arch))

	// berthd listens on the box's tailnet address unless told where; a box
	// without one needs a choice, which only a person can make.
	if !probe.Tailnet && *listen == "" && probe.Listen == "" {
		if !interactive {
			return connectFailed(fmt.Errorf("%s has no tailnet (Tailscale) address, so Shipyard won't choose where berthd listens. Install Tailscale on it, or set it up again with --listen 0.0.0.0:7444 to listen on every interface (only laptops you pair can connect: both keys are pinned)", host))
		}
		if *guidedFlag {
			printPlan(rep, steps, rep.color)
		}
		if !askListenEverywhere(os.Stdin, rep, host, rep.color) {
			return errors.New("stopped before anything was installed. To listen on every interface, set it up again with --listen 0.0.0.0:7444; or install Tailscale on the box")
		}
		opts.Listen = "0.0.0.0:7444"
		steps = guided.Plan(opts, &probe)
		rep.setPlan(steps)
	} else if *guidedFlag {
		printPlan(rep, steps, rep.color)
		if interactive && fromIdx == 0 && !waitForEnter(os.Stdin, rep, rep.color) {
			return errors.New("stopped before anything was installed")
		}
	}
	if *guidedFlag {
		fmt.Fprint(rep, "\r\n")
	}

	pending := func(id string) bool { return guided.Index(id) >= fromIdx }
	var run []string
	for _, s := range steps {
		switch {
		case s.Where == "laptop":
		case !pending(s.ID):
			rep.skip(s.ID, "done before")
		case s.Skip != "":
			rep.skip(s.ID, s.Skip)
		default:
			run = append(run, s.ID)
		}
	}
	has := func(id string) bool { return slices.Contains(run, id) }

	// The files go up first, over the shared connection, with no terminal.
	if has(guided.StepBerthd) {
		rep.start(guided.StepBerthd)
		binary, err := readDaemon(exe, daemon)
		if err != nil {
			rep.fail(guided.StepBerthd, err.Error())
			return err
		}
		fmt.Fprintf(rep, "    Uploading %s (%d MB) to ~/.local/bin/berthd\r\n", daemon, len(binary)>>20)
		if _, err := ssh(binary, upload("berthd")); err != nil {
			rep.fail(guided.StepBerthd, err.Error())
			return err
		}
	}
	if has(guided.StepTools) && tmux != nil {
		fmt.Fprintf(rep, "    Uploading Shipyard's tmux for %s/%s (%d MB) to ~/.local/bin/tmux\r\n", probe.OS, probe.Arch, max(1, len(tmux)>>20))
		if _, err := ssh(tmux, upload("tmux")); err != nil {
			rep.fail(guided.StepTools, err.Error())
			return err
		}
	}
	// runSegment uploads the script for some of the steps and runs it: in a
	// terminal when one of them needs sudo's password, else without.
	runSegment := func(seg guided.Segment) error {
		o := opts
		o.Ask = seg.Terminal || (*guidedFlag && interactive)
		script := guided.Script(o, probe, seg.Steps)
		if _, err := ssh([]byte(script), "mkdir -p ~/.cache/berth && cat > ~/.cache/berth/guided-install.sh"); err != nil {
			rep.fail(seg.Steps[0], err.Error())
			return err
		}
		return runSteps(rep, sshArgs, env, target, o.Ask)
	}
	lingerNote := ""
	if *guidedFlag {
		// The guided install: every step in one terminal, so sudo asks once.
		if len(run) > 0 {
			if err := runSegment(guided.Segment{Steps: run, Terminal: interactive}); err != nil {
				return err
			}
		}
	} else if len(run) > 0 {
		// The quiet install: berthd first, then lingering where the box
		// allows it without a password; only what still needs sudo's
		// password runs in a terminal.
		if run[0] == guided.StepBerthd {
			if err := runSegment(guided.Segment{Steps: run[:1]}); err != nil {
				return err
			}
			run = run[1:]
		}
		if has(guided.StepLinger) {
			out, err := ssh(nil, guided.LingerTry)
			if err == nil && guided.LingerOn(string(out)) {
				probe.Linger = "yes"
				rep.start(guided.StepLinger)
				rep.done(guided.StepLinger, "on, without sudo")
				run = slices.DeleteFunc(run, func(s string) bool { return s == guided.StepLinger })
			}
		}
		if has(guided.StepLinger) && probe.Linger != "yes" {
			// Lingering needs a password (or root) here. Alongside git, it
			// rides in the same terminal; on its own, it is asked about, and
			// skipped when nobody can type the password.
			skip := false
			switch {
			case !probe.Sudo:
				skip = true
			case guided.AskLinger(run, opts, probe):
				skip = !interactive || !rep.askYes(os.Stdin, guided.StepLinger, guided.LingerQuestion(probe.User))
			case !interactive:
				skip = true
			}
			if skip {
				rep.skip(guided.StepLinger, guided.LingerSkipped(probe.User))
				lingerNote = "berthd stops when you log out of " + host + ": run `sudo loginctl enable-linger " + probe.User + "` there to keep it running."
				run = slices.DeleteFunc(run, func(s string) bool { return s == guided.StepLinger })
			}
		}
		for _, seg := range guided.Segments(run, func(s string) bool { return interactive && guided.NeedsPassword(s, opts, probe) }) {
			if err := runSegment(seg); err != nil {
				return err
			}
		}
	}

	if !pending(guided.StepPair) {
		return nil
	}
	rep.start(guided.StepPair)
	name2, addr, err := pairOverSSH(l, ssh, *address, *name, *via)
	if err != nil {
		rep.fail(guided.StepPair, err.Error())
		return err
	}
	// The host it was added with is a second way to reach it, which the
	// agent uses when it is the faster one (Settings › Boxes turns it off).
	// A box on another network is reached through that network either way.
	if *via == "" {
		listenAt := opts.Listen
		if listenAt == "" {
			listenAt = probe.Listen
		}
		recordSSHRoute(l, name2, target, *identity, forwardFor(listenAt))
	}
	rep.done(guided.StepPair, name2)
	fmt.Fprintf(rep, "\r\nReady: paired with %s at %s. SSH is no longer needed for this box.\r\n", name2, addr)
	if lingerNote != "" && !markers {
		fmt.Fprintf(rep, "Note: %s\r\n", lingerNote)
	}
	if !markers && len(chosen) == 1 {
		fmt.Fprintf(rep, "%s asks you to sign in the first time you start it there.\r\n", agentcli.Names(chosen))
	} else if !markers && len(chosen) > 1 {
		fmt.Fprintf(rep, "%s each ask you to sign in the first time you start them there.\r\n", agentcli.Names(chosen))
	}
	return nil
}

// upload is the remote command that puts stdin in ~/.local/bin/NAME,
// renamed into place, so a running copy keeps its file until it restarts.
func upload(name string) string {
	return "mkdir -p ~/.local/bin && cat > ~/.local/bin/" + name + ".new && chmod +x ~/.local/bin/" + name + ".new && mv ~/.local/bin/" + name + ".new ~/.local/bin/" + name
}

// runSteps runs the uploaded step script on the box: in a terminal (ssh -t)
// when a person is at this one, so sudo can ask them for their password,
// with its markers read on the way through. A failed step is the error.
func runSteps(rep *stepReporter, sshArgs, env []string, target string, interactive bool) error {
	// -q: ssh's own "Shared connection … closed" is not a step's output.
	args := append([]string{"-q"}, sshArgs...)
	if interactive {
		args = append(args, "-t")
	}
	args = append(args, target, "sh ~/.cache/berth/guided-install.sh")
	cmd := exec.Command("ssh", args...)
	cmd.Env = env
	if interactive {
		cmd.Stdin = os.Stdin
	}
	filter := &guided.Filter{Out: rep, OnStep: rep.remote}
	cmd.Stdout = filter
	cmd.Stderr = filter
	err := cmd.Run()
	filter.Flush()
	rep.mu.Lock()
	failed, why, command := rep.failed, rep.why, rep.command
	rep.mu.Unlock()
	if failed != "" {
		msg := why
		if command != "" {
			msg = strings.TrimRight(msg, ".") + ". Run this on the box, then set it up again:\n  " + command
		}
		return errors.New(msg)
	}
	if err != nil {
		var ee *exec.ExitError
		msg := "the connection to the box closed before the steps finished"
		if errors.As(err, &ee) && ee.ExitCode() != 255 {
			msg = fmt.Sprintf("the steps stopped (exit %d)", ee.ExitCode())
		}
		rep.failCurrent(msg)
		return errors.New(msg)
	}
	return nil
}

// pairOverSSH has the box print a pairing link and pairs with it, saving
// the box under name (or one made from its hostname).
func pairOverSSH(l laptop, ssh func([]byte, string) ([]byte, error), address, name, via string) (string, string, error) {
	pair := "sleep 1; ~/.local/bin/berthd pair"
	if address != "" {
		pair += " --address " + shellQuote(address)
	}
	out, err := ssh(nil, pair)
	if err != nil {
		return "", "", err
	}
	link, err := findLink(out)
	if err != nil {
		return "", "", err
	}
	tok, err := pairing.ParseToken(link)
	if err != nil {
		return "", "", err
	}
	id, err := l.identity()
	if err != nil {
		return "", "", err
	}
	hostname, _ := os.Hostname()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dial, err := networkDialer(l, via)
	if err != nil {
		return "", "", err
	}
	reported, err := wire.PairVia(ctx, id, tok, trust.NameFromHostname(hostname, "laptop"), dial)
	if err != nil {
		return "", "", fmt.Errorf("berthd is installed but this laptop could not reach it at %s: %w. "+
			"If the box is only reachable another way, set it up again with --address", tok.Address, err)
	}
	peer := trust.Peer{Name: name, Address: tok.Address, Network: via, Fingerprint: tok.Fingerprint, PairedAt: time.Now().UTC()}
	if peer.Name == "" {
		peer.Name = trust.NameFromHostname(reported, "box")
		peer.Name, err = l.boxes().AddWithFreeName(peer)
	} else {
		err = l.boxes().Add(peer)
	}
	if err != nil {
		return "", "", err
	}
	if c := agentIfRunning(l); c != nil {
		c.Refresh(context.Background())
	}
	return peer.Name, peer.Address, nil
}

// recordSSHRoute remembers how a box was reached over SSH, for the agent's
// SSH route to it. Only the host as typed and the key file's path are kept.
func recordSSHRoute(l laptop, box, target, identityFile, forward string) {
	p, ok, err := l.boxes().ByName(box)
	if err != nil || !ok {
		return
	}
	if identityFile != "" {
		if abs, err := expandHome(identityFile); err == nil {
			identityFile = abs
		}
	}
	if err := agent.RecordSSHRoute(l.dir, p.Name, p.Fingerprint.String(), target, identityFile, forward); err != nil {
		return
	}
	if c := agentIfRunning(l); c != nil {
		c.Refresh(context.Background())
	}
}

// forwardFor is where an SSH route reaches berthd on the box, given where
// it listens: on every interface, its loopback; on one address, that
// address; unknown (its tailnet address), the address it was paired at.
func forwardFor(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	switch {
	case err != nil:
		return ""
	case host == "" || host == "0.0.0.0" || host == "::":
		return net.JoinHostPort("127.0.0.1", port)
	}
	return listen
}

// checkName refuses a --name that cannot be a hostname before any work is
// done, suggesting one that can.
func checkName(name string) error {
	if name == "" || trust.ValidName(name) {
		return nil
	}
	return fmt.Errorf("%q cannot be a box name: it is part of URLs like 3000.NAME.localhost. Try --name %s", name, trust.NameFromHostname(name, "box"))
}

// checkNetwork refuses a --network that is not a network's name: it ends up
// in ssh's ProxyCommand and in the laptop's records.
func checkNetwork(network string) error {
	if network == "" || trust.ValidName(network) {
		return nil
	}
	return fmt.Errorf("%q is not a network name (see berth networks)", network)
}

// proxyCommand is the ssh option that reaches a box through a berth network.
// %h and %p are ssh's own tokens and stay outside the quotes.
func proxyCommand(exe, network string) string {
	return fmt.Sprintf("ProxyCommand=%s network proxy %s %%h %%p", shellQuote(exe), shellQuote(network))
}

// openMaster authenticates once and leaves a shared connection in the
// background, returning ssh's stderr when it fails. That goes to a file, not
// a pipe: the backgrounded ssh keeps it open, and waiting on a pipe would
// wait for that process to exit. -v adds the keys ssh offered, which an
// "every key was refused" failure names.
func openMaster(sshArgs []string, target string, env []string, dir string, approve func(url string)) (string, error) {
	errFile, err := os.Create(filepath.Join(dir, "stderr"))
	if err != nil {
		return "", err
	}
	defer errFile.Close()
	cmd := exec.Command("ssh", append(append([]string{"-v", "-o", "ControlMaster=yes", "-o", "ControlPersist=120", "-f", "-N"}, sshArgs...), target)...)
	cmd.Env = env
	cmd.Stderr = errFile
	if err := cmd.Start(); err != nil {
		return "", err
	}
	// Tailscale SSH in check mode holds the login until the person approves
	// it in a browser, and says where in ssh's stderr. Pass that on, or the
	// login would wait for an approval nobody knows to give.
	stop := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for {
			select {
			case <-stop:
				return
			case <-time.After(300 * time.Millisecond):
			}
			if data, err := os.ReadFile(errFile.Name()); err == nil {
				if u := checkURL(string(data)); u != "" {
					approve(u)
					return
				}
			}
		}
	}()
	err = cmd.Wait()
	close(stop)
	<-watched
	if err != nil {
		stderr, _ := os.ReadFile(errFile.Name())
		return string(stderr), err
	}
	return "", nil
}

var checkPattern = regexp.MustCompile(`(?i)to authenticate, visit:?\s*(https://\S+)`)

// checkURL finds the approval page Tailscale SSH's check mode names.
func checkURL(stderr string) string {
	if m := checkPattern.FindStringSubmatch(stderr); m != nil {
		return m[1]
	}
	return ""
}

// hasOption reports whether ssh arguments set an -o option already; ssh
// keeps the first value it sees, so berth's defaults must not mask the
// person's own.
func hasOption(sshArgs []string, name string) bool {
	return slices.ContainsFunc(sshArgs, func(a string) bool {
		return strings.HasPrefix(strings.ToLower(a), strings.ToLower(name)+"=") || strings.HasPrefix(strings.ToLower(a), strings.ToLower(name)+" ")
	})
}

// withEnv sets one variable in an environment list, replacing any value.
func withEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, key+"=") {
			out = append(out, kv)
		}
	}
	return append(out, key+"="+value)
}

func expandHome(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~")), nil
	}
	return filepath.Abs(path)
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func indent(s string) string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return ""
	}
	return "  " + strings.ReplaceAll(s, "\n", "\n  ") + "\n"
}

// parseAnywhere accepts flags before and after positional arguments.
func parseAnywhere(fs *flag.FlagSet, args []string) ([]string, error) {
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

// readDaemon finds the berthd build to upload: beside berth in a build
// directory, or in Contents/Resources when berth runs inside the macOS app.
// berth on the PATH is often a link to the app's copy (Settings → General
// → Command line), so look beside the file the link points at.
func readDaemon(exe, daemon string) ([]byte, error) {
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	dir := filepath.Dir(exe)
	for _, path := range []string{filepath.Join(dir, daemon), filepath.Join(dir, "..", "Resources", daemon)} {
		if b, err := os.ReadFile(path); err == nil {
			return b, nil
		}
	}
	// Shipyard.app carries one universal berthd for Macs (the one Use this Mac
	// runs), not one per architecture, and make build puts this Mac's own in
	// bin/: either serves a Mac box it can run on.
	if arch, ok := strings.CutPrefix(daemon, "berthd-darwin-"); ok && runtime.GOOS == "darwin" {
		for _, path := range []string{filepath.Join(dir, "berthd"), filepath.Join(dir, "..", "Resources", "berthd")} {
			if b, err := os.ReadFile(path); err == nil && (universal(b) || arch == runtime.GOARCH) {
				return b, nil
			}
		}
	}
	return nil, fmt.Errorf("no %s next to berth (%s); build it with `make daemons`", daemon, dir)
}

// universal is whether b is a universal (fat) Mach-O binary, which runs on
// Apple silicon and Intel alike.
func universal(b []byte) bool {
	return len(b) >= 4 && b[0] == 0xca && b[1] == 0xfe && b[2] == 0xba && b[3] == 0xbe
}
