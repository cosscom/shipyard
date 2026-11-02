package box

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
)

// A structured chat has no terminal for its agent's own /resume picker, so
// the app draws one: GET /v1/sessions/{name}/past lists the agent's own
// conversations in the session's folder (Claude Code's files there, which
// a terminal's sessions write too, or what an ACP agent's session/list
// says), and POST /v1/sessions/{name}/resume {agent_session_id} carries
// one on in the session's pane. It gets a conversation folder of its own,
// so the one it leaves keeps its log and stays resumable.

// PastSession is one of an agent's own conversations a chat can carry on.
type PastSession struct {
	ID      string    `json:"id"`
	Title   string    `json:"title,omitempty"`
	Updated time.Time `json:"updated,omitzero"`
	// Current is the one the session runs now; Session another live
	// session that runs it.
	Current bool   `json:"current,omitempty"`
	Session string `json:"session,omitempty"`
}

// PastSessions is what GET /v1/sessions/{name}/past answers.
type PastSessions struct {
	Agent    string        `json:"agent"`
	Sessions []PastSession `json:"sessions"`
	// Note says why the list is empty when the agent can't give one.
	Note string `json:"note,omitempty"`
}

const (
	maxPast = 50
	// pastPeek is how much of each end of a Claude file is read for its
	// title: its first prompt is near the start, the titles it is given
	// as it goes near the end.
	pastPeek = 256 << 10
)

// agentSessionIDs are what an agent names its conversations: Claude Code's
// UUIDs, ACP agents' own ids.
var agentSessionIDs = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// listPast answers GET /v1/sessions/{name}/past.
func (b *Box) listPast(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	sess, err := b.Sessions.Get(ctx, r.PathValue("name"))
	if err != nil {
		return err
	}
	if sess.conv == "" || !structuredDriver(sess.Driver) {
		return httpError{http.StatusConflict, sess.Name + " runs in its terminal: its agent's own /resume works there"}
	}
	meta, _ := readConversation(sess.conv)
	out := PastSessions{Agent: firstNonEmpty(meta.Agent, agentFor(sess)), Sessions: []PastSession{}}
	switch sess.Driver {
	case DriverClaude:
		out.Sessions = claudePast(b.claudeHomeFor(ctx, sess), sess.Dir, maxPast)
	case DriverACP:
		out.Sessions, out.Note = b.acpPast(ctx, sess)
	default:
		out.Note = "Codex's past threads can't be picked here yet. Open its terminal and use Codex's own /resume."
	}
	cur := conversationSession(sess.conv)
	running := b.runningAgentSessions(ctx, sess.Name)
	for i, p := range out.Sessions {
		if p.ID == cur {
			out.Sessions[i].Current = true
		} else if name, ok := running[p.ID]; ok {
			out.Sessions[i].Session = name
		}
	}
	writeJSON(w, out)
	return nil
}

// claudeHomeFor is the Claude Code folder a session's agent keeps its
// conversations in: its account's (CLAUDE_CONFIG_DIR), else ~/.claude.
func (b *Box) claudeHomeFor(ctx context.Context, sess Session) string {
	if d := b.Sessions.EnvVar(ctx, sess, "CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return firstNonEmpty(os.Getenv("CLAUDE_CONFIG_DIR"), filepath.Join(home, ".claude"))
}

// claudeFolders are where Claude Code may keep dir's conversations: under
// dir as it is named, and as it resolves (Claude Code names the folder it
// runs in by its real path; /tmp is /private/tmp on macOS).
func claudeFolders(claudeHome, dir string) []string {
	out := []string{filepath.Join(claudeHome, "projects", claudeProjectChars.ReplaceAllString(dir, "-"))}
	if real, err := filepath.EvalSymlinks(dir); err == nil && real != dir {
		out = append(out, filepath.Join(claudeHome, "projects", claudeProjectChars.ReplaceAllString(real, "-")))
	}
	return out
}

// claudeFile is the transcript of Claude Code's conversation sid in dir,
// or "" when there is none.
func claudeFile(claudeHome, dir, sid string) string {
	for _, folder := range claudeFolders(claudeHome, dir) {
		path := filepath.Join(folder, sid+".jsonl")
		if st, err := os.Stat(path); err == nil && st.Mode().IsRegular() {
			return path
		}
	}
	return ""
}

// claudePast is Claude Code's conversations in dir, newest first: those
// with a prompt in them, at most limit.
func claudePast(claudeHome, dir string, limit int) []PastSession {
	type file struct {
		id, path string
		mod      time.Time
	}
	var files []file
	seen := map[string]bool{}
	for _, folder := range claudeFolders(claudeHome, dir) {
		entries, _ := os.ReadDir(folder)
		for _, e := range entries {
			id, ok := strings.CutSuffix(e.Name(), ".jsonl")
			if !ok || seen[id] || !e.Type().IsRegular() || !agentSessionIDs.MatchString(id) {
				continue
			}
			if info, err := e.Info(); err == nil {
				seen[id] = true
				files = append(files, file{id, filepath.Join(folder, e.Name()), info.ModTime()})
			}
		}
	}
	slices.SortFunc(files, func(a, b file) int { return b.mod.Compare(a.mod) })
	out := []PastSession{}
	for _, f := range files {
		if len(out) >= limit {
			break
		}
		if title, ok := claudeTitle(f.path); ok {
			out = append(out, PastSession{ID: f.id, Title: title, Updated: f.mod.UTC()})
		}
	}
	return out
}

// claudeLine is the part of a line of Claude Code's transcript a title is
// read from.
type claudeLine struct {
	Type        string          `json:"type"`
	IsMeta      bool            `json:"isMeta"`
	IsSidechain bool            `json:"isSidechain"`
	CustomTitle string          `json:"customTitle"`
	AITitle     string          `json:"aiTitle"`
	Summary     string          `json:"summary"`
	Message     json.RawMessage `json:"message"`
}

// claudeTitle is what a Claude Code conversation is called: the name it
// was given (/rename), else the one Claude gave it, else its first
// prompt's first line. ok is false when nobody prompted it.
func claudeTitle(path string) (title string, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	var custom, ai, summary, prompt string
	read := func(rd io.Reader) {
		sc := bufio.NewScanner(rd)
		sc.Buffer(make([]byte, 0, 64<<10), pastPeek)
		for sc.Scan() {
			line := sc.Bytes()
			// Most lines are neither: skip them before decoding.
			if !bytes.Contains(line, []byte(`"type":"user"`)) && !bytes.Contains(line, []byte(`itle"`)) && !bytes.Contains(line, []byte(`"summary"`)) {
				continue
			}
			var l claudeLine
			if json.Unmarshal(line, &l) != nil {
				continue
			}
			switch l.Type {
			case "custom-title":
				custom = firstNonEmpty(strings.TrimSpace(l.CustomTitle), custom)
			case "ai-title":
				ai = firstNonEmpty(strings.TrimSpace(l.AITitle), ai)
			case "summary":
				summary = firstNonEmpty(strings.TrimSpace(l.Summary), summary)
			case "user":
				if prompt == "" && !l.IsMeta && !l.IsSidechain {
					prompt = firstPrompt(l.Message)
				}
			}
		}
	}
	read(io.LimitReader(f, pastPeek))
	if st, err := f.Stat(); err == nil && st.Size() > pastPeek {
		at := max(st.Size()-pastPeek, pastPeek)
		if _, err := f.Seek(at, io.SeekStart); err == nil {
			// The first line read there is likely cut: the scanner drops
			// it as JSON that doesn't parse.
			read(f)
		}
	}
	if prompt == "" && custom == "" {
		return "", false
	}
	for _, t := range []string{custom, ai, summary, prompt} {
		if t != "" {
			return adapters.Clip(adapters.Title(t), adapters.TitleMax), true
		}
	}
	return "", false
}

// firstPrompt is a user message's typed text, when it is a person's
// prompt and not one Claude Code wrote itself (an interruption, a caveat
// before a command's output).
func firstPrompt(message json.RawMessage) string {
	text, ok := promptText(message)
	text = strings.TrimSpace(text)
	if !ok || strings.HasPrefix(text, "<") || strings.HasPrefix(text, "[Request interrupted") || strings.HasPrefix(text, "Caveat:") {
		return ""
	}
	return text
}

// acpPast is what an ACP agent lists of its sessions in the session's
// folder, or why it can't.
func (b *Box) acpPast(ctx context.Context, sess Session) ([]PastSession, string) {
	out := []PastSession{}
	if sess.Exited {
		return out, "Start the agent again to list its past sessions."
	}
	c, err := b.acp().conv(sess)
	if err != nil {
		return out, err.Error()
	}
	c.mu.Lock()
	can := c.canList
	c.mu.Unlock()
	if !can {
		return out, "This agent doesn't list its past sessions over ACP."
	}
	raw, err := c.call(ctx, "session/list", map[string]any{"cwd": sess.Dir}, 20*time.Second)
	if err != nil {
		return out, "It didn't list its sessions: " + err.Error()
	}
	var r struct {
		Sessions []struct {
			SessionID string `json:"sessionId"`
			Cwd       string `json:"cwd"`
			Title     string `json:"title"`
			UpdatedAt string `json:"updatedAt"`
		} `json:"sessions"`
	}
	json.Unmarshal(raw, &r)
	for _, s := range r.Sessions {
		if !agentSessionIDs.MatchString(s.SessionID) || (s.Cwd != "" && !sameDir(s.Cwd, sess.Dir)) {
			continue
		}
		p := PastSession{ID: s.SessionID}
		if t := strings.TrimSpace(s.Title); t != "" {
			p.Title = adapters.Clip(adapters.Title(t), adapters.TitleMax)
		}
		if at, err := time.Parse(time.RFC3339Nano, s.UpdatedAt); err == nil {
			p.Updated = at.UTC()
		}
		out = append(out, p)
	}
	slices.SortStableFunc(out, func(a, b PastSession) int { return b.Updated.Compare(a.Updated) })
	if len(out) > maxPast {
		out = out[:maxPast]
	}
	return out, ""
}

// runningAgentSessions are the agents' conversations that structured
// sessions other than but run now, by the agent's id for each: each by its
// own session's host, never by the folder it works in, where other agents
// run conversations of their own.
func (b *Box) runningAgentSessions(ctx context.Context, but string) map[string]string {
	out := map[string]string{}
	sessions, err := b.Sessions.List(ctx)
	if err != nil {
		return out
	}
	for _, s := range sessions {
		if s.Name == but || !conversationRunning(s) {
			continue
		}
		if sid := conversationSession(s.conv); sid != "" {
			out[sid] = s.Name
		}
	}
	return out
}

// carryOn starts a structured session's agent on another of its own
// conversations, sid, in the session's pane.
func (b *Box) carryOn(r *http.Request, sess Session, sid string) error {
	ctx := r.Context()
	if !agentSessionIDs.MatchString(sid) {
		return badRequest("%q isn't a conversation's id", sid)
	}
	if sess.conv == "" || !structuredDriver(sess.Driver) {
		return httpError{http.StatusConflict, sess.Name + " runs in its terminal: its agent's own /resume works there"}
	}
	if sess.Driver == DriverCodex {
		return badRequest("Codex's past threads can't be picked here yet")
	}
	if !sess.Exited && sid == conversationSession(sess.conv) {
		return nil
	}
	if other, ok := b.runningAgentSessions(ctx, sess.Name)[sid]; ok {
		return httpError{http.StatusConflict, "that conversation is running in " + other + ": open it there"}
	}
	meta, _ := readConversation(sess.conv)
	var history, title string
	if sess.Driver == DriverClaude {
		history = claudeFile(b.claudeHomeFor(ctx, sess), sess.Dir, sid)
		var ok bool
		if title, ok = claudeTitle(history); history == "" || !ok {
			return httpError{http.StatusNotFound, "Claude has no conversation " + sid + " in " + sess.Dir}
		}
	}
	dir, sock, err := b.newConversation()
	if err != nil {
		return err
	}
	fail := func(err error) error {
		os.RemoveAll(dir)
		return err
	}
	if history != "" {
		if err := importHistory(dir, history); err != nil {
			return fail(err)
		}
	}
	mode := firstNonEmpty(modeFor(sess), meta.Mode)
	noteConversation(dir, func(c *Conversation) {
		c.Agent, c.Location, c.Dir, c.Session = firstNonEmpty(meta.Agent, agentFor(sess)), sess.Location, sess.Dir, sess.Name
		c.AgentSessionID, c.Mode, c.Title, c.Created = sid, mode, title, time.Now().UTC()
	})
	l, err := b.relaunch(ctx, sess.Location, dir, sock, sid, mode)
	if err != nil {
		return fail(err)
	}
	l.labels[labelHandoff] = ""
	b.forgetConversation(sess.Name)
	from := logEnd(dir)
	if err := b.respawnAgent(ctx, sess, l.command, l.env, l.labels); err != nil {
		return fail(err)
	}
	noteResumed(dir, sess.Name)
	if f := awaitStart(dir, sock, from, 15*time.Second); f != nil {
		noteFailed(dir, f)
		return launchFailed(l.agent, f)
	}
	if live, err := b.Sessions.Get(ctx, sess.Name); err == nil {
		b.startStructured(origin(r), gateOrigin(r), live, "")
	}
	// The tab is named after what it holds now.
	if title != "" && b.Sessions.SetTitle(ctx, sess.Name, title) == nil {
		b.publish(r, "session.renamed", map[string]any{"name": sess.Name})
	}
	return nil
}

// importHistory copies a Claude Code conversation's transcript into a new
// conversation's log, so its chat shows what was said before it carries on.
func importHistory(convDir, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	log, err := agenthost.OpenLog(convDir)
	if err != nil {
		return err
	}
	defer log.Close()
	rd := bufio.NewReaderSize(f, 256<<10)
	for {
		line, err := rd.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 && json.Valid(line) {
			if _, aerr := log.Append(agenthost.Entry{Dir: "out", Event: "imported", Data: json.RawMessage(line)}); aerr != nil {
				return aerr
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
