package box

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/integrations"
)

// Agent accounts: a box can have several Claude Code and Codex logins, each
// in a folder of its own that CLAUDE_CONFIG_DIR or CODEX_HOME picks, set in
// the box's env.json or a project's box-local config (the Usage plugin's
// "Use for new sessions"). berth's hooks and skills go in every one of them
// (integrations/accounts.go).

// ConfiguredAccountDirs are the account folders the box's environment file
// and the projects' box-local configs at locationsFile pick, by agent, as
// written there (integrations.ExpandAccountDir resolves ~ and $HOME). A
// secret reference is no folder and is left out.
func ConfiguredAccountDirs(envFile, locationsFile string) map[string][]string {
	out := map[string][]string{}
	add := func(env map[string]string) {
		for agent, name := range integrations.AccountVars {
			if v := env[name]; v != "" && !IsSecretRef(v) {
				out[agent] = append(out[agent], v)
			}
		}
	}
	if e, err := loadBoxEnv(envFile); err == nil {
		add(e.Env)
	}
	if locationsFile != "" {
		saved, _ := NewLocations(locationsFile).read()
		for _, l := range saved {
			if l.Config != nil {
				add(l.Config.Env)
			}
		}
	}
	return out
}

// PrepareAccounts gives the account folders a new session's environment
// picks berth's integrations before its agent starts, when they lack them
// (integrations.EnsureAccounts: a file read when they are there). berthd
// sets it as its Sessions' Prepare.
func (b *Box) PrepareAccounts(env []string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	self, err := b.self()
	if err != nil {
		return
	}
	done, _ := integrations.EnsureAccounts(home, self, env)
	for _, a := range done {
		if b.Events != nil {
			b.Events.Publish(events.Event{Type: "integrations.installed", Box: b.Name, Origin: "berth", Data: map[string]any{"tool": a.Agent, "account": a.Dir}})
		}
	}
}

// labelAccount keeps the value of a session's account variable
// (CLAUDE_CONFIG_DIR, CODEX_HOME) as its agent was last started with it, so
// the session list says which account it spends: the tmux environment only
// says how the session first started, and an agent started again in its
// pane (switch.go, conversations.go) gets the account the box picks now.
// Unset, the tmux environment still decides. The value is kept after an
// "=" (accountLabel), so one set empty is told from none, and none is ever
// a bare ";", which tmux reads as the end of a command.
const labelAccount = "@berth_account"

func accountLabel(v string) string { return "=" + v }

// accountVar is the value agent's account variable has in env, as tmux
// gets it (a later one wins), and whether env sets it. One with a line
// break or tab in it is no folder, and would split the session's line in
// the list: it counts as unset.
func accountVar(agent string, env []string) (v string, set bool) {
	name, ok := integrations.AccountVars[agent]
	if !ok {
		return "", false
	}
	for _, kv := range env {
		if k, val, _ := strings.Cut(kv, "="); k == name {
			v, set = val, true
		}
	}
	if strings.ContainsAny(v, "\t\n\r") {
		return "", false
	}
	return v, set
}

// sessionAccount is the account s's agent runs on: by the value its
// account variable had when the agent last started, or, when berthd didn't
// start it with one, what its tmux environment says. It is nil for an
// agent without accounts and whenever berthd can't tell (a secret
// reference, tmux failing): never a guess.
func (b *Box) sessionAccount(ctx context.Context, s Session) *SessionAccount {
	name, ok := integrations.AccountVars[s.Agent]
	if !ok {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	v, kept := strings.CutPrefix(s.account, "=")
	if !kept {
		if v, err = b.Sessions.envVar(ctx, s, name); err != nil {
			return nil
		}
	}
	if IsSecretRef(v) {
		return nil
	}
	dir := integrations.AccountDir(home, s.Agent, v)
	if dir == "" {
		return nil
	}
	return &SessionAccount{Agent: s.Agent, Name: integrations.AccountName(home, s.Agent, dir), Dir: dir, Count: b.accountCounts.count(home, s.Agent)}
}

// accountCounts keeps how many accounts each agent has on the box for a
// few seconds: sessions are listed on every poll, and by berthd's own
// checks (turns, the memory guard, waits) every few seconds, and counting
// reads folders and two config files.
type accountCounts struct {
	mu sync.Mutex
	at time.Time
	n  map[string]int
}

const accountCountTTL = 5 * time.Second

func (c *accountCounts) count(home, agent string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) > accountCountTTL {
		c.at, c.n = time.Now(), map[string]int{}
	}
	n, ok := c.n[agent]
	if !ok {
		n = integrations.AccountCount(home, agent)
		c.n[agent] = n
	}
	return n
}
