package guided

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestMarkerRoundTrip(t *testing.T) {
	line := Marker("tools", Fail, "sudo said no\nthree times")
	if line != "::berth-step tools fail sudo said no three times\n" {
		t.Fatalf("marker = %q", line)
	}
	e, ok := ParseMarker(line)
	if !ok || e != (Event{Step: "tools", State: Fail, Message: "sudo said no three times"}) {
		t.Fatalf("parsed %+v, %v", e, ok)
	}
	if e, ok := ParseMarker("::berth-step agents start\r\n"); !ok || e.Step != "agents" || e.State != Start || e.Message != "" {
		t.Fatalf("parsed %+v, %v", e, ok)
	}
	for _, bad := range []string{"::berth-step", "::berth-step x", "::berth-step x maybe", "::berth-step BAD start", "berth-step x start", "::berth-step ../x start"} {
		if _, ok := ParseMarker(bad); ok {
			t.Errorf("%q parsed as a marker", bad)
		}
	}
}

// collect runs output through a Filter in the given chunks.
func collect(chunks ...string) (string, []Event, []string) {
	var out bytes.Buffer
	var events []Event
	var failures []string
	f := &Filter{Out: &out, OnStep: func(e Event) { events = append(events, e) }, OnFailure: func(r json.RawMessage) { failures = append(failures, string(r)) }}
	for _, c := range chunks {
		f.Write([]byte(c))
	}
	f.Flush()
	return out.String(), events, failures
}

func TestFilterTakesMarkersOut(t *testing.T) {
	out, events, _ := collect("Reading package lists...\r\n::berth-step tools done\r\nnext\r\n")
	if out != "Reading package lists...\r\nnext\r\n" {
		t.Errorf("out = %q", out)
	}
	if len(events) != 1 || events[0] != (Event{Step: "tools", State: Done}) {
		t.Errorf("events = %+v", events)
	}
}

func TestFilterMarkerSplitAcrossWrites(t *testing.T) {
	whole := "a\n::berth-step agents start\nb\n::berth-step agents done 2 agents\n"
	// Every split point, as a pseudo-terminal can deliver it.
	for i := 1; i < len(whole); i++ {
		out, events, _ := collect(whole[:i], whole[i:])
		if out != "a\nb\n" {
			t.Fatalf("split at %d: out = %q", i, out)
		}
		want := []Event{{Step: "agents", State: Start}, {Step: "agents", State: Done, Message: "2 agents"}}
		if !reflect.DeepEqual(events, want) {
			t.Fatalf("split at %d: events = %+v", i, events)
		}
	}
	// A byte at a time.
	var chunks []string
	for _, c := range whole {
		chunks = append(chunks, string(c))
	}
	if out, events, _ := collect(chunks...); out != "a\nb\n" || len(events) != 2 {
		t.Fatalf("byte at a time: %q %+v", out, events)
	}
}

// What a step printed reaches the screen before the marker after it is
// handled, so a checklist drawn into the same terminal keeps the order.
func TestFilterKeepsOrder(t *testing.T) {
	var log []string
	var out bytes.Buffer
	rec := writerFunc(func(p []byte) { log = append(log, "out:"+string(p)) })
	f := &Filter{Out: io.MultiWriter(&out, rec), OnStep: func(e Event) { log = append(log, "step:"+e.Step+":"+e.State) }}
	f.Write([]byte("Lingering is on\n::berth-step linger done\nnext\n"))
	f.Flush()
	want := []string{"out:Lingering is on\n", "step:linger:done", "out:next\n"}
	if strings.Join(log, "|") != strings.Join(want, "|") {
		t.Errorf("order = %q", log)
	}
}

type writerFunc func([]byte)

func (w writerFunc) Write(p []byte) (int, error) { w(p); return len(p), nil }

func TestFilterMarkerMidLineEndsTheLine(t *testing.T) {
	out, events, _ := collect("Downloading 42%::berth-step agents done\nok\n")
	if out != "Downloading 42%\r\nok\n" {
		t.Errorf("out = %q", out)
	}
	if len(events) != 1 {
		t.Errorf("events = %+v", events)
	}
}

func TestFilterPassesLookalikes(t *testing.T) {
	text := "::berth is not a marker\n: :berth-step no\n::berth-stepx start\nberth-fail\n:::berth-step x start\n"
	out, events, _ := collect(text)
	if len(events) != 1 || events[0].Step != "x" {
		t.Errorf("events = %+v", events)
	}
	if out != "::berth is not a marker\n: :berth-step no\n::berth-stepx start\nberth-fail\n:\n" && out != "::berth is not a marker\n: :berth-step no\n::berth-stepx start\nberth-fail\n:\r\n" {
		t.Errorf("out = %q", out)
	}
}

func TestFilterFailureLine(t *testing.T) {
	out, _, failures := collect("berth: nope\nberth-failure: {\"kind\":\"auth\",\"message\":\"m\"}\n")
	if out != "berth: nope\n" {
		t.Errorf("out = %q", out)
	}
	if len(failures) != 1 || failures[0] != `{"kind":"auth","message":"m"}` {
		t.Errorf("failures = %q", failures)
	}
}

func TestFilterFlushKeepsTheEnd(t *testing.T) {
	if out, _, _ := collect("Password: ::ber"); out != "Password: ::ber" {
		t.Errorf("out = %q", out)
	}
	if out, events, _ := collect("::berth-step pair done devbox"); out != "" || len(events) != 1 || events[0].Message != "devbox" {
		t.Errorf("out = %q events = %+v", out, events)
	}
}

func TestParseProbe(t *testing.T) {
	p, err := ParseProbe("os Linux\narch aarch64\nuid 1000\nuser demo\nhome /home/demo\nmanager apt-get\nlinger no\nsudo yes\nagent claude\ntailnet yes\nlisten 100.64.0.2:7444\n")
	if err != nil {
		t.Fatal(err)
	}
	if p.OS != "linux" || p.Arch != "arm64" || p.UID != 1000 || p.Tmux || p.Git || p.Manager != "apt-get" || p.Linger != "no" || !p.Sudo || p.SudoNoPassword || !p.Agents["claude"] || p.Agents["codex"] || !p.Tailnet || p.Listen != "100.64.0.2:7444" {
		t.Errorf("probe = %+v", p)
	}
	g, err := ParseProbe("os Linux\narch x86_64\nuid 1000\nuser demo\nhome /home/demo\nagent grok\n")
	if err != nil || !g.Agents["grok"] {
		t.Errorf("grok probe = %+v %v", g, err)
	}
	for _, bad := range []string{"", "os Plan9\narch x86_64\nuid 1\n", "os Linux\narch riscv64\nuid 1\n"} {
		if _, err := ParseProbe(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func ids(steps []Step) []string {
	var out []string
	for _, s := range steps {
		out = append(out, s.ID)
	}
	return out
}

func find(steps []Step, id string) Step {
	for _, s := range steps {
		if s.ID == id {
			return s
		}
	}
	return Step{}
}

func TestPlanBeforeConnecting(t *testing.T) {
	steps := Plan(Options{Target: "demo@berth-demo.orb.local", Agents: []string{"claude", "codex"}, BundledTmux: true}, nil)
	if got := strings.Join(ids(steps), " "); got != "connect berthd linger tools agents integrations pair" {
		t.Fatalf("steps = %s", got)
	}
	tools := find(steps, StepTools)
	if !tools.Sudo || tools.When == "" || !strings.Contains(tools.Commands[0], "~/.local/bin/tmux") {
		t.Errorf("tools = %+v", tools)
	}
	if l := find(steps, StepLinger); !l.Sudo || !strings.HasPrefix(l.Commands[0], "loginctl enable-linger demo ") || !strings.HasPrefix(l.Commands[1], "sudo loginctl enable-linger demo ") {
		t.Errorf("linger = %+v", l)
	}
	if a := find(steps, StepAgents); a.Title != "Claude Code and Codex" || !strings.Contains(strings.Join(a.Commands, "\n"), "https://claude.ai/install.sh") {
		t.Errorf("agents = %+v", a)
	}
	if c := find(steps, StepConnect); c.Where != "laptop" || c.Sudo {
		t.Errorf("connect = %+v", c)
	}
}

func TestPlanFreshUbuntu(t *testing.T) {
	p := Probe{OS: "linux", Arch: "arm64", UID: 1000, User: "demo", Manager: "apt-get", Linger: "no", Sudo: true, Agents: map[string]bool{}}
	steps := Plan(Options{Target: "demo@box", Agents: []string{"claude", "codex"}, BundledTmux: true}, &p)
	tools := find(steps, StepTools)
	want := []string{"upload tmux-linux-arm64 → ~/.local/bin/tmux   (Shipyard's own build: no sudo)", "sudo apt-get update -q", "sudo apt-get install -y -q git"}
	if !reflect.DeepEqual(tools.Commands, want) || !tools.Sudo || tools.Skip != "" {
		t.Errorf("tools = %+v", tools)
	}
	if a := find(steps, StepAgents); !strings.Contains(strings.Join(a.Commands, "\n"), "codex-aarch64-unknown-linux-musl.tar.gz") {
		t.Errorf("agents = %+v", a.Commands)
	}
	if got := SudoSteps(steps); !reflect.DeepEqual(got, []string{"Keep berthd running after you log out", "tmux and git"}) {
		t.Errorf("sudo steps = %v", got)
	}

	// Without Shipyard's tmux, tmux comes from apt-get too.
	steps = Plan(Options{Target: "demo@box"}, &p)
	if c := find(steps, StepTools).Commands; c[len(c)-1] != "sudo apt-get install -y -q tmux git" {
		t.Errorf("tools without a bundled tmux = %v", c)
	}
	if find(steps, StepAgents).ID != "" {
		t.Error("no agents chosen, but the plan has an agents step")
	}
}

func TestPlanSetUpBox(t *testing.T) {
	p := Probe{OS: "linux", Arch: "amd64", UID: 1000, User: "demo", Tmux: true, Git: true, Manager: "apt-get", Linger: "yes", Agents: map[string]bool{"claude": true}}
	steps := Plan(Options{Target: "demo@box", Agents: []string{"claude"}, NoIntegrations: true}, &p)
	if got := strings.Join(ids(steps), " "); got != "connect berthd tools agents pair" {
		t.Fatalf("steps = %s", got)
	}
	if find(steps, StepTools).Skip == "" || find(steps, StepAgents).Skip == "" {
		t.Errorf("a set-up box still has tools or agents to install: %+v", steps)
	}
	if len(SudoSteps(steps)) != 0 {
		t.Errorf("sudo steps = %v", SudoSteps(steps))
	}
	// A Mac has no lingering to turn on, and gets tmux from Homebrew.
	mac := Probe{OS: "darwin", Arch: "arm64", UID: 501, User: "me", Git: true, Manager: "brew", Agents: map[string]bool{}}
	steps = Plan(Options{Target: "me@mac", BundledTmux: true}, &mac)
	if find(steps, StepLinger).ID != "" {
		t.Error("a Mac got a linger step")
	}
	if tools := find(steps, StepTools); tools.Sudo || tools.Commands[0] != "brew install tmux" {
		t.Errorf("mac tools = %+v", tools)
	}
}

func TestPackageSteps(t *testing.T) {
	steps, brew := PackageSteps("dnf", []string{"git"})
	if brew || CommandLines(steps, brew)[0] != "sudo dnf install -y git" {
		t.Errorf("dnf = %v", steps)
	}
	if steps, _ := PackageSteps("nix", []string{"git"}); steps != nil {
		t.Errorf("an unknown manager got steps: %v", steps)
	}
}

// fakeBox makes a home folder and a PATH of stand-ins for what the script
// runs: berthd, sudo, apt-get, loginctl and id. log records each call.
func fakeBox(t *testing.T, sudoAsks bool, uid string) (home string, env []string, log string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs sh")
	}
	dir := t.TempDir()
	home = filepath.Join(dir, "home")
	bin := filepath.Join(dir, "bin")
	log = filepath.Join(dir, "log")
	os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755)
	os.MkdirAll(bin, 0o755)
	write := func(path, body string) {
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(home, ".local", "bin", "berthd"), `echo "berthd $*" >>"$LOG"; case "$1" in install) echo "Installed unit"; echo "Next: berthd pair";; *) echo "Claude Code: hooks added";; esac`)
	write(filepath.Join(home, ".local", "bin", "tmux"), `echo "tmux 3.5a"`)
	nopass := "0"
	if sudoAsks {
		nopass = "1"
	}
	write(filepath.Join(bin, "sudo"), `asks=`+nopass+`
if [ "$1" = -n ]; then shift; [ "$asks" = 1 ] && exit 1; fi
[ "$1" = true ] && exit 0
echo "sudo $*" >>"$LOG"
if [ "$asks" = 1 ]; then printf '[sudo] password for me: '; read -r pw; echo; fi
case "$1" in env) shift; shift ;; esac
SUDO_USER=me
export SUDO_USER
"$@"`)
	write(filepath.Join(bin, "apt-get"), `echo "apt-get $*" >>"$LOG"; case "$*" in *install*) printf '#!/bin/sh\necho git version 2.43\n' >"$FAKEBIN/git"; chmod +x "$FAKEBIN/git";; esac`)
	// loginctl turns lingering on for root, or for the user where polkit
	// lets them (POLKIT=1), as Debian 12 does; else access is denied, as on
	// an Ubuntu without polkitd.
	write(filepath.Join(bin, "loginctl"), `echo "loginctl $*" >>"$LOG"
case "$1" in
show-user) if [ -f "$FAKEBIN/lingering" ]; then echo Linger=yes; else echo Linger=no; fi ;;
enable-linger) if [ -n "$SUDO_USER" ] || [ "$POLKIT" = 1 ]; then touch "$FAKEBIN/lingering"; else echo "Could not enable linger: Access denied" >&2; exit 1; fi ;;
esac`)
	write(filepath.Join(bin, "id"), `case "$1" in -u) echo `+uid+`;; *) echo me;; esac`)
	// Only what the script needs from the system, so the system's own git
	// (macOS has one) doesn't count as the box's.
	sys := filepath.Join(dir, "sys")
	os.MkdirAll(sys, 0o755)
	for _, tool := range []string{"sh", "sed", "cat", "chmod", "touch"} {
		p, err := exec.LookPath(tool)
		if err != nil {
			t.Fatal(err)
		}
		os.Symlink(p, filepath.Join(sys, tool))
	}
	env = []string{"HOME=" + home, "LOG=" + log, "FAKEBIN=" + bin, "PATH=" + bin + ":" + sys}
	return home, env, log
}

func runScript(t *testing.T, script, stdin string, env []string) (string, []Event, error) {
	t.Helper()
	sh, _ := exec.LookPath("sh")
	cmd := exec.Command(sh, "-c", script)
	cmd.Env = env
	cmd.Stdin = strings.NewReader(stdin)
	var out bytes.Buffer
	var events []Event
	f := &Filter{Out: &out, OnStep: func(e Event) { events = append(events, e) }}
	cmd.Stdout, cmd.Stderr = f, f
	err := cmd.Run()
	f.Flush()
	return out.String(), events, err
}

func states(events []Event) string {
	var out []string
	for _, e := range events {
		out = append(out, e.Step+":"+e.State)
	}
	return strings.Join(out, " ")
}

func TestScriptSyntax(t *testing.T) {
	p := Probe{OS: "linux", Arch: "amd64", User: "me", Manager: "apt-get", Linger: "no", Agents: map[string]bool{}}
	o := Options{Target: "me@box", Agents: []string{"claude", "codex"}, BundledTmux: true, Ask: true, Listen: "0.0.0.0:7444"}
	script := Script(o, p, []string{StepBerthd, StepLinger, StepTools, StepAgents, StepIntegrations})
	if out, err := exec.Command("sh", "-n", "-c", script).CombinedOutput(); err != nil {
		t.Fatalf("sh -n: %v\n%s\n%s", err, out, script)
	}
	if !strings.Contains(script, "--listen '0.0.0.0:7444'") || !strings.Contains(script, `"$BERTHD" agents install claude codex`) {
		t.Errorf("script lacks the listen address or the agents:\n%s", script)
	}
}

func TestScriptRunsWithSudoAsking(t *testing.T) {
	_, env, log := fakeBox(t, true, "1000")
	p := Probe{OS: "linux", Arch: "amd64", User: "me", Manager: "apt-get", Linger: "no", Agents: map[string]bool{}}
	o := Options{Target: "me@box", BundledTmux: true, Ask: true}
	script := Script(o, p, []string{StepBerthd, StepLinger, StepTools, StepIntegrations})
	out, events, err := runScript(t, script, "hunter2\nhunter2\nhunter2\n", env)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	// sudo asks once, at the first step that needs it, and says so first.
	if got := states(events); got != "berthd:start berthd:done linger:start linger:sudo linger:done tools:start tools:done integrations:start integrations:done" {
		t.Errorf("events = %s\n%s", got, out)
	}
	if strings.Contains(out, "Next: berthd pair") || strings.Contains(out, "hunter2") {
		t.Errorf("output has what it shouldn't:\n%s", out)
	}
	if !strings.Contains(out, "Shipyard never sees it") {
		t.Errorf("sudo's password wasn't explained:\n%s", out)
	}
	calls, _ := os.ReadFile(log)
	for _, want := range []string{"berthd install --no-tools --no-integrations --keep-listen", "sudo loginctl enable-linger me", "apt-get install -y -q git", "berthd integrations install present"} {
		if !strings.Contains(string(calls), want) {
			t.Errorf("no %q in:\n%s", want, calls)
		}
	}
	if strings.Contains(string(calls), "hunter2") {
		t.Error("the password reached a log")
	}
}

func TestScriptWithoutATerminalSaysTheCommand(t *testing.T) {
	_, env, _ := fakeBox(t, true, "1000")
	p := Probe{OS: "linux", Arch: "amd64", User: "me", Manager: "apt-get", Linger: "yes", Tmux: true, Agents: map[string]bool{}}
	script := Script(Options{Target: "me@box"}, p, []string{StepTools})
	out, events, err := runScript(t, script, "", env)
	if err == nil {
		t.Fatalf("the script went on without sudo's password:\n%s", out)
	}
	if got := states(events); got != "tools:start tools:cmd tools:fail" {
		t.Errorf("events = %s", got)
	}
	if events[1].Message != "sudo apt-get update -q && sudo apt-get install -y -q git" {
		t.Errorf("command = %q", events[1].Message)
	}
	if !strings.Contains(out, "  sudo apt-get update -q && sudo apt-get install -y -q git") {
		t.Errorf("the command isn't on a line of its own:\n%s", out)
	}
}

func TestScriptRefusesRoot(t *testing.T) {
	_, env, log := fakeBox(t, false, "0")
	script := Script(Options{Target: "root@box"}, Probe{OS: "linux", Arch: "amd64"}, []string{StepBerthd})
	out, events, err := runScript(t, script, "", env)
	if err == nil || len(events) != 1 || events[0].State != Fail || !strings.Contains(out, "not as root") {
		t.Errorf("err %v events %+v\n%s", err, events, out)
	}
	if calls, _ := os.ReadFile(log); len(calls) > 0 {
		t.Errorf("it ran things as root:\n%s", calls)
	}
}

func TestScriptRerunChangesNothing(t *testing.T) {
	_, env, log := fakeBox(t, true, "1000")
	p := Probe{OS: "linux", Arch: "amd64", User: "me", Manager: "apt-get", Linger: "no", Agents: map[string]bool{}}
	script := Script(Options{Target: "me@box", BundledTmux: true, Ask: true}, p, []string{StepTools})
	if out, _, err := runScript(t, script, "pw\npw\n", env); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	os.Remove(log)
	// git is there now: the same script installs nothing and asks nothing.
	out, events, err := runScript(t, script, "", env)
	if err != nil || states(events) != "tools:start tools:done" {
		t.Fatalf("%v %s\n%s", err, states(events), out)
	}
	if calls, _ := os.ReadFile(log); len(calls) > 0 {
		t.Errorf("a second run ran:\n%s", calls)
	}
}
