package box

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/statefile"
)

// A structured agent's conversation outlives its session: its folder under
// ConversationsDir holds its log and meta.json, what it is. A session that
// ended is started again on its own log (POST /v1/sessions/{name}/resume),
// and one that is gone altogether is found again (GET /v1/conversations)
// and resumed in a new session (POST /v1/conversations/{id}/resume), with
// Claude Code's --resume: the same conversation, carried on.

// Conversation is what a structured conversation is.
type Conversation struct {
	ID    string `json:"id"`
	Agent string `json:"agent"`
	// Location and Dir are where it works; Session the session it last ran
	// in, and Live that one is running.
	Location string `json:"location,omitempty"`
	Dir      string `json:"dir"`
	Session  string `json:"session,omitempty"`
	Live     bool   `json:"live,omitempty"`
	// AgentSessionID is Claude Code's own name for it; Mode the
	// permission mode it ran in ("bypassPermissions": berthd allowed).
	AgentSessionID string `json:"agent_session_id,omitempty"`
	Mode           string `json:"mode,omitempty"`
	// Model and Effort, when asked for: a Codex thread's turns carry them.
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
	// Title is its first prompt's first line.
	Title   string    `json:"title,omitempty"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated,omitzero"`
	// Failed is set when its agent, started again, exited as it started
	// (relaunch.go); the next start that comes up clears it.
	Failed *LaunchFailure `json:"failed,omitempty"`
}

const metaName = "meta.json"

func (b *Box) mountConversations(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("GET /v1/conversations", b.listConversations)
	route("POST /v1/conversations/{id}/resume", b.resumeConversation)
	route("POST /v1/sessions/{name}/resume", b.resumeSession)
	route("GET /v1/sessions/{name}/past", b.listPast)
}

// readConversation reads a conversation's meta.json.
func readConversation(dir string) (Conversation, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, metaName))
	if err != nil {
		return Conversation{}, false
	}
	var c Conversation
	if json.Unmarshal(raw, &c) != nil {
		return Conversation{}, false
	}
	c.ID = filepath.Base(dir)
	return c, true
}

// metaMu makes each change to a meta.json whole: two at once (a turn's
// time, a mode set from the app) would each write back what the other
// hadn't, and lose it.
var metaMu sync.Mutex

// noteConversation changes a conversation's meta.json.
func noteConversation(dir string, change func(*Conversation)) {
	metaMu.Lock()
	defer metaMu.Unlock()
	c, _ := readConversation(dir)
	change(&c)
	c.ID, c.Live = "", false
	if raw, err := json.Marshal(c); err == nil {
		statefile.Write(filepath.Join(dir, metaName), raw)
	}
}

// conversationDir is the folder of conversation id, refusing anything that
// isn't one of the box's.
func (b *Box) conversationDir(id string) (string, error) {
	if b.ConversationsDir == "" || id == "" || strings.ContainsAny(id, `/\`) || strings.HasPrefix(id, ".") {
		return "", httpError{http.StatusNotFound, "no conversation " + strconv.Quote(id)}
	}
	dir := filepath.Join(b.ConversationsDir, id)
	if _, ok := readConversation(dir); !ok {
		return "", httpError{http.StatusNotFound, "no conversation " + strconv.Quote(id)}
	}
	return dir, nil
}

// listConversations answers GET /v1/conversations?path=P&location=L&limit=N:
// the structured conversations kept on the box, newest first, those that
// worked in P (or in location L, or its worktrees).
func (b *Box) listConversations(w http.ResponseWriter, r *http.Request) error {
	out := []Conversation{}
	if b.ConversationsDir == "" {
		writeJSON(w, out)
		return nil
	}
	q := r.URL.Query()
	path, location := q.Get("path"), q.Get("location")
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	live := map[string]string{}
	if sessions, err := b.Sessions.List(r.Context()); err == nil {
		for _, s := range sessions {
			if conversationRunning(s) {
				live[s.conv] = s.Name
			}
		}
	}
	entries, _ := os.ReadDir(b.ConversationsDir)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(b.ConversationsDir, e.Name())
		c, ok := readConversation(dir)
		if !ok {
			continue
		}
		if path != "" && !sameDir(c.Dir, filepath.Clean(path)) {
			continue
		}
		if location != "" && c.Location != location && !strings.HasPrefix(c.Location, location+"/") {
			continue
		}
		if name, ok := live[dir]; ok {
			c.Live, c.Session = true, name
		}
		out = append(out, c)
	}
	slices.SortFunc(out, func(a, b Conversation) int { return lastTime(b).Compare(lastTime(a)) })
	if len(out) > limit {
		out = out[:limit]
	}
	writeJSON(w, out)
	return nil
}

func lastTime(c Conversation) time.Time {
	if c.Updated.After(c.Created) {
		return c.Updated
	}
	return c.Created
}

// resumeSession answers POST /v1/sessions/{name}/resume {agent_session_id?}:
// a structured session whose agent ended starts again on its own log,
// carrying its conversation on; given agent_session_id, it carries that
// one of its agent's conversations on instead, ended or not (pastsessions.go).
func (b *Box) resumeSession(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		AgentSessionID string `json:"agent_session_id,omitempty"`
	}
	if r.ContentLength > 0 {
		if err := decode(r, &req); err != nil {
			return err
		}
	}
	name := r.PathValue("name")
	sess, err := b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	if sess.conv == "" {
		return httpError{http.StatusConflict, name + " isn't a structured session: start its agent again instead"}
	}
	if req.AgentSessionID == "" && conversationRunning(sess) {
		return httpError{http.StatusConflict, name + " is still running"}
	}
	if err := b.before(r, "session.start", map[string]any{"name": name, "location": sess.Location, "path": sess.Dir, "resume": true}); err != nil {
		return err
	}
	if req.AgentSessionID != "" {
		err = b.carryOn(r, sess, req.AgentSessionID)
	} else if sess.Driver == "" {
		// Left in Claude Code's terminal: back to its chat, with what was
		// said there.
		err = b.toChat(r, sess)
	} else {
		err = b.resumeInPlace(r, sess, "")
	}
	if err != nil {
		return err
	}
	b.publish(r, "session.resumed", map[string]any{"name": name})
	sess, err = b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	writeJSON(w, b.enrich(r.Context(), []Session{sess})[0])
	return nil
}

// resumeInPlace starts a structured session's host again in its own pane,
// on its log and socket, with --resume (sid, or the one its log names).
func (b *Box) resumeInPlace(r *http.Request, sess Session, sid string) error {
	ctx := r.Context()
	if sid == "" {
		sid = conversationSession(sess.conv)
	}
	if meta, _ := readConversation(sess.conv); sid == "" && meta.Agent == "claude" {
		// Codex and ACP agents open their sessions again themselves; Claude
		// needs its conversation named.
		return httpError{http.StatusConflict, "berthd doesn't know which Claude conversation this is"}
	}
	l, err := b.relaunch(ctx, sess.Location, sess.conv, sess.sock, sid, modeFor(sess))
	if err != nil {
		return err
	}
	l.labels[labelHandoff] = ""
	b.forgetConversation(sess.Name)
	from := logEnd(sess.conv)
	if err := b.respawnAgent(ctx, sess, l.command, l.env, l.labels); err != nil {
		return err
	}
	noteResumed(sess.conv, sess.Name)
	// Back when it is up, so what is sent next reaches it; or failed, and
	// said so rather than left to look resumable.
	if f := awaitStart(sess.conv, sess.sock, from, 15*time.Second); f != nil {
		noteFailed(sess.conv, f)
		return launchFailed(l.agent, f)
	}
	if live, err := b.Sessions.Get(ctx, sess.Name); err == nil {
		b.startStructured(origin(r), gateOrigin(r), live, "")
	}
	return nil
}

// relaunch is what starts a structured conversation's agent again, in its
// folder and on sock: Claude Code with --resume sid, or Codex's app
// server, which opens its thread again itself.
func (b *Box) relaunch(ctx context.Context, location, dir, sock, sid, mode string) (structuredLaunch, error) {
	meta, _ := readConversation(dir)
	if meta.Agent != "claude" && meta.Agent != "codex" && meta.Agent != "" {
		p, ok := b.presetAt(ctx, location, meta.Agent)
		if !ok {
			return structuredLaunch{}, badRequest("this box has no %s preset", meta.Agent)
		}
		return b.launchACPIn(p, firstNonEmpty(mode, meta.Mode), dir, sock)
	}
	if meta.Agent == "codex" {
		p, ok := b.presetAt(ctx, location, "codex")
		if !ok {
			return structuredLaunch{}, badRequest("this box has no Codex preset")
		}
		return b.launchCodexIn(p, firstNonEmpty(mode, meta.Mode), dir, sock)
	}
	return b.launchClaudeIn(b.claudePreset(ctx, Session{Location: location}), "", "", mode, sid, dir, sock)
}

// presetAt is an agent preset as a location has it.
func (b *Box) presetAt(ctx context.Context, location, agent string) (AgentPreset, bool) {
	name, _, _ := strings.Cut(location, "/")
	if loc, err := b.Locations.Get(ctx, name); err == nil {
		if p, ok := presetFor(&loc, agent); ok {
			return p, true
		}
	}
	for _, p := range builtinAgents {
		if p.ID == agent {
			return p, true
		}
	}
	return AgentPreset{}, false
}

// conversationSession is the Claude conversation a structured
// conversation's folder carries on: from its meta, else its log.
func conversationSession(dir string) string {
	if c, ok := readConversation(dir); ok && c.AgentSessionID != "" {
		return c.AgentSessionID
	}
	return lastSessionID(filepath.Join(dir, agenthost.LogName))
}

// resumeConversation answers POST /v1/conversations/{id}/resume {open?}:
// the session it runs in, started again when it ended, or a new one when
// it is gone.
func (b *Box) resumeConversation(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Open string `json:"open,omitempty"`
	}
	if r.ContentLength > 0 {
		if err := decode(r, &req); err != nil {
			return err
		}
	}
	dir, err := b.conversationDir(r.PathValue("id"))
	if err != nil {
		return err
	}
	s, err := b.carryOnConversation(r, dir)
	if err != nil {
		return err
	}
	b.announceOpen(r, s, req.Open)
	writeJSON(w, s)
	return nil
}

// carryOnConversation is the session the conversation in dir runs in: the
// one it runs in now, the one it ended in started again, or a new one when
// that is gone (after a reboot, say). Its agent starts as berthd launches
// it, from its meta.json: its preset's command, its flags and --resume.
func (b *Box) carryOnConversation(r *http.Request, dir string) (Session, error) {
	conv, _ := readConversation(dir)
	sessions, err := b.Sessions.List(r.Context())
	if err != nil {
		return Session{}, err
	}
	for _, s := range sessions {
		if s.conv != dir {
			continue
		}
		if s.Exited {
			if s.Driver == "" {
				err = b.toChat(r, s)
			} else {
				err = b.resumeInPlace(r, s, "")
			}
			if err != nil {
				return Session{}, err
			}
			if s, err = b.Sessions.Get(r.Context(), s.Name); err != nil {
				return Session{}, err
			}
		}
		return b.enrich(r.Context(), []Session{s})[0], nil
	}
	if st, err := os.Stat(conv.Dir); err != nil || !st.IsDir() {
		return Session{}, httpError{http.StatusGone, "the folder it worked in, " + conv.Dir + ", is gone"}
	}
	sid := conversationSession(dir)
	if sid == "" && conv.Agent == "claude" {
		return Session{}, httpError{http.StatusConflict, "berthd doesn't know which Claude conversation this is"}
	}
	sock, err := hostSocket(filepath.Base(dir))
	if err != nil {
		return Session{}, err
	}
	l, err := b.relaunch(r.Context(), conv.Location, dir, sock, sid, conv.Mode)
	if err != nil {
		return Session{}, err
	}
	name := defaultSessionName(firstNonEmpty(conv.Location, filepath.Base(conv.Dir)), firstNonEmpty(conv.Agent, "claude"))
	from := logEnd(dir)
	sess, err := b.startStructuredSession(r, name, conv.Location, conv.Dir, firstNonEmpty(conv.Agent, "claude"), l, "")
	if err != nil {
		return Session{}, err
	}
	if f := awaitStart(dir, sock, from, 15*time.Second); f != nil {
		// Its session ended with it: nothing is left running, and the
		// conversation says why it didn't start.
		noteFailed(dir, f)
		if b.Sessions.Kill(r.Context(), sess.Name) == nil {
			b.publish(r, "session.stopped", map[string]any{"name": sess.Name})
		}
		return Session{}, launchFailed(l.agent, f)
	}
	if conv.Title != "" {
		b.nameAfter(r.Context(), sess.Name, conv.Title)
		sess.Title = conv.Title
	}
	return sess, nil
}

// noteStarted keeps what a new structured conversation is.
func noteStarted(l structuredLaunch, location, cwd, session, prompt string) {
	noteConversation(l.labels[labelConv], func(c *Conversation) {
		c.Agent, c.Location, c.Dir, c.Session = firstNonEmpty(l.agent, "claude"), location, cwd, session
		if l.mode != "" {
			c.Mode = l.mode
		}
		if l.model != "" {
			c.Model = l.model
		}
		if l.effort != "" {
			c.Effort = l.effort
		}
		if c.Created.IsZero() {
			c.Created = time.Now().UTC()
		}
		if c.Title == "" && strings.TrimSpace(prompt) != "" {
			c.Title = adapters.Clip(adapters.Title(prompt), adapters.TitleMax)
		}
		c.Failed = nil
	})
}

// noteResumed marks a conversation as running in session now.
func noteResumed(dir, session string) {
	noteConversation(dir, func(c *Conversation) {
		c.Session, c.Updated, c.Failed = session, time.Now().UTC(), nil
	})
}
