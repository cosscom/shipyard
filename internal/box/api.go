package box

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/doctor"
	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/terminal"
	"github.com/cosscom/shipyard/internal/wire"
)

// OriginHeader names the tool a request comes from, so the events it causes
// carry that origin and hooks driving the same tool skip them.
const OriginHeader = "X-Berth-Origin"

var validOrigin = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

type Box struct {
	Name      string
	Locations *Locations
	Sessions  *Sessions
	// AgentBrowsers closes the agent-browser sessions berth sessions
	// leave behind; nil leaves them alone.
	AgentBrowsers *AgentBrowsers
	Shares        *Shares
	// procSampler says how busy processes are, for GET /v1/processes.
	procSampler cpuSampler
	Events      *events.Bus
	// Watcher, when set, is told about berth's own worktree changes so it
	// does not announce them a second time.
	Watcher *Watcher
	// Update, when set, lets paired laptops upgrade the daemon in place.
	Update *SelfUpdate
	// DaemonChecks adds berthd's own checks to Doctor.
	DaemonChecks func() []doctor.Check
	// LogDir holds the logs of lifecycle scripts.
	LogDir string
	// Units runs berthd's managed units; nil where they cannot run.
	Units *Units
	// Turns is the turn ledger: what every agent session is doing, turn by
	// turn. Without it agents read as running.
	Turns *Turns
	// Hooks, when set, may refuse actions through "before:" hooks.
	Hooks *hooks.Runner
	// Flows runs the box's and its repositories' automations.
	Flows *Flows
	// KitsDir holds installed kits' files, one folder per location and kit.
	KitsDir string
	// EnvFile is the box's own environment for every worktree,
	// ~/.berth/env.json.
	EnvFile string
	// Paused remembers paused worktrees.
	Paused *PauseStore
	// Phone serves the phone app on the tailnet address, when turned on.
	Phone *Phone
	// Guard, when set, keeps the box usable when memory runs short.
	Guard *Guard
	// TurnCheck, when turned on, asks Jev whether a finished turn needs
	// you (turncheck.go).
	TurnCheck *TurnCheck
	// Secrets resolves secret references in worktree environments; nil
	// uses a shared one.
	Secrets *Secrets
	// Socket is the box's local API socket, which programs berthd starts can
	// report back through.
	Socket string
	// Invites, when set, lets paired laptops mint pairing codes for another
	// computer (berth invite).
	Invites *Invites
	// Runs executes durable runs (loops, attempts, flows); nil on a box
	// without them.
	Runs *runs.Engine
	// AutoFix keeps each worktree's "Auto-fix this PR" settings.
	AutoFix *AutoFixStore
	// Triggers keeps the secrets of flows started by a signed POST.
	Triggers *TriggerSecrets
	// BrowserProxies confine each worktree's browser to its own pages.
	BrowserProxies *BrowserProxies
	// ShotsDir keeps visual-diff baselines (`berthd shots`, shots.go).
	ShotsDir string
	// Browsers runs agents' headless browsers, one per active worktree.
	Browsers *Browsers
	// Reports tells an agent when work it started ends (notify.go).
	Reports *Notifier
	// Team runs team setups (team.go); nil on a box without them.
	Team *TeamRunner
	// Artifacts keeps what agents made for the person to look at
	// (artifacts.go); nil on a box without them.
	Artifacts *ArtifactStore
	// Reviews keeps the box's review settings (prreview.go); nil uses the
	// defaults.
	Reviews *ReviewStore
	// ReviewButtons adds the "Review in Shipyard" button to PRs opened from
	// worktrees of projects that turn it on (reviewbutton.go); nil on a box
	// without it.
	ReviewButtons *ReviewButtons
}

func (b *Box) own(path string) {
	if b.Watcher != nil {
		b.Watcher.Own(path)
	}
}

// Mount registers the box's routes on s. They are reachable by paired
// laptops and, through ServeLocal, by the box's own user.
func (b *Box) Mount(s *wire.Server) {
	route := func(pattern string, h func(http.ResponseWriter, *http.Request) error) {
		s.Handle(pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := h(w, r); err != nil {
				writeErr(w, err)
			}
		}))
	}
	route("GET /v1/ports", b.ports)
	route("GET /v1/locations", b.listLocations)
	route("POST /v1/locations", b.addLocation)
	route("DELETE /v1/locations/{name}", b.removeLocation)
	route("PUT /v1/locations/{name}/scripts", b.setScripts)
	route("POST /v1/locations/{name}/worktrees", b.addWorktree)
	route("POST /v1/locations/clone", b.cloneLocation)
	route("GET /v1/locations/{name}/review-setup", b.reviewSetup)
	route("GET /v1/reviews", b.listReviews)
	route("POST /v1/reviews", b.postReview)
	route("POST /v1/reviews/update", b.postReviewUpdate)
	route("GET /v1/reviews/settings", b.getReviewSettings)
	route("PUT /v1/reviews/settings", b.putReviewSettings)
	route("GET /v1/worktrees/{loc}/{wt}/review-button", b.getReviewButton)
	route("PUT /v1/worktrees/{loc}/{wt}/review-button", b.putReviewButton)
	route("GET /v1/team", b.listTeams)
	route("POST /v1/team", b.postTeam)
	route("GET /v1/team/{id}", b.getTeam)
	route("POST /v1/team/{id}/retry", b.retryTeam)
	route("POST /v1/team/{id}/onepassword", b.useOnePassword)
	route("GET /v1/team/{id}/existing", b.getExisting)
	route("POST /v1/team/{id}/pull", b.pullExisting)
	route("POST /v1/locations/new", b.newLocation)
	route("POST /v1/locations/{name}/resolve", b.resolve)
	route("GET /v1/locations/{name}/branches", b.listBranches)
	route("GET /v1/fs", b.listFolder)
	route("GET /v1/guard", b.getGuard)
	route("PUT /v1/guard", b.putGuard)
	route("GET /v1/flows", b.listFlows)
	route("PUT /v1/flows", b.putFlows)
	route("GET /v1/flows/runs", b.listFlowRuns)
	route("POST /v1/flows/{id}/test", b.testFlow)
	route("GET /v1/worktrees", b.listWorktreeStatuses)
	route("GET /v1/locations/{name}/worktrees/{worktree}/log", b.worktreeLog)
	route("POST /v1/locations/{name}/worktrees/{worktree}/sync", b.syncWorktree)
	route("POST /v1/locations/{name}/worktrees/{worktree}/attachments", b.worktreeAttachment)
	route("GET /v1/locations/{name}/worktrees/{worktree}/files", b.listWorktreeFiles)
	route("GET /v1/locations/{name}/worktrees/{worktree}/file", b.getWorktreeFile)
	route("PUT /v1/locations/{name}/worktrees/{worktree}/file", b.putWorktreeFile)
	route("GET /v1/locations/{name}/worktrees/{worktree}/touched", b.worktreeTouched)
	route("POST /v1/locations/{name}/worktrees/{worktree}/{action}", b.pauseAction)
	route("GET /v1/phone", b.getPhone)
	route("PUT /v1/phone", b.putPhone)
	route("GET /v1/turncheck", b.getTurnCheck)
	route("PUT /v1/turncheck", b.putTurnCheck)
	route("GET /v1/kits", b.listKits)
	route("PUT /v1/locations/{name}/kit", b.putKit)
	route("POST /v1/locations/{name}/team-kit", b.postTeamKit)
	route("DELETE /v1/locations/{name}/kit", b.deleteKit)
	route("GET /v1/env", b.getBoxEnv)
	route("PUT /v1/env", b.putBoxEnv)
	route("POST /v1/secrets/test", b.testSecret)
	route("POST /v1/secrets/report", b.reportSecrets)
	route("GET /v1/locations/{name}/config", b.getConfig)
	route("PUT /v1/locations/{name}/config", b.putConfig)
	route("POST /v1/locations/{name}/config/trust", b.trustRepoConfig)
	route("DELETE /v1/locations/{name}/config/trust", b.untrustRepoConfig)
	route("GET /v1/locations/{name}/worktrees/{worktree}/services", b.listWorktreeServices)
	route("POST /v1/locations/{name}/worktrees/{worktree}/services/{service}/{action}", b.serviceAction)
	route("GET /v1/locations/{name}/worktrees/{worktree}/services/{service}/log", b.serviceLog)
	route("DELETE /v1/locations/{name}/worktrees/{worktree}", b.removeWorktree)
	route("PATCH /v1/locations/{name}/worktrees/{worktree}", b.renameWorktree)
	route("POST /v1/tasks", b.addTask)
	route("GET /v1/services", b.handleServices)
	route("GET /v1/sessions", b.listSessions)
	route("POST /v1/sessions", b.addSession)
	route("DELETE /v1/sessions/{name}", b.removeSession)
	route("PATCH /v1/sessions/{name}", b.renameSession)
	route("POST /v1/sessions/{name}/attach", b.attach)
	route("GET /v1/sessions/{name}/screen", b.screen)
	route("GET /v1/sessions/{name}/draft", b.draft)
	route("GET /v1/sessions/{name}/transcript", b.transcript)
	route("GET /v1/sessions/{name}/transcript/tool/{id}", b.toolDetail)
	route("POST /v1/sessions/{name}/attachments", b.sessionAttachment)
	route("POST /v1/sessions/{name}/send", b.sendToSession)
	route("POST /v1/sessions/{name}/keys", b.sessionKeys)
	route("POST /v1/sessions/{name}/interrupt", b.interruptSession)
	route("GET /v1/sessions/{name}/controls", b.sessionControls)
	route("POST /v1/sessions/{name}/mode", b.setMode)
	route("GET /v1/sessions/{name}/wait", b.waitForSession)
	route("GET /v1/sessions/{name}/turns", b.listTurns)
	route("GET /v1/sessions/{name}/queue", b.listQueue)
	route("DELETE /v1/sessions/{name}/queue/{turn}", b.cancelQueued)
	route("POST /v1/sessions/{name}/queue/{turn}/send", b.sendQueued)
	route("GET /v1/sessions/{name}/diff", b.sessionDiff)
	route("GET /v1/sessions/{name}/commands", b.listCommands)
	route("GET /v1/sessions/{name}/files", b.listFiles)
	route("GET /v1/turns/{id}", b.getTurn)
	route("GET /v1/turns/{id}/wait", b.waitTurn)
	route("POST /v1/exec", b.handleExec)
	route("GET /v1/hooks", b.getHooks)
	route("PUT /v1/hooks", b.putHooks)
	route("GET /v1/skills", b.listSkills)
	route("POST /v1/skills/install", b.installSkills)
	route("POST /v1/skills/uninstall", b.uninstallSkills)
	route("GET /v1/integrations", b.listIntegrations)
	route("POST /v1/integrations/install", b.installIntegrations)
	route("GET /v1/shares", b.listShares)
	route("POST /v1/shares", b.addShare)
	route("DELETE /v1/shares/{id}", b.removeShare)
	route("GET /v1/units", b.listUnits)
	route("POST /v1/units", b.addUnit)
	route("GET /v1/units/{name}", b.getUnit)
	route("DELETE /v1/units/{name}", b.removeUnit)
	route("POST /v1/units/{name}/restart", b.restartUnit)
	route("GET /v1/units/{name}/log", b.unitLog)
	route("GET /v1/stats", b.handleStats)
	route("GET /v1/processes", b.listProcesses)
	route("POST /v1/processes/{id}/stop", b.stopProcess)
	route("GET /v1/review", b.review)
	route("GET /v1/info", b.handleInfo)
	route("GET /v1/doctor", b.handleDoctor)
	route("GET /v1/requirements", b.requirements)
	route("GET /v1/agents", b.listAgentCLIs)
	route("POST /v1/agents/install", b.installAgentCLIs)
	route("POST /v1/agents/refresh", b.lookAgainForAgents)
	route("POST /v1/upgrade", b.handleUpgrade)
	route("GET /v1/events", b.streamEvents)
	route("POST /v1/events", b.emit)
	b.mountRuns(route)
	b.mountHistory(route)
	b.mountAnswer(route)
	b.mountBrowser(route)
	b.mountNotify(route)
	b.mountArtifacts(route)
	b.mountPairing(s, route)
}

type httpError struct {
	status int
	msg    string
}

func (e httpError) Error() string { return e.msg }

func badRequest(format string, args ...any) error {
	return httpError{http.StatusBadRequest, fmt.Sprintf(format, args...)}
}

func statusFor(err error) int {
	var he httpError
	var rc reviewCode
	switch {
	case errors.As(err, &he):
		return he.status
	case errors.As(err, &rc):
		return rc.status
	case errors.Is(err, ErrUnknownLocation), errors.Is(err, ErrUnknownWorktree), errors.Is(err, ErrUnknownSession), errors.Is(err, ErrUnknownShare), errors.Is(err, ErrUnknownUnit), errors.Is(err, ErrUnknownArtifact):
		return http.StatusNotFound
	case errors.Is(err, ErrSessionExists), errors.Is(err, ErrSessionExited):
		return http.StatusConflict
	case errors.Is(err, errTmuxMissing), errors.Is(err, ErrBrowserSandbox):
		return http.StatusServiceUnavailable
	}
	return http.StatusBadRequest
}

func origin(r *http.Request) string {
	if o := r.Header.Get(OriginHeader); validOrigin.MatchString(o) {
		return o
	}
	return "berth"
}

func (b *Box) publish(r *http.Request, typ string, data map[string]any) events.Event {
	return b.Events.Publish(events.Event{Type: typ, Box: b.Name, Origin: origin(r), Data: data})
}

func decode(r *http.Request, v any) error { return decodeLimit(r, v, 64<<10) }

// maxPromptBody bounds a request that carries a prompt (a task, a session,
// a send): 2 MB, room for a long spec pasted whole. A prompt never goes on
// a command line, so tmux's and the kernel's limits don't apply to it.
const maxPromptBody = 2 << 20

func decodeLimit(r *http.Request, v any, limit int64) error {
	body := &countingReader{r: io.LimitReader(r.Body, limit)}
	if err := json.NewDecoder(body).Decode(v); err != nil {
		if body.n >= limit {
			return httpError{http.StatusRequestEntityTooLarge, fmt.Sprintf("the request is larger than this box takes (%d KB)", limit>>10)}
		}
		return badRequest("invalid request body")
	}
	return nil
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func (b *Box) ports(w http.ResponseWriter, r *http.Request) error {
	ports, err := ListPorts(r.Context())
	if err != nil {
		return err
	}
	// berthd's own listener is not a service anyone should open or share.
	own := os.Getpid()
	visible := ports[:0]
	for _, p := range ports {
		if p.PID != own {
			visible = append(visible, p)
		}
	}
	writeJSON(w, visible)
	return nil
}

func (b *Box) listLocations(w http.ResponseWriter, r *http.Request) error {
	all, err := b.Locations.List(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, all)
	return nil
}

func (b *Box) addLocation(w http.ResponseWriter, r *http.Request) error {
	var req struct{ Name, Path string }
	if err := decode(r, &req); err != nil {
		return err
	}
	if err := b.before(r, "location.add", map[string]any{"location": req.Name, "path": req.Path}); err != nil {
		return err
	}
	loc, err := b.Locations.Add(r.Context(), req.Name, req.Path)
	if err != nil {
		return err
	}
	b.publish(r, "location.added", map[string]any{"location": loc.Name, "path": loc.Path})
	writeJSON(w, loc)
	return nil
}

func (b *Box) setScripts(w http.ResponseWriter, r *http.Request) error {
	var req struct{ Setup, Archive string }
	if err := decode(r, &req); err != nil {
		return err
	}
	if err := b.before(r, "config.change", map[string]any{"location": r.PathValue("name")}); err != nil {
		return err
	}
	if err := b.Locations.SetScripts(r.PathValue("name"), req.Setup, req.Archive); err != nil {
		return err
	}
	loc, err := b.Locations.Get(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	writeJSON(w, loc)
	return nil
}

func (b *Box) removeLocation(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	if err := b.before(r, "location.remove", map[string]any{"location": name}); err != nil {
		return err
	}
	if err := b.Locations.Remove(name); err != nil {
		return err
	}
	b.publish(r, "location.removed", map[string]any{"location": name})
	writeJSON(w, map[string]string{"removed": name})
	return nil
}

func (b *Box) addWorktree(w http.ResponseWriter, r *http.Request) error {
	var req WorktreeRequest
	if err := decode(r, &req); err != nil {
		return err
	}
	loc, err := b.Locations.Get(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	wt, err := b.createWorktree(r, loc, req)
	if err != nil {
		return err
	}
	writeJSON(w, wt)
	return nil
}

// createWorktree makes a git worktree once the hooks allow it, then runs the
// location's setup script in the background.
func (b *Box) createWorktree(r *http.Request, loc Location, req WorktreeRequest) (Worktree, error) {
	parent := ""
	if req.Parent != "" {
		var err error
		if parent, err = namedParent(loc, req.Parent); err != nil {
			return Worktree{}, err
		}
	}
	if err := b.before(r, "worktree.create", map[string]any{
		"location": loc.Name, "name": req.Name, "branch": req.Branch, "base": req.Base,
	}); err != nil {
		return Worktree{}, err
	}
	wt, err := b.Locations.CreateWorktreeFrom(r.Context(), loc.Name, req)
	if err != nil {
		return Worktree{}, err
	}
	b.own(wt.Path)
	if parent != "" {
		if err := b.Locations.SetWorktreeParent(loc.Name, wt.Path, parent); err == nil {
			wt.Parent = parent
		}
	}
	created := map[string]any{
		"location": loc.Name, "name": wt.Name, "path": wt.Path, "branch": wt.Branch,
	}
	// The repository's own config did not run: say so, so the app can
	// offer to trust it.
	if loc.RepoTrust == RepoTrustUntrusted || loc.RepoTrust == RepoTrustChanged {
		created["repo_config"] = loc.RepoTrust
	}
	b.publish(r, "worktree.created", created)
	// Services start once setup has made the worktree ready for them.
	if loc.Scripts.Setup != "" {
		go b.lifecycle(origin(r), "setup", loc, wt.Path, wt.Name, loc.Scripts.Setup, func() error {
			go b.startAutostart(loc.Name, wt.Name)
			return nil
		})
	} else {
		go b.startAutostart(loc.Name, wt.Name)
	}
	return wt, nil
}

// lifecycle runs a setup or archive script in the background, announcing its
// start and outcome, then calls next if it succeeded.
func (b *Box) lifecycle(from, kind string, loc Location, dir, name, script string, next func() error) {
	data := map[string]any{"location": loc.Name, "name": name, "path": dir, "script": script}
	b.Events.Publish(events.Event{Type: "worktree." + kind + ".started", Box: b.Name, Origin: from, Data: data})
	// Without a log folder (tests, embedded uses) the log goes to a temp
	// folder, never the working directory.
	logDir := b.LogDir
	if logDir == "" {
		logDir = filepath.Join(os.TempDir(), "berth-logs")
	}
	_ = os.MkdirAll(logDir, 0o700)
	logPath := filepath.Join(logDir, kind+"-"+loc.Name+"-"+name+".log")
	data["log"] = logPath
	err := runScript(context.Background(), script, loc.Path, dir, name, logPath, 30*time.Minute, b.envForDir(context.Background(), dir))
	if err == nil && next != nil {
		err = next()
	}
	if err != nil {
		b.Events.Publish(events.Event{Type: "worktree." + kind + ".failed", Box: b.Name, Origin: from, Error: err.Error(), Data: data})
		return
	}
	b.Events.Publish(events.Event{Type: "worktree." + kind + ".finished", Box: b.Name, Origin: from, Data: data})
}

func (b *Box) removeWorktree(w http.ResponseWriter, r *http.Request) error {
	location, name := r.PathValue("name"), r.PathValue("worktree")
	dir, err := b.Locations.Dir(r.Context(), location+"/"+name)
	if err != nil {
		return err
	}
	if err := b.before(r, "worktree.remove", map[string]any{"location": location, "name": name, "path": dir}); err != nil {
		return err
	}
	b.own(dir)
	force := r.URL.Query().Get("force") == "1"
	loc, err := b.Locations.Get(r.Context(), location)
	if err != nil {
		return err
	}
	// Only throwaway worktrees ask for their branch to go too.
	var branch string
	if r.URL.Query().Get("delete_branch") == "1" {
		for _, wt := range loc.Worktrees {
			if wt.Path == dir && !wt.Main {
				branch = wt.Branch
			}
		}
	}
	async, err := b.dropWorktree(origin(r), loc, name, dir, branch, force, "removed", nil)
	if err != nil {
		return err
	}
	if async {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		writeJSON(w, map[string]string{"removing": name, "archive": loc.Scripts.Archive})
		return nil
	}
	writeJSON(w, map[string]string{"removed": name})
	return nil
}

// dropWorktree removes a worktree: its services stop, and with an archive
// script the script runs in the background and the removal follows if it
// succeeds (async); without one it goes at once. done, when set, hears how
// it ended. A review worktree's removal is journaled as review.removed,
// with why.
func (b *Box) dropWorktree(from string, loc Location, name, dir, branch string, force bool, reason string, done func(error)) (async bool, err error) {
	_, mark := b.Locations.reviewAt(dir)
	if mark != nil && branch == "" {
		// A review's branch is Shipyard's own, made for it: it goes too.
		if out, err := git(context.Background(), "-C", dir, "symbolic-ref", "--short", "HEAD"); err == nil && strings.HasPrefix(strings.TrimSpace(string(out)), "review/") {
			branch = strings.TrimSpace(string(out))
		}
	}
	finish := func(err error) {
		if done != nil {
			done(err)
		}
	}
	b.stopServices(loc.Name, name)
	removed := func(ctx context.Context) {
		if b.Sessions != nil {
			b.stopSessionsIn(from, dir)
		}
		b.Locations.Ports.Release(dir)
		if branch != "" {
			git(ctx, "-C", loc.Path, "branch", "-D", branch)
		}
		b.Events.Publish(events.Event{Type: "worktree.removed", Box: b.Name, Origin: from, Data: map[string]any{"location": loc.Name, "name": name, "path": dir}})
		if mark != nil {
			git(ctx, "-C", loc.Path, "update-ref", "-d", reviewRef(mark.PR))
			b.Events.Publish(events.Event{Type: "review.removed", Box: b.Name, Origin: from, Data: map[string]any{
				"location": loc.Name, "name": name, "path": dir, "repo": mark.Repo, "pr": mark.PR, "reason": reason,
			}})
		}
	}
	// A worktree with an archive script is torn down in the background: the
	// script may take minutes, and removal only follows if it succeeds.
	if loc.Scripts.Archive != "" {
		go func() {
			ran := false
			var removeErr error
			b.lifecycle(from, "archive", loc, dir, name, loc.Scripts.Archive, func() error {
				ran = true
				if removeErr = b.Locations.RemoveWorktree(context.Background(), loc.Name, name, force); removeErr != nil {
					return removeErr
				}
				removed(context.Background())
				return nil
			})
			if !ran {
				removeErr = fmt.Errorf("%s's archive script failed, so it was left as it was", name)
			}
			finish(removeErr)
		}()
		return true, nil
	}
	if err := b.Locations.RemoveWorktree(context.Background(), loc.Name, name, force); err != nil {
		return false, err
	}
	removed(context.Background())
	finish(nil)
	return false, nil
}

// stopSessionsIn ends the sessions working in a removed worktree: their
// folder is gone, so they would only linger in the app with nowhere to work.
func (b *Box) stopSessionsIn(from, dir string) {
	ctx := context.Background()
	all, err := b.Sessions.List(ctx)
	if err != nil {
		return
	}
	for _, s := range all {
		if s.Dir != dir && !strings.HasPrefix(s.Dir, dir+string(filepath.Separator)) {
			continue
		}
		if b.Sessions.Kill(ctx, s.Name) == nil {
			b.Events.Publish(events.Event{Type: "session.stopped", Box: b.Name, Origin: from, Data: map[string]any{"name": s.Name, "path": s.Dir}})
		}
	}
}

func (b *Box) listSessions(w http.ResponseWriter, r *http.Request) error {
	all, err := b.Sessions.List(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, b.enrich(r.Context(), all))
	return nil
}

// SessionRequest starts a session: Command, or the Agent preset with its
// first Prompt. Open asks the app to show it ("split" or "tab").
type SessionRequest struct {
	Name     string `json:"name,omitempty"`
	Location string `json:"location"`
	Command  string `json:"command,omitempty"`
	Agent    string `json:"agent,omitempty"`
	Prompt   string `json:"prompt,omitempty"`
	// Model and Effort, with an agent: see TaskRequest.
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
	Open   string `json:"open,omitempty"`
	// Title names the work; without one, the prompt's first line does.
	Title string `json:"title,omitempty"`
	// Home starts it in the box user's home folder rather than a
	// location: a terminal on the box, tied to no worktree. It takes a
	// command or a shell, never an agent preset, and no location.
	Home bool `json:"home,omitempty"`
}

func (b *Box) addSession(w http.ResponseWriter, r *http.Request) error {
	var req SessionRequest
	if err := decodeLimit(r, &req, maxPromptBody); err != nil {
		return err
	}
	if _, err := tmuxPath(); err != nil {
		return err
	}
	if req.Open != "" && req.Open != "split" && req.Open != "tab" {
		return badRequest("open must be split or tab")
	}
	if req.Home {
		return b.addHomeSession(w, r, req)
	}
	dir, err := b.Locations.Dir(r.Context(), req.Location)
	if err != nil {
		return err
	}
	if req.Agent != "" {
		if req.Command != "" {
			return badRequest("give an agent or a command, not both")
		}
		name, _, _ := strings.Cut(req.Location, "/")
		loc, err := b.Locations.Get(r.Context(), name)
		if err != nil {
			return err
		}
		p, ok := presetFor(&loc, req.Agent)
		if !ok {
			return badRequest("unknown agent %q", req.Agent)
		}
		if req.Command, err = AgentCommandWith(p, req.Prompt, req.Model, req.Effort); err != nil {
			return err
		}
	} else if req.Model != "" || req.Effort != "" {
		return badRequest("a model or an effort needs an agent, not a command")
	}
	if req.Name == "" {
		req.Name = defaultSessionName(req.Location, req.Command)
	}
	preset := req.Agent
	sess, err := b.startSession(r, req.Name, req.Location, dir, req.Command, preset, preset != "" && req.Prompt != "")
	if err != nil {
		return err
	}
	sess = b.titleNew(r.Context(), sess, req.Title, req.Prompt)
	b.announceOpen(r, sess, req.Open)
	writeJSON(w, sess)
	return nil
}

// addHomeSession starts a session in the home folder of the user berthd
// runs as, for a terminal on the box that belongs to no worktree. The folder
// is always that one: the request names no path, so it cannot point
// anywhere else.
func (b *Box) addHomeSession(w http.ResponseWriter, r *http.Request, req SessionRequest) error {
	if req.Location != "" {
		return badRequest("give a location or home, not both")
	}
	if req.Agent != "" || req.Model != "" || req.Effort != "" || req.Prompt != "" {
		return badRequest("an agent needs a location; home takes a command or a shell")
	}
	dir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("this box has no home folder for its user: %w", err)
	}
	if req.Name == "" {
		req.Name = defaultSessionName("home", req.Command)
	}
	sess, err := b.startSession(r, req.Name, "", dir, req.Command, "", false)
	if err != nil {
		return err
	}
	sess = b.titleNew(r.Context(), sess, req.Title, "")
	b.announceOpen(r, sess, req.Open)
	writeJSON(w, sess)
	return nil
}

// announceOpen asks the app to show a new session, beside the terminal the
// user is looking at or as a tab.
func (b *Box) announceOpen(r *http.Request, sess Session, open string) {
	if open == "" {
		return
	}
	b.publish(r, "session.open", map[string]any{"name": sess.Name, "location": sess.Location, "path": sess.Dir, "open": open, "agent": sess.Agent})
}

// startSession runs command in dir once the hooks allow it; preset is the
// agent preset it runs, if any, and prompted says its command carries a
// first prompt.
func (b *Box) startSession(r *http.Request, name, location, dir, command, preset string, prompted bool) (Session, error) {
	data := map[string]any{"name": name, "location": location, "path": dir, "command": command}
	if err := b.before(r, "session.start", data); err != nil {
		return Session{}, err
	}
	sess, err := b.createAgentSession(r.Context(), name, location, dir, command, preset)
	if err != nil {
		return Session{}, err
	}
	if a := agentFor(sess); a != "" {
		data["agent"] = a
	}
	b.publish(r, "session.started", data)
	// A worktree the repository had before Team setup adopted it is set
	// up now, the first time anyone works in it.
	b.setUpOnFirstOpen(origin(r), dir)
	if prompted {
		b.startupPrompt(origin(r), gateOrigin(r), Session{Name: sess.Name, Agent: agentFor(sess)})
	}
	sess = b.enrich(r.Context(), []Session{sess})[0]
	b.beginStartup(origin(r), sess)
	return sess, nil
}

func (b *Box) removeSession(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	if err := b.before(r, "session.stop", map[string]any{"name": name}); err != nil {
		return err
	}
	if err := b.Sessions.Kill(r.Context(), name); err != nil {
		return err
	}
	b.publish(r, "session.stopped", map[string]any{"name": name})
	writeJSON(w, map[string]string{"removed": name})
	return nil
}

// attach relays a terminal: framed keystrokes and resizes in, screen bytes
// out. Ending the request detaches; the session keeps running.
func (b *Box) attach(w http.ResponseWriter, r *http.Request) error {
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	if err := b.before(r, "session.attach", map[string]any{"name": r.PathValue("name")}); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	master, cmd, err := b.Sessions.Attach(ctx, r.PathValue("name"), max(cols, 20), max(rows, 5))
	if err != nil {
		return err
	}
	defer cmd.Wait()
	defer master.Close()
	rc := http.NewResponseController(w)
	rc.EnableFullDuplex()
	w.WriteHeader(http.StatusOK)
	if err := rc.Flush(); err != nil {
		return nil
	}
	go func() {
		terminal.ReadFrames(r.Body,
			func(p []byte) error { _, err := master.Write(p); return err },
			func(c, rr int) { terminal.Resize(master, c, rr) })
		// The laptop went away: hang up the tmux client, not the session.
		cancel()
		master.Close()
	}()
	buf := make([]byte, 32<<10)
	for {
		n, err := master.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return nil
			}
			rc.Flush()
		}
		if err != nil {
			return nil
		}
	}
}

func (b *Box) screen(w http.ResponseWriter, r *http.Request) error {
	history, _ := strconv.Atoi(r.URL.Query().Get("history"))
	text, err := b.Sessions.Screen(r.Context(), r.PathValue("name"), min(history, 10000))
	if err != nil {
		return err
	}
	writeJSON(w, map[string]string{"screen": text})
	return nil
}

func (b *Box) listShares(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, b.Shares.List())
	return nil
}

func (b *Box) addShare(w http.ResponseWriter, r *http.Request) error {
	var req struct{ Port int }
	if err := decode(r, &req); err != nil {
		return err
	}
	if err := b.before(r, "share.start", map[string]any{"port": req.Port}); err != nil {
		return err
	}
	sh, err := b.Shares.Create(r.Context(), req.Port)
	if err != nil {
		return err
	}
	b.publish(r, "share.started", map[string]any{"id": sh.ID, "port": sh.Port, "url": sh.URL})
	writeJSON(w, sh)
	return nil
}

func (b *Box) removeShare(w http.ResponseWriter, r *http.Request) error {
	if err := b.before(r, "share.stop", map[string]any{"id": r.PathValue("id")}); err != nil {
		return err
	}
	sh, err := b.Shares.Remove(r.PathValue("id"))
	if err != nil {
		return err
	}
	b.publish(r, "share.stopped", map[string]any{"id": sh.ID, "port": sh.Port, "url": sh.URL})
	writeJSON(w, sh)
	return nil
}

func (b *Box) units() (*Units, error) {
	if b.Units == nil {
		return nil, badRequest("this box cannot run managed units")
	}
	return b.Units, nil
}

func (b *Box) listUnits(w http.ResponseWriter, r *http.Request) error {
	u, err := b.units()
	if err != nil {
		return err
	}
	all, err := u.List()
	if err != nil {
		return err
	}
	writeJSON(w, all)
	return nil
}

func (b *Box) addUnit(w http.ResponseWriter, r *http.Request) error {
	u, err := b.units()
	if err != nil {
		return err
	}
	var req UnitRequest
	if err := decode(r, &req); err != nil {
		return err
	}
	// The unit's name only; its arguments can carry credentials.
	if err := b.before(r, "unit.start", map[string]any{"name": req.Name}); err != nil {
		return err
	}
	unit, err := u.Install(r.Context(), req)
	if err != nil {
		return err
	}
	// The unit's name only; its arguments can carry credentials.
	b.publish(r, "unit.started", map[string]any{"name": unit.Name})
	writeJSON(w, unit)
	return nil
}

func (b *Box) getUnit(w http.ResponseWriter, r *http.Request) error {
	u, err := b.units()
	if err != nil {
		return err
	}
	unit, err := u.Get(r.PathValue("name"))
	if err != nil {
		return err
	}
	writeJSON(w, unit)
	return nil
}

func (b *Box) removeUnit(w http.ResponseWriter, r *http.Request) error {
	u, err := b.units()
	if err != nil {
		return err
	}
	if err := b.before(r, "unit.stop", map[string]any{"name": r.PathValue("name")}); err != nil {
		return err
	}
	unit, err := u.Remove(r.PathValue("name"))
	if err != nil {
		return err
	}
	b.publish(r, "unit.stopped", map[string]any{"name": unit.Name})
	writeJSON(w, unit)
	return nil
}

func (b *Box) restartUnit(w http.ResponseWriter, r *http.Request) error {
	u, err := b.units()
	if err != nil {
		return err
	}
	if err := b.before(r, "unit.restart", map[string]any{"name": r.PathValue("name")}); err != nil {
		return err
	}
	unit, err := u.Restart(r.PathValue("name"))
	if err != nil {
		return err
	}
	b.publish(r, "unit.restarted", map[string]any{"name": unit.Name})
	writeJSON(w, unit)
	return nil
}

func (b *Box) unitLog(w http.ResponseWriter, r *http.Request) error {
	u, err := b.units()
	if err != nil {
		return err
	}
	limit := int64(1 << 20)
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 || n > 1<<20 {
			return badRequest("limit must be between 1 and %d", 1<<20)
		}
		limit = n
	}
	out, err := u.Tail(r.PathValue("name"), limit)
	if err != nil {
		return err
	}
	// A []byte marshals as base64, so a log holding arbitrary bytes survives
	// the round trip that a plain string would corrupt.
	writeJSON(w, map[string][]byte{"log": out})
	return nil
}

// streamEvents streams the box's events as NDJSON. With ?since=SEQ it first
// replays what the journal holds after SEQ (at most ?max= events, default
// 5000), so a laptop that slept catches up; a client that falls behind is
// caught up from the journal rather than losing events.
func (b *Box) streamEvents(w http.ResponseWriter, r *http.Request) error {
	since := int64(-1)
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			return badRequest("since must be an event seq")
		}
		since = n
		limit := int64(5000)
		if m, err := strconv.ParseInt(r.URL.Query().Get("max"), 10, 64); err == nil && m >= 0 {
			limit = m
		}
		if head := b.Events.Head(); head-since > limit {
			since = head - limit
		}
	}
	cur := b.Events.SubscribeFrom(since).Named("http " + origin(r))
	defer cur.Close()
	ch := make(chan events.Event)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		defer close(ch)
		for {
			e, err := cur.Next(ctx)
			if err != nil {
				return
			}
			select {
			case ch <- e:
			case <-ctx.Done():
				return
			}
		}
	}()
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	rc.Flush()
	enc := json.NewEncoder(w)
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil
		case e, ok := <-ch:
			if !ok || enc.Encode(e) != nil || rc.Flush() != nil {
				return nil
			}
		case <-keepalive.C:
			if _, err := w.Write([]byte("\n")); err != nil || rc.Flush() != nil {
				return nil
			}
		}
	}
}

// emit lets tools announce their own events, such as an agent finishing in
// Cursor, so hooks and the laptop can react to them.
func (b *Box) emit(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Type string         `json:"type"`
		Data map[string]any `json:"data"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	if !validEventType.MatchString(req.Type) {
		return badRequest("event type must look like area.action, e.g. agent.finished")
	}
	if err := b.before(r, "event.emit", map[string]any{"type": req.Type}); err != nil {
		return err
	}
	// A tool use while the agent is already working changes nothing, and
	// agents use tools constantly: keep them out of the journal.
	// A prompt's title (adapters.Title) names the session; it is never
	// published, so the journal and hooks never see it.
	title, _ := req.Data["title"].(string)
	delete(req.Data, "title")
	// What a waiting agent asks for (its hook's tool and a summary of its
	// input) is never published: it goes on the turn's wait, in the
	// ledger's private file, once the event has made that wait.
	ask, hasAsk := req.Data[adapters.AskKey]
	delete(req.Data, adapters.AskKey)
	if b.Turns != nil && b.Turns.Redundant(req.Type, req.Data) {
		writeJSON(w, map[string]bool{"ok": true})
		return nil
	}
	b.publish(r, req.Type, req.Data)
	if title != "" && req.Type == adapters.Started && b.Turns != nil {
		if name := b.Turns.SessionOf(req.Data); name != "" {
			b.nameAfter(r.Context(), name, adapters.Clip(title, adapters.TitleMax))
		}
	}
	if hasAsk && b.Turns != nil && req.Type == adapters.Waiting {
		b.Turns.NoteAsk(req.Data, ask)
	}
	writeJSON(w, map[string]bool{"ok": true})
	return nil
}

var validEventType = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$`)

var unsafeSessionChars = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// defaultSessionName names a session after where it runs and what it runs,
// e.g. "shop-checkout-claude".
func defaultSessionName(location, command string) string {
	prog := "shell"
	if f := splitFirst(command); f != "" {
		prog = filepath.Base(f)
	}
	name := unsafeSessionChars.ReplaceAllString(location+"-"+prog, "-")
	if len(name) > 48 {
		name = name[:48]
	}
	return name + "-" + strconv.FormatInt(time.Now().Unix()%100000, 36)
}

func splitFirst(command string) string {
	for i, r := range command {
		if r == ' ' || r == '\t' {
			return command[:i]
		}
	}
	return command
}

// writeJSON sends v, with an empty list as [] rather than null: every list
// the box answers with is one the app and plugins iterate over.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if rv := reflect.ValueOf(v); rv.Kind() == reflect.Slice && rv.IsNil() {
		v = []struct{}{}
	}
	json.NewEncoder(w).Encode(v)
}

// writeError answers with msg and the code its status implies; writeErr
// (errcodes.go) names the code from the error itself.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeCoded(w, status, msg, codeForStatus(status))
}

func writeCoded(w http.ResponseWriter, status int, msg, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg, "code": code})
}
