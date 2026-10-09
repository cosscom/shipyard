package box

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/cosscom/shipyard/internal/groups"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/terminal"
)

// Session is a long-running program, usually a coding agent, started at a
// location on the box. It keeps running when no one is attached.
type Session struct {
	Name     string    `json:"name"`
	Location string    `json:"location,omitempty"`
	Dir      string    `json:"dir"`
	Command  string    `json:"command,omitempty"`
	Created  time.Time `json:"created"`
	Attached int       `json:"attached"`
	Exited   bool      `json:"exited"`
	// Agent is the coding agent the command runs, if any, and AgentState
	// what its hooks said last: idle, running, waiting, or finished.
	Agent      string    `json:"agent,omitempty"`
	AgentState string    `json:"agent_state,omitempty"`
	StateSince time.Time `json:"state_since,omitzero"`
	// Preset is the agent preset the session was started with, which berth
	// keeps (@berth_agent) so a wrapped command is still known as an agent.
	Preset string `json:"preset,omitempty"`
	// Turn is the agent's current (or last) turn, StateSeq the journal Seq
	// of its state, and Fidelity how well berth knows it: hooks, partial or
	// screen.
	Turn     string `json:"turn,omitempty"`
	StateSeq int64  `json:"state_seq,omitempty"`
	Fidelity string `json:"fidelity,omitempty"`
	// Title names the work: the first line of the prompt it started with
	// (or the first one it was sent), or what someone renamed it to. Kept
	// as @berth_title; empty until there is one.
	Title string `json:"title,omitempty"`
	// Queued is how many prompts the box holds for the agent until it is
	// idle (GET .../queue lists them); Ask is what it waits on, from its
	// hooks, when they said.
	Queued int  `json:"queued,omitempty"`
	Ask    *Ask `json:"ask,omitempty"`
	// Service is set on a worktree service's own terminal (a service with
	// "terminal": true): the service's name, kept as @berth_service. It is
	// never an agent, whatever it runs.
	Service string `json:"service,omitempty"`
	// Scope is the systemd scope unit its program runs in (@berth_scope),
	// on boxes where sessions get one; Usage what its processes use, in
	// the session list.
	Scope string     `json:"scope,omitempty"`
	Usage *ProcUsage `json:"usage,omitempty"`

	// commandFile is where the session's command is kept, when it is;
	// panePID the process its pane runs.
	commandFile string
	panePID     int
}

var (
	ErrUnknownSession = errors.New("no session with that name")
	ErrSessionExists  = errors.New("a session with that name already exists")
	sessionName       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)
)

// Sessions runs programs in berth's own tmux server, separate from any tmux
// the user runs. Finished programs stay visible until killed, so an agent's
// last output is never lost.
type Sessions struct {
	// Config is the tmux configuration file for berth's server.
	Config string
	// Commands is the folder that keeps each session's command in a file
	// of its own (NAME.cmd). A command carries the agent's prompt, which
	// can be any length, and tmux refuses a command line (or an option)
	// longer than about 16 KB, so neither ever holds it: the pane runs the
	// file and the session points to it (@berth_command_file).
	Commands string
	// Ended, when set, hears that berth stopped a session, so what the
	// session left running (agent-browser's browsers) can go too.
	Ended func()
	// Reap, when set, closes the agent-browser sessions a session that
	// berth ended started, their own way, before the rest of what it
	// started is stopped.
	Reap func(ctx context.Context, session string)
	// Scopes, when set, gives each new session a systemd scope of its own
	// (scopes.go); MemoryHigh is the ceiling a new scope gets (0: none).
	Scopes     scopeManager
	MemoryHigh func() uint64
	// trace, in tests, sees every tmux command line.
	trace func(args []string)
	// procs and signal stand in for the system in tests.
	procs   func() ([]procStat, error)
	signal  func(pid int, sig syscall.Signal)
	cleanup sync.WaitGroup

	sweepMu   sync.Mutex
	lastSweep time.Time

	// envs keeps what EnvVar read: a session's environment is set when it
	// starts and never changes.
	envs sync.Map

	// Prepare, when set, sees a new session's environment before its
	// program starts: berthd installs berth's hooks and skills in an agent
	// account folder it picks (Box.PrepareAccounts).
	Prepare func(env []string)
}

// EnvVar is the value key had in session sess's environment when it
// started ("" when it had none), as its agent sees it: the account folder
// a session was started on (CLAUDE_CONFIG_DIR, CODEX_HOME), say.
func (s *Sessions) EnvVar(ctx context.Context, sess Session, key string) string {
	cacheKey := sess.Name + "\x00" + sess.Created.Format(time.RFC3339Nano) + "\x00" + key
	if v, ok := s.envs.Load(cacheKey); ok {
		return v.(string)
	}
	out, err := s.tmux(ctx, "show-environment", "-t", "="+sess.Name, key)
	if err != nil {
		// Unset is remembered too: it is the usual answer (no account
		// folder of its own), and every chat's poll asks it again for
		// each agent in the folder. A session that is gone, or a tmux
		// that failed, leaves nothing to remember.
		if strings.Contains(string(out), "unknown variable") {
			s.envs.Store(cacheKey, "")
		}
		return ""
	}
	v, ok := strings.CutPrefix(strings.TrimSpace(string(out)), key+"=")
	if !ok {
		v = "" // "-KEY": removed from the session's environment
	}
	s.envs.Store(cacheKey, v)
	return v
}

const tmuxSocket = "berth"

// tmuxConfig is berth's own tmux server's. The status line is off because
// the app draws its own chrome around every terminal; focus events pass
// through so agents know when their pane is in front.
const tmuxConfig = `set -g remain-on-exit on
set -g history-limit 50000
set -g mouse on
set -g default-terminal "tmux-256color"
set -g status off
set -g focus-events on
`

func NewSessions(dir string) (*Sessions, error) {
	path := filepath.Join(dir, "tmux.conf")
	s := &Sessions{Config: path, Commands: filepath.Join(dir, "commands")}
	if b, err := os.ReadFile(path); err != nil || string(b) != tmuxConfig {
		if err := statefile.Write(path, []byte(tmuxConfig)); err != nil {
			return nil, err
		}
		// A server still running from an older build reads the change now;
		// without one, this fails and the next server reads the file.
		s.tmux(context.Background(), "source-file", path)
	}
	// Commands of sessions that ended while the box was down go now.
	s.sweepCommands(context.Background(), 0)
	return s, nil
}

// tmux runs a command in berth's tmux server. Its error says why it failed
// (an exit status, a timeout, errTmuxMissing); tmux's own words are in out.
func (s *Sessions) tmux(ctx context.Context, args ...string) ([]byte, error) {
	cmd, cctx, cancel, err := s.tmuxCommand(ctx, args...)
	if err != nil {
		return nil, err
	}
	defer cancel()
	return runTmux(ctx, cctx, cmd)
}

// The command is also kept base64-encoded (@berth_command64): some tmux
// versions (3.4, say) escape "$" when a format reads an option back, so the
// plain @berth_command would come back changed. Sessions started before it
// existed only have the plain one, so only they print it: a command carries
// its prompt, and a prompt's line breaks or tabs printed here would split
// the session's line, and the session would vanish from the list.
//
// Sessions started since keep their command in a file (@berth_command_file)
// and only its start in @berth_command, for older builds to show.
const listFormat = "#{session_name}\t#{session_created}\t#{session_attached}\t#{@berth_location}\t#{?@berth_command64,,#{@berth_command}}\t#{pane_dead}\t#{pane_start_path}\t#{@berth_command64}\t#{@berth_agent}\t#{@berth_title}\t#{@berth_service}\t#{@berth_command_file}\t#{@berth_scope}\t#{pane_pid}"

// plainCommandMax is how much of a command the plain @berth_command keeps.
const plainCommandMax = 1024

// plainCommand is the command as the plain @berth_command keeps it, for
// builds that read only that: on one line, as a session list needs it, and
// short, as a tmux option must be.
func plainCommand(command string) string {
	if len(command) > plainCommandMax {
		cut := plainCommandMax
		for cut > 0 && !utf8.RuneStart(command[cut]) {
			cut--
		}
		command = command[:cut]
	}
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, command)
}

func (s *Sessions) List(ctx context.Context) ([]Session, error) {
	all, err := s.list(ctx)
	if err == nil {
		s.maybeSweep(ctx)
	}
	return all, err
}

func (s *Sessions) list(ctx context.Context) ([]Session, error) {
	out, err := s.tmux(ctx, "list-sessions", "-F", listFormat)
	if err != nil {
		// No server yet simply means no sessions.
		if strings.Contains(string(out), "no server running") || strings.Contains(string(out), "error connecting") {
			return []Session{}, nil
		}
		return nil, tmuxError("list-sessions", out, err)
	}
	all := parseSessions(out)
	for i := range all {
		if all[i].commandFile == "" {
			continue
		}
		if command, err := readCommand(all[i].commandFile); err == nil {
			all[i].Command = command
		}
	}
	return all, nil
}

func parseSessions(out []byte) []Session {
	sessions := []Session{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, "\t")
		for len(f) >= 7 && len(f) < 14 {
			f = append(f, "")
		}
		if len(f) != 14 {
			continue
		}
		command := f[4]
		if f[7] != "" {
			if raw, err := base64.StdEncoding.DecodeString(f[7]); err == nil {
				command = string(raw)
			}
		}
		created, _ := strconv.ParseInt(f[1], 10, 64)
		attached, _ := strconv.Atoi(f[2])
		panePID, _ := strconv.Atoi(f[13])
		sessions = append(sessions, Session{
			Name:     f[0],
			Created:  time.Unix(created, 0).UTC(),
			Attached: attached,
			Location: f[3],
			Command:  command,
			Exited:   f[5] == "1",
			Dir:      f[6],
			Preset:   f[8],
			Title:    f[9],
			Service:  f[10],
			Scope:    f[12],

			commandFile: f[11],
			panePID:     panePID,
		})
	}
	return sessions
}

// Create starts command in dir. An empty command starts the user's shell.
// Commands run through a login shell, so tools the user installed (claude,
// codex) are on PATH even when berthd runs under systemd.
func (s *Sessions) Create(ctx context.Context, name, location, dir, command string, env []string) (Session, error) {
	return s.create(ctx, name, location, dir, command, "", env, nil)
}

// create is Create with the pane's program run behind wrap, a command that
// replaces itself with it (`berthd secret exec … --`). The session's command,
// which says which agent runs in it, stays the one asked for.
//
// Every session gets BERTH_SESSION (its name) and, for an agent preset,
// BERTH_AGENT, so the agent's hooks can say which session they come from,
// and agent-browser's idle timeout unless env or berthd's own environment
// sets it.
func (s *Sessions) create(ctx context.Context, name, location, dir, command, agent string, env, wrap []string) (Session, error) {
	if !sessionName.MatchString(name) {
		return Session{}, fmt.Errorf("invalid session name %q: use letters, digits, - and _", name)
	}
	if _, err := tmuxPath(); err != nil {
		return Session{}, err
	}
	if _, err := s.tmux(ctx, "has-session", "-t", "="+name); err == nil {
		return Session{}, ErrSessionExists
	}
	shell := sessionShell()
	argv := []string{shell, "-l"}
	file := ""
	if command != "" {
		var err error
		if file, err = s.writeCommand(name, command); err != nil {
			return Session{}, err
		}
		// An agent starts with the PATH its CLI was found with: an npm
		// install under nvm is on an interactive shell's PATH, which a
		// login shell alone (-l) never reads.
		argv = []string{shell, "-lc", withPATH(shell, launchPATH(command, agent), sourceCommand(shell, file))}
	}
	if s.Prepare != nil {
		s.Prepare(env)
	}
	args := []string{"new-session", "-d", "-s", name, "-c", dir, "-x", "200", "-y", "50"}
	env = append(withAgentBrowserIdle(append([]string(nil), env...)), "BERTH_SESSION="+name)
	if agent != "" {
		env = append(env, "BERTH_AGENT="+agent)
	}
	for _, kv := range env {
		args = append(args, "-e", kv)
	}
	// A new session's program runs in a scope of its own, where the box
	// has them, so it and everything it starts can be stopped together.
	scope := ""
	var scopeArgs []string
	if s.Scopes != nil && s.Scopes.Available(ctx) {
		scope = scopeUnit(name, time.Now())
		scopeArgs = s.Scopes.Wrap(scope, "Shipyard session "+name, s.memoryHigh())
		// systemd-run finds the user's manager by these.
		for _, k := range []string{"XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} {
			if v := os.Getenv(k); v != "" {
				args = append(args, "-e", k+"="+v)
			}
		}
	}
	// A group the user joined since berthd started (docker, say) is given
	// to the new session through sg.
	args = append(append(append(args, "--"), scopeArgs...), groups.Wrap(append(append([]string(nil), wrap...), argv...))...)
	// The labels are set in the same tmux command that makes the session,
	// so no list sees it without them. set-option takes a pane target,
	// whose exact-match form needs the colon.
	target := "=" + name + ":"
	set := func(k, v string) {
		args = append(args, ";", "set-option", "-t", target, k, v)
	}
	set("@berth_location", location)
	set("@berth_command", plainCommand(command))
	if file != "" {
		set("@berth_command_file", file)
	}
	if agent != "" {
		set("@berth_agent", agent)
	}
	if scope != "" {
		set("@berth_scope", scope)
	}
	for i, a := range args {
		if a != ";" {
			args[i] = tmuxArg(a)
		}
	}
	if out, err := s.tmux(ctx, args...); err != nil {
		s.tmux(ctx, "kill-session", "-t", "="+name)
		s.removeCommand(name)
		return Session{}, tmuxError("new-session", out, err)
	}
	sess, err := s.Get(ctx, name)
	if err != nil {
		// A session it can't read back would run on unseen, and a task
		// removes its worktree when this fails: stop it too.
		s.tmux(ctx, "kill-session", "-t", "="+name)
		s.removeCommand(name)
		if errors.Is(err, ErrUnknownSession) {
			// It ended at once, as tmux can when its program can't start.
			return Session{}, fmt.Errorf("tmux new-session: the session ended as soon as it started: %w", err)
		}
		return Session{}, err
	}
	return sess, nil
}

// sessionShell is the shell a session runs in.
func sessionShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/sh"
}

// TitleMax is the longest title a session takes, in characters; one made
// from a prompt is shorter (adapters.TitleMax).
const TitleMax = 80

// SetTitle names a session's work; an empty title clears it.
func (s *Sessions) SetTitle(ctx context.Context, name, title string) error {
	if _, err := s.Get(ctx, name); err != nil {
		return err
	}
	title = adapters.Clip(title, TitleMax)
	args := []string{"set-option", "-t", "=" + name + ":", "@berth_title", title}
	if title == "" {
		args = []string{"set-option", "-u", "-t", "=" + name + ":", "@berth_title"}
	}
	if out, err := s.tmux(ctx, args...); err != nil {
		return tmuxError("set-option", out, err)
	}
	return nil
}

func (s *Sessions) Get(ctx context.Context, name string) (Session, error) {
	sess, _, err := s.getWithAll(ctx, name)
	return sess, err
}

// getWithAll is Get that also returns every session it listed, for a
// caller that needs the others too without asking tmux again.
func (s *Sessions) getWithAll(ctx context.Context, name string) (Session, []Session, error) {
	all, err := s.List(ctx)
	if err != nil {
		return Session{}, nil, err
	}
	for _, sess := range all {
		if sess.Name == name {
			return sess, all, nil
		}
	}
	return Session{}, nil, ErrUnknownSession
}

// Kill ends a session and, in the background, everything it started
// (scopes.go).
func (s *Sessions) Kill(ctx context.Context, name string) error {
	sess, err := s.Get(ctx, name)
	if err != nil {
		return err
	}
	// What runs in its panes is found before they go, while it is still
	// their descendant.
	at := time.Now()
	var found []procStat
	if ps, err := s.snapshot(); err == nil {
		found = sessionProcs(ps, name, s.panePIDs(ctx, name), tmuxSocketPath(), at, useMarkers)
	}
	if out, err := s.tmux(ctx, "kill-session", "-t", "="+name); err != nil {
		return tmuxError("kill-session", out, err)
	}
	s.removeCommand(name)
	s.cleanup.Add(1)
	go func() {
		defer s.cleanup.Done()
		s.endSession(sess, found, at)
	}()
	if s.Ended != nil {
		s.Ended()
	}
	return nil
}

// Attach runs a tmux client for the session under a new pseudo-terminal. The
// caller relays the returned master to the laptop; closing it detaches.
func (s *Sessions) Attach(ctx context.Context, name string, cols, rows int) (*os.File, *exec.Cmd, error) {
	if _, err := s.Get(ctx, name); err != nil {
		return nil, nil, err
	}
	bin, err := tmuxPath()
	if err != nil {
		return nil, nil, err
	}
	cmd := exec.CommandContext(ctx, bin, "-u", "-L", tmuxSocket, "-f", s.Config, "attach-session", "-t", "="+name)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	master, err := terminal.Start(cmd, cols, rows)
	if err != nil {
		return nil, nil, err
	}
	return master, cmd, nil
}

// Screen returns what the session shows, plus up to history earlier lines,
// so tools can read an agent's output without attaching.
func (s *Sessions) Screen(ctx context.Context, name string, history int) (string, error) {
	if _, err := s.Get(ctx, name); err != nil {
		return "", err
	}
	return s.capture(ctx, name, history)
}

// capture is Screen for a session the caller has just found in a list:
// without asking tmux for the list again.
func (s *Sessions) capture(ctx context.Context, name string, history int) (string, error) {
	out, err := s.tmux(ctx, "capture-pane", "-p", "-J", "-t", "="+name+":", "-S", "-"+strconv.Itoa(max(history, 0)))
	if err != nil {
		return "", tmuxError("capture-pane", out, err)
	}
	return strings.TrimRight(string(out), "\n") + "\n", nil
}

// getAndCapture is Get and a capture-pane of the session's pane (with
// args, such as -e) in one tmux command rather than two: display-message
// prints the session's line as list-sessions would, then capture-pane its
// pane. A session that is gone, or a tmux that answers otherwise, is
// asked again the long way, so its error is Get's.
func (s *Sessions) getAndCapture(ctx context.Context, name string, args ...string) (Session, []byte, error) {
	target := "=" + name + ":"
	cmd := append([]string{"display-message", "-p", "-t", target, listFormat, ";", "capture-pane", "-p"}, args...)
	out, err := s.tmux(ctx, append(cmd, "-t", target)...)
	if err == nil {
		if line, rest, ok := bytes.Cut(out, []byte("\n")); ok {
			if all := parseSessions(line); len(all) == 1 && all[0].Name == name {
				sess := all[0]
				if sess.commandFile != "" {
					if command, err := readCommand(sess.commandFile); err == nil {
						sess.Command = command
					}
				}
				return sess, rest, nil
			}
		}
	}
	sess, err := s.Get(ctx, name)
	if err != nil {
		return Session{}, nil, err
	}
	out, err = s.tmux(ctx, append(append([]string{"capture-pane", "-p"}, args...), "-t", target)...)
	if err != nil {
		return sess, out, tmuxError("capture-pane", out, err)
	}
	return sess, out, nil
}
