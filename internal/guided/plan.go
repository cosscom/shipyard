package guided

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/cosscom/shipyard/internal/agentcli"
)

// The steps, in the order they run. connect and pair run on the laptop;
// the rest on the box, in one terminal, so sudo asks once.
const (
	StepConnect      = "connect"
	StepBerthd       = "berthd"
	StepLinger       = "linger"
	StepTools        = "tools"
	StepAgents       = "agents"
	StepIntegrations = "integrations"
	StepPair         = "pair"
)

// Order is every step in the order they run.
var Order = []string{StepConnect, StepBerthd, StepLinger, StepTools, StepAgents, StepIntegrations, StepPair}

// Index is a step's place in Order, or -1.
func Index(step string) int {
	for i, s := range Order {
		if s == step {
			return i
		}
	}
	return -1
}

// Options are what the person chose.
type Options struct {
	// Target is user@host as typed.
	Target string
	// Agents are the agent CLIs to install (agentcli ids).
	Agents []string
	// Listen and Address are berthd install's --listen and pair's --address.
	Listen  string
	Address string
	// NoIntegrations leaves the agents' hooks and skills out.
	NoIntegrations bool
	// Ask is whether a person is at a terminal to type sudo's password
	// and press Enter; without one, steps that need a password stop with
	// the command to run instead.
	Ask bool
	// BundledTmux is whether berth carries a tmux for the box's platform,
	// to upload when the box has none (no sudo needed).
	BundledTmux bool
}

// Probe is what Shipyard found on the box after connecting.
type Probe struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
	UID  int    `json:"uid"`
	User string `json:"user"`
	Home string `json:"home"`
	// Tmux and Git are whether each is there (tmux in ~/.local/bin counts).
	Tmux bool `json:"tmux"`
	Git  bool `json:"git"`
	// Manager is the package manager found: apt-get, dnf, yum, pacman,
	// zypper, apk or brew; empty when none.
	Manager string `json:"manager,omitempty"`
	// Linger is loginctl's answer for the user: yes, no, or empty where
	// there is no loginctl (a Mac).
	Linger string `json:"linger,omitempty"`
	// Sudo is whether sudo is there; SudoNoPassword whether it asks for
	// nothing.
	Sudo           bool `json:"sudo"`
	SudoNoPassword bool `json:"sudo_nopasswd"`
	// Agents are the agent CLIs already there, by id.
	Agents map[string]bool `json:"agents,omitempty"`
	// Berthd is the berthd already in ~/.local/bin, by version; empty
	// when there is none.
	Berthd string `json:"berthd,omitempty"`
	// Tailnet is whether the box has a tailnet (Tailscale) address, where
	// berthd listens unless told otherwise.
	Tailnet bool `json:"tailnet"`
	// Listen is where an installed berthd's service listens, when there
	// is one; --keep-listen keeps it.
	Listen string `json:"listen,omitempty"`
}

// ProbeScript prints what ParseProbe reads, one "key value" line each. It
// runs over SSH with no terminal and changes nothing.
const ProbeScript = `B="$HOME/.local/bin"
printf 'os %s\narch %s\nuid %s\nuser %s\nhome %s\n' "$(uname -s)" "$(uname -m)" "$(id -u)" "$(id -un)" "$HOME"
if command -v tmux >/dev/null 2>&1 || [ -x "$B/tmux" ]; then echo 'tmux yes'; fi
if command -v git >/dev/null 2>&1; then echo 'git yes'; fi
for m in apt-get dnf yum pacman zypper apk brew; do
  if command -v "$m" >/dev/null 2>&1; then echo "manager $m"; break; fi
done
if command -v loginctl >/dev/null 2>&1; then
  l=$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null | sed 's/^Linger=//')
  echo "linger ${l:-no}"
fi
if command -v sudo >/dev/null 2>&1; then
  echo 'sudo yes'
  if sudo -n true >/dev/null 2>&1; then echo 'sudo_nopasswd yes'; fi
fi
# An agent counts wherever an installer puts it, npm's under nvm, fnm,
# volta or bun too: SSH's shell reads no ~/.bashrc, where nvm lives.
for a in claude codex cursor-agent opencode grok gemini; do
  if command -v "$a" >/dev/null 2>&1 || [ -x "$B/$a" ] || { [ "$a" = opencode ] && [ -x "$HOME/.opencode/bin/opencode" ]; } || { [ "$a" = grok ] && [ -x "$HOME/.grok/bin/grok" ]; }; then echo "agent $a"; continue; fi
  for p in "$HOME"/.nvm/versions/node/*/bin/"$a" "$HOME"/.local/share/fnm/aliases/default/bin/"$a" "$HOME/.volta/bin/$a" "$HOME/.bun/bin/$a" "$HOME/.npm-global/bin/$a" "/usr/local/bin/$a" "/opt/homebrew/bin/$a"; do
    if [ -x "$p" ]; then echo "agent $a"; break; fi
  done
done
if [ -x "$B/berthd" ]; then
  echo "berthd $("$B/berthd" version 2>/dev/null | cut -d' ' -f2)"
  l=$("$B/berthd" install --dry-run --keep-listen --no-tools 2>/dev/null | sed -n 's/^listen //p')
  case $l in none* | "") ;; *) echo "listen $l" ;; esac
fi
if { ip -4 -o addr 2>/dev/null || ifconfig 2>/dev/null; } | grep -Eq 'inet 100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'; then echo 'tailnet yes'; fi
`

// ParseProbe reads ProbeScript's output.
func ParseProbe(out string) (Probe, error) {
	p := Probe{Agents: map[string]bool{}, UID: -1}
	for _, line := range strings.Split(out, "\n") {
		k, v, _ := strings.Cut(strings.TrimSpace(line), " ")
		v = strings.TrimSpace(v)
		switch k {
		case "os":
			p.OS = strings.ToLower(v)
		case "arch":
			p.Arch = map[string]string{"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}[strings.ToLower(v)]
		case "uid":
			if n, err := strconv.Atoi(v); err == nil {
				p.UID = n
			}
		case "user":
			p.User = v
		case "home":
			p.Home = v
		case "tmux":
			p.Tmux = true
		case "git":
			p.Git = true
		case "manager":
			p.Manager = v
		case "linger":
			p.Linger = v
		case "sudo":
			p.Sudo = true
		case "sudo_nopasswd":
			p.SudoNoPassword = true
		case "agent":
			for _, a := range agentcli.Catalog {
				if a.Command == v {
					p.Agents[a.ID] = true
				}
			}
		case "berthd":
			p.Berthd = v
		case "tailnet":
			p.Tailnet = true
		case "listen":
			p.Listen = v
		}
	}
	if p.OS == "" || p.UID < 0 {
		return p, fmt.Errorf("could not read what is on the box")
	}
	if p.OS != "linux" && p.OS != "darwin" {
		return p, fmt.Errorf("berthd runs on Linux and macOS, not %s", p.OS)
	}
	if p.Arch == "" {
		return p, fmt.Errorf("berthd is built for amd64 and arm64; this box is neither")
	}
	return p, nil
}

// Step is one step of the plan.
type Step struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Detail is one sentence on what it does and why.
	Detail string `json:"detail,omitempty"`
	// Sudo marks a step that asks for the person's password; When, if
	// set, says when it does ("only if git is missing").
	Sudo bool   `json:"sudo,omitempty"`
	When string `json:"when,omitempty"`
	// Where is "laptop" or "box".
	Where string `json:"where"`
	// Commands are what runs, exactly, one per line.
	Commands []string `json:"commands"`
	// Skip, when set, says why the step has nothing to do.
	Skip string `json:"skip,omitempty"`
}

// PackageSteps are the commands that install pkgs with a package manager,
// each an argv to run as root, except Homebrew's (brew reports true).
func PackageSteps(manager string, pkgs []string) (steps [][]string, brew bool) {
	switch manager {
	case "apt-get":
		return [][]string{{"apt-get", "update", "-q"}, append([]string{"apt-get", "install", "-y", "-q"}, pkgs...)}, false
	case "dnf":
		return [][]string{append([]string{"dnf", "install", "-y"}, pkgs...)}, false
	case "yum":
		return [][]string{append([]string{"yum", "install", "-y"}, pkgs...)}, false
	case "pacman":
		return [][]string{append([]string{"pacman", "-S", "--noconfirm", "--needed"}, pkgs...)}, false
	case "zypper":
		return [][]string{append([]string{"zypper", "--non-interactive", "install"}, pkgs...)}, false
	case "apk":
		return [][]string{append([]string{"apk", "add"}, pkgs...)}, false
	case "brew":
		return [][]string{append([]string{"brew", "install"}, pkgs...)}, true
	}
	return nil, false
}

// CommandLines are steps as lines to type: sudo where they need root.
func CommandLines(steps [][]string, brew bool) []string {
	var out []string
	for _, s := range steps {
		line := strings.Join(s, " ")
		if !brew {
			line = "sudo " + line
		}
		out = append(out, line)
	}
	return out
}

// toolsNeed is what the tools step installs on a probed box: tmux from
// Shipyard's own build where it can, everything else with the package
// manager.
func toolsNeed(o Options, p Probe) (upload bool, pkgs []string) {
	if !p.Tmux {
		if o.BundledTmux && p.OS == "linux" {
			upload = true
		} else {
			pkgs = append(pkgs, "tmux")
		}
	}
	if !p.Git {
		pkgs = append(pkgs, "git")
	}
	return upload, pkgs
}

// TmuxName is Shipyard's tmux for a Linux box's architecture.
func TmuxName(arch string) string { return "tmux-linux-" + arch }

// Plan is what will run. With probe nil (before connecting, as the app's
// first screen shows it) steps that depend on the box say when they run.
func Plan(o Options, p *Probe) []Step {
	host := o.Target
	user := ""
	if i := strings.LastIndex(host, "@"); i >= 0 {
		user, host = host[:i], host[i+1:]
	}
	arch, osName := "amd64", "linux"
	if p != nil {
		arch, osName = p.Arch, p.OS
		if user == "" {
			user = p.User
		}
	}
	if user == "" {
		user = "$USER"
	}
	daemon := "berthd-" + osName + "-" + arch
	if p == nil {
		daemon = "berthd-linux-<arch>"
	}
	steps := []Step{{
		ID: StepConnect, Title: "Connect to " + o.Target, Where: "laptop",
		Detail:   "Over SSH, with your own keys and agent, this once. After this Shipyard never needs SSH for the box.",
		Commands: []string{"ssh " + o.Target},
	}}

	install := "~/.local/bin/berthd install --no-tools --no-integrations"
	if o.Listen != "" {
		install += " --listen " + shellQuote(o.Listen)
	} else {
		install += " --keep-listen"
	}
	berthd := Step{ID: StepBerthd, Title: "Install berthd", Where: "box",
		Detail:   "Shipyard's daemon, in ~/.local/bin, running as your own user service. No root.",
		Commands: []string{"upload " + daemon + " → ~/.local/bin/berthd", install}}
	if p != nil && p.OS == "darwin" {
		berthd.Detail = "Shipyard's daemon, in ~/.local/bin, running as your launch agent. No root."
	}
	steps = append(steps, berthd)

	linger := Step{ID: StepLinger, Title: "Keep berthd running after you log out", Where: "box", Sudo: true,
		Detail:   "systemd stops a user's services at logout unless lingering is on for them. Many boxes let you turn it on yourself; others need root.",
		Commands: []string{"loginctl enable-linger " + user + "   (no sudo, where the box allows it)", "sudo loginctl enable-linger " + user + "   (otherwise)"}}
	switch {
	case p == nil:
		linger.When = "only if the box needs root for it"
		steps = append(steps, linger)
	case p.OS == "linux" && p.Linger != "yes":
		steps = append(steps, linger)
	}

	tools := Step{ID: StepTools, Title: "tmux and git", Where: "box",
		Detail: "Every terminal and agent runs in tmux, and worktrees are git's."}
	if p == nil {
		tmuxLine := "upload Shipyard's tmux (tmux-linux-<arch>) → ~/.local/bin/tmux"
		if !o.BundledTmux {
			tmuxLine = "sudo <package manager> install tmux"
		}
		tools.Commands = []string{tmuxLine + "   (only if tmux is missing)", "sudo apt-get install -y -q git   (or dnf, pacman…; only if git is missing)"}
		tools.Sudo, tools.When = true, "only if git is missing"
		if !o.BundledTmux {
			tools.When = "only if tmux or git is missing"
		}
	} else {
		upload, pkgs := toolsNeed(o, *p)
		if upload {
			tools.Commands = append(tools.Commands, "upload "+TmuxName(p.Arch)+" → ~/.local/bin/tmux   (Shipyard's own build: no sudo)")
		}
		if len(pkgs) > 0 {
			ps, brew := PackageSteps(p.Manager, pkgs)
			if ps == nil {
				tools.Commands = append(tools.Commands, "install "+strings.Join(pkgs, " and ")+" with your package manager (Shipyard knows none on this box)")
			} else {
				tools.Commands = append(tools.Commands, CommandLines(ps, brew)...)
				tools.Sudo = !brew && !(p.UID == 0)
			}
		}
		if !upload && len(pkgs) == 0 {
			tools.Skip = "tmux and git are already there"
			tools.Commands = []string{"(nothing to install)"}
		}
	}
	steps = append(steps, tools)

	if len(o.Agents) > 0 {
		ag := Step{ID: StepAgents, Title: agentcli.Names(o.Agents), Where: "box",
			Detail:   "Into ~/.local/bin, without sudo. Signing in stays yours: each agent asks the first time it starts.",
			Commands: []string{"~/.local/bin/berthd agents install " + strings.Join(o.Agents, " ")}}
		var missing []string
		for _, id := range o.Agents {
			a, _ := agentcli.ByID(id)
			if p != nil && p.Agents[id] {
				ag.Commands = append(ag.Commands, "  "+a.Name+": already installed")
				continue
			}
			missing = append(missing, id)
			line := "  " + a.Name + ": " + a.Install
			if id == "codex" && p != nil {
				line = "  Codex: " + agentcli.CodexURL(p.OS, p.Arch) + " → ~/.local/bin/codex (sha256 checked)"
			}
			ag.Commands = append(ag.Commands, line)
		}
		if p != nil && len(missing) == 0 {
			ag.Skip = "already installed"
		}
		steps = append(steps, ag)
	}

	if !o.NoIntegrations {
		in := Step{ID: StepIntegrations, Title: "Agent integrations", Where: "box",
			Detail:   "Hooks that tell Shipyard when an agent is working, done or needs you, and Shipyard's skills.",
			Commands: []string{"~/.local/bin/berthd integrations install present"}}
		steps = append(steps, in)
	}

	pair := "~/.local/bin/berthd pair"
	if o.Address != "" {
		pair += " --address " + shellQuote(o.Address)
	}
	steps = append(steps, Step{ID: StepPair, Title: "Pair with this computer", Where: "laptop",
		Detail:   "The laptop and the box pin each other's keys; from then on they talk directly.",
		Commands: []string{pair, "berth pair <the link it prints>"}})
	return steps
}

// SudoSteps lists the titles of steps that ask for a password.
func SudoSteps(steps []Step) []string {
	var out []string
	for _, s := range steps {
		if s.Sudo && s.Skip == "" {
			out = append(out, s.Title)
		}
	}
	return out
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
