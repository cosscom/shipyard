package box

import (
	"context"
	"maps"
	"regexp"
	"slices"
	"strings"
)

// A session's own environment: variables one task or session is started
// with (`berthd task new --env K=V`), over the box's (env.json) and the
// project's (.berth/config.json). They are taken as given, never expanded,
// and last as long as the session, through a switch between its terminal
// and the chat.

// labelOwnEnv names the variables a session was started with of its own,
// so running it again in its pane (switch.go) keeps them over the
// project's: only their names, as the values are in the session's tmux
// environment.
const labelOwnEnv = "@berth_env"

// berthdVars are the variables berthd sets on a session to say where it is
// and who it is (repoconfig.go, sessions.go, the drivers), and those that
// say where berthd keeps its state and which op it trusts with the box's
// 1Password session (statefile, secrets.go), which `berthd secret exec`
// reads in the session: none a session can set itself. BERTH_PORT_1, _2, …
// are berthd's too.
var berthdVars = map[string]bool{
	"BERTH_HOME": true, "BERTH_USER_DIR": true, "BERTH_OP": true,
	"BERTH_BOX": true, "BERTH_LOCATION": true, "BERTH_ROOT_PATH": true,
	"BERTH_WORKTREE_PATH": true, "BERTH_WORKTREE_NAME": true, "BERTH_WORKTREE_SLUG": true,
	"BERTH_BRANCH": true, "BERTH_KIT_DIR": true, "BERTH_URL": true, "BERTH_PORT": true,
	"BERTH_BROWSER_PROXY": true, "PLAYWRIGHT_MCP_PROXY_SERVER": true, "PLAYWRIGHT_MCP_PROXY_BYPASS": true,
	"BERTH_REVIEW": true, "BERTH_REVIEW_REPO": true, "BERTH_REVIEW_SHA": true, "BERTH_WITHHELD": true,
	"BERTH_SESSION": true, "BERTH_AGENT": true, "BERTH_DRIVER": true, SecretVarsEnv: true,
}

var berthdPort = regexp.MustCompile(`^BERTH_PORT_[0-9]+$`)

// CheckSessionEnv says what is wrong with a session's own variables, if
// anything: each needs a name, a name berthd doesn't set, and a value an
// environment can hold.
func CheckSessionEnv(env map[string]string) error {
	for _, k := range slices.Sorted(maps.Keys(env)) {
		switch {
		case k == "":
			return badRequest("an environment variable needs a name: give KEY=VALUE")
		case !envName.MatchString(k):
			return badRequest("%q is not an environment variable name: use letters, digits and _, not starting with a digit", k)
		case berthdVars[k] || berthdPort.MatchString(k):
			return badRequest("%s is set by berthd for every session and can't be set for one", k)
		case strings.ContainsRune(env[k], 0):
			return badRequest("%s's value holds a NUL byte, which no environment can", k)
		}
	}
	return nil
}

// withoutVars is env without the variables named in names.
func withoutVars(env, names []string) []string {
	return slices.DeleteFunc(env, func(kv string) bool {
		k, _, _ := strings.Cut(kv, "=")
		return slices.Contains(names, k)
	})
}

// ownEnv names the variables session sess was started with of its own.
// Their values are in its tmux environment, which a pane run again there
// starts with.
func (b *Box) ownEnv(ctx context.Context, sess Session) []string {
	v, err := b.Sessions.tmux(ctx, "show-options", "-v", "-q", "-t", "="+sess.Name+":", labelOwnEnv)
	if names := strings.TrimSpace(string(v)); err == nil && names != "" {
		return strings.Split(names, ",")
	}
	return nil
}
