package box

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/cosscom/shipyard/internal/transcript"
)

// transcriptFile is which agent a session runs and the file holding its
// conversation, for the conversation and for a tool call's details alike.
// all is the box's sessions when the caller has just listed them (each
// list is a tmux command); nil lists them here.
func (b *Box) transcriptFile(ctx context.Context, sess Session, all []Session) (agent, path, where string) {
	// Sessions.Get doesn't name the agent (the list does, in enrich): the
	// preset a session was started with, else its command's first word,
	// which is all a session from before presets has.
	agent = sess.Preset
	if agent == "" {
		agent = sess.Agent
	}
	if agent == "" {
		agent = agentOf(sess.Command)
	}
	if sess.Service != "" {
		// A service's terminal has no conversation.
		agent = ""
	}
	var id string
	if b.Turns != nil {
		if st, ok := b.Turns.State(sess.Name); ok {
			id = st.AgentSessionID
		}
	}
	switch agent {
	case "claude":
		// Every Claude session in this folder gets its own transcript, in
		// the folder of the account it started on (the usage plugin's
		// accounts set CLAUDE_CONFIG_DIR per box or project).
		configDir := b.Sessions.EnvVar(ctx, sess, "CLAUDE_CONFIG_DIR")
		claims := []transcript.Claim{{Name: sess.Name, ID: id, Started: sess.Created, ConfigDir: configDir}}
		if all == nil {
			all, _ = b.Sessions.List(ctx)
		}
		for _, o := range all {
			if o.Name == sess.Name || o.Dir != sess.Dir || o.Exited || o.Service != "" {
				continue
			}
			if a := firstNonEmpty(o.Preset, firstNonEmpty(o.Agent, agentOf(o.Command))); a != "claude" {
				continue
			}
			var oid string
			if b.Turns != nil {
				if st, ok := b.Turns.State(o.Name); ok {
					oid = st.AgentSessionID
				}
			}
			claims = append(claims, transcript.Claim{Name: o.Name, ID: oid, Started: o.Created, ConfigDir: b.Sessions.EnvVar(ctx, o, "CLAUDE_CONFIG_DIR")})
		}
		path = transcript.AssignClaude(sess.Dir, claims)[sess.Name]
		where = transcript.ClaudeDirIn(configDir, sess.Dir)
	case "codex":
		codexHome := b.Sessions.EnvVar(ctx, sess, "CODEX_HOME")
		path = transcript.CodexPathIn(codexHome, sess.Dir, id, sess.Created)
		where = filepath.Join(firstNonEmpty(codexHome, "~/.codex"), "sessions")
	}
	return agent, path, where
}

// The Conversation view's data: GET /v1/sessions/{name}/transcript?since=N
// reads the session's agent's own transcript (internal/transcript). Like
// the screen, it is the session's content, so only paired peers reach it;
// tool output and thinking are never included, and nothing is stored.

var (
	transcriptsOnce sync.Once
	transcripts     *transcript.Reader
)

func (b *Box) transcript(w http.ResponseWriter, r *http.Request) error {
	transcriptsOnce.Do(func() { transcripts = transcript.NewReader() })
	// One list of the sessions finds this one and the others in its
	// folder: a chat polls this every few seconds.
	sess, all, err := b.Sessions.getWithAll(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	if r.URL.Query().Has("before") {
		if source, path := b.driverFor(sess).Record(r.Context(), sess, all); path != "" {
			return olderPage(w, r, source, path, sess.Dir)
		}
	}
	since, _ := strconv.Atoi(r.URL.Query().Get("since"))
	res, err := b.driverFor(sess).Conversation(r.Context(), sess, all, since, r.URL.Query().Get("gen"))
	if err != nil {
		return err
	}
	writeJSON(w, res)
	return nil
}

// toolDetail answers GET /v1/sessions/{name}/transcript/tool/{id}: one tool
// call opened up (the full command and its output, an edit's exact change),
// read when someone expands it and never kept.
func (b *Box) toolDetail(w http.ResponseWriter, r *http.Request) error {
	sess, all, err := b.Sessions.getWithAll(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	// The file the chat was read from, so its ids are the ones it gave: a
	// structured session's is berthd's own log, not the agent's.
	source, path := b.driverFor(sess).Record(r.Context(), sess, all)
	if path == "" || source == transcript.SourceACPHost {
		return httpError{http.StatusNotFound, "this session's conversation can't be read"}
	}
	d, err := transcript.Detail(source, path, sess.Dir, r.PathValue("id"))
	if errors.Is(err, transcript.ErrNoTool) {
		return httpError{http.StatusNotFound, "that step is no longer in the conversation"}
	}
	if err != nil {
		return err
	}
	writeJSON(w, d)
	return nil
}

// toolImage answers GET /v1/sessions/{name}/transcript/tool/{id}/image/{n}:
// the n-th picture a call returned, as the transcript holds it (not the
// file it was read from, which may be gone or changed since).
func (b *Box) toolImage(w http.ResponseWriter, r *http.Request) error {
	sess, all, err := b.Sessions.getWithAll(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	source, path := b.driverFor(sess).Record(r.Context(), sess, all)
	if path == "" {
		return httpError{http.StatusNotFound, "this session's conversation can't be read"}
	}
	return serveToolImage(w, source, path, r.PathValue("id"), r.PathValue("n"))
}

// serveToolImage sends a call's picture, decoded from the transcript at
// path. A call's pictures never change, so the app may keep them.
func serveToolImage(w http.ResponseWriter, source, path, id, n string) error {
	i, err := strconv.Atoi(n)
	if err != nil {
		i = -1
	}
	typ, data, err := transcript.Image(source, path, id, i)
	if errors.Is(err, transcript.ErrNoImage) {
		return httpError{http.StatusNotFound, "that step returned no such image"}
	}
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "private, max-age=86400, immutable")
	return writePicture(w, typ, data)
}
