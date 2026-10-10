package box

import (
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// transcriptFile is which agent a session runs and the file holding its
// conversation, for the conversation and for a tool call's details alike.
// all is the box's sessions when the caller has just listed them (each
// list is a tmux command); nil lists them here.
func (b *Box) transcriptFile(r *http.Request, sess Session, all []Session) (agent, path, where string) {
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
		configDir := b.Sessions.EnvVar(r.Context(), sess, "CLAUDE_CONFIG_DIR")
		claims := []transcript.Claim{{Name: sess.Name, ID: id, Started: sess.Created, ConfigDir: configDir}}
		if all == nil {
			all, _ = b.Sessions.List(r.Context())
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
			claims = append(claims, transcript.Claim{Name: o.Name, ID: oid, Started: o.Created, ConfigDir: b.Sessions.EnvVar(r.Context(), o, "CLAUDE_CONFIG_DIR")})
		}
		path = transcript.AssignClaude(sess.Dir, claims)[sess.Name]
		where = transcript.ClaudeDirIn(configDir, sess.Dir)
	case "codex":
		codexHome := b.Sessions.EnvVar(r.Context(), sess, "CODEX_HOME")
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
	since, _ := strconv.Atoi(r.URL.Query().Get("since"))
	agent, path, where := b.transcriptFile(r, sess, all)
	none := func(reason string) error {
		writeJSON(w, transcript.Result{Source: "none", Items: []transcript.Item{}, Crew: []transcript.CrewMember{}, Reason: reason})
		return nil
	}
	switch {
	case agent != "claude" && agent != "codex":
		return none("Shipyard reads Claude Code's and Codex's conversations; this session runs " + firstNonEmpty(agent, "no agent") + ".")
	case path == "":
		return none("No " + agent + " conversation for " + sess.Dir + " since " + sess.Created.Format(time.RFC3339) + " in " + where + ".")
	}
	if r.URL.Query().Has("before") {
		return olderPage(w, r, agent, path, sess.Dir)
	}
	// A chat reads this while it shows: tell it as soon as the agent writes.
	b.transcriptWatch().seen(sess.Name, sess.Dir, path)
	// gen is the reading since counts in: one the box let go is read
	// afresh, and answered whole (transcript.Result.Gen).
	res, err := transcripts.Follow(agent, path, sess.Dir, max(since, 0), r.URL.Query().Get("gen"))
	if err != nil {
		return none("Couldn't read " + path + ": " + err.Error())
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
	agent, path, _ := b.transcriptFile(r, sess, all)
	if path == "" {
		return httpError{http.StatusNotFound, "this session's conversation can't be read"}
	}
	d, err := transcript.Detail(agent, path, sess.Dir, r.PathValue("id"))
	if errors.Is(err, transcript.ErrNoTool) {
		return httpError{http.StatusNotFound, "that step is no longer in the conversation"}
	}
	if err != nil {
		return err
	}
	writeJSON(w, d)
	return nil
}
