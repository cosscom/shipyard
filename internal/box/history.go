package box

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// A conversation's history beyond its live end (the "history" capability):
// older items a page at a time (GET …/transcript?before=OFF), the helpers'
// own conversations (…/subagents), a fork that goes on from any prompt in
// a new session, and a rewind to before one, driven through the agent's
// own /rewind. Like the transcript, these are the session's content: only
// paired peers reach them, and nothing is stored but a fork's own record.

func (b *Box) mountHistory(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("GET /v1/sessions/{name}/subagents", b.listHelpers)
	route("GET /v1/sessions/{name}/subagents/{id}/transcript", b.helperTranscript)
	route("GET /v1/sessions/{name}/subagents/{id}/tool/{tool}", b.helperTool)
	route("POST /v1/sessions/{name}/fork", b.forkSession)
	route("POST /v1/sessions/{name}/rewind", b.rewindSession)
}

func reader() *transcript.Reader {
	transcriptsOnce.Do(func() { transcripts = transcript.NewReader() })
	return transcripts
}

// olderPage answers ?before=OFF on a transcript: the items made before
// that offset, a page at a time, read afresh and never kept.
func olderPage(w http.ResponseWriter, r *http.Request, agent, path, dir string) error {
	before, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	if err != nil || before < 0 {
		return badRequest("before must be an offset")
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	res, err := transcript.Before(agent, path, dir, before, limit)
	if err != nil {
		return err
	}
	writeJSON(w, res)
	return nil
}

// claudeRecord is a session's Claude Code record, or why there is none.
func (b *Box) claudeRecord(r *http.Request) (Session, string, error) {
	sess, all, err := b.Sessions.getWithAll(r.Context(), r.PathValue("name"))
	if err != nil {
		return Session{}, "", err
	}
	agent, path, _ := b.transcriptFile(r, sess, all)
	switch {
	case agent != "claude":
		return sess, "", httpError{http.StatusBadRequest, "this works with Claude Code's conversations; this session runs " + firstNonEmpty(agent, "no agent")}
	case path == "":
		return sess, "", httpError{http.StatusNotFound, "this session's conversation can't be read yet"}
	}
	return sess, path, nil
}

// listHelpers answers GET /v1/sessions/{name}/subagents: the helpers the
// agent started, each with the call that started it and whether it works.
func (b *Box) listHelpers(w http.ResponseWriter, r *http.Request) error {
	sess, path, err := b.claudeRecord(r)
	if err != nil {
		var he httpError
		if errors.As(err, &he) && he.status == http.StatusBadRequest {
			writeJSON(w, map[string]any{"helpers": []transcript.Helper{}})
			return nil
		}
		return err
	}
	hs := transcript.Helpers(path)
	// The crew, from the conversation followed live, says which still work.
	res, err := reader().Read("claude", path, sess.Dir, 1<<30)
	if err != nil {
		return err
	}
	transcript.MatchHelpers(hs, res.Crew, time.Now())
	writeJSON(w, map[string]any{"helpers": hs})
	return nil
}

func (b *Box) helperFile(r *http.Request) (Session, string, error) {
	sess, path, err := b.claudeRecord(r)
	if err != nil {
		return sess, "", err
	}
	hp, ok := transcript.HelperPath(path, r.PathValue("id"))
	if !ok {
		return sess, "", httpError{http.StatusNotFound, "that helper's conversation isn't on this box"}
	}
	return sess, hp, nil
}

// helperTranscript answers GET …/subagents/{id}/transcript?since=N (or
// ?before=OFF): a helper's own conversation, read as the session's is.
func (b *Box) helperTranscript(w http.ResponseWriter, r *http.Request) error {
	sess, hp, err := b.helperFile(r)
	if err != nil {
		return err
	}
	if r.URL.Query().Has("before") {
		return olderPage(w, r, "claude", hp, sess.Dir)
	}
	since, _ := strconv.Atoi(r.URL.Query().Get("since"))
	res, err := reader().Read("claude", hp, sess.Dir, max(since, 0))
	if err != nil {
		return err
	}
	writeJSON(w, res)
	return nil
}

// helperTool answers GET …/subagents/{id}/tool/{tool}: one of a helper's
// calls opened up.
func (b *Box) helperTool(w http.ResponseWriter, r *http.Request) error {
	sess, hp, err := b.helperFile(r)
	if err != nil {
		return err
	}
	d, err := transcript.Detail("claude", hp, sess.Dir, r.PathValue("tool"))
	if errors.Is(err, transcript.ErrNoTool) {
		return httpError{http.StatusNotFound, "that step is no longer in the helper's conversation"}
	}
	if err != nil {
		return err
	}
	writeJSON(w, d)
	return nil
}

// ForkRequest starts a new session that goes on from a point in this one.
type ForkRequest struct {
	// At is the entry to go on from: a prompt's parent (the transcript
	// item's "parent"), so the fork has everything before that prompt.
	// Empty starts afresh, as a fork of the first prompt does.
	At string `json:"at,omitempty"`
	// Text is the fork's first prompt, typed for it once it starts.
	Text  string `json:"text,omitempty"`
	Title string `json:"title,omitempty"`
	// Open asks the app to show it: "tab" or "split".
	Open string `json:"open,omitempty"`
}

// forkSession answers POST /v1/sessions/{name}/fork. Claude Code resumes a
// conversation whole (it truncates one only in print mode), so the fork is
// a copy of its record up to the point, resumed in a new session in the
// same worktree with the same agent. The original is untouched.
func (b *Box) forkSession(w http.ResponseWriter, r *http.Request) error {
	var req ForkRequest
	if err := decode(r, &req); err != nil {
		return err
	}
	if req.Open != "" && req.Open != "split" && req.Open != "tab" {
		return badRequest("open must be split or tab")
	}
	sess, path, err := b.claudeRecord(r)
	if err != nil {
		return err
	}
	p := AgentPreset{ID: "claude", Name: "Claude Code", Command: "claude"}
	name, _, _ := strings.Cut(sess.Location, "/")
	if loc, err := b.Locations.Get(r.Context(), name); err == nil {
		if lp, ok := presetFor(&loc, "claude"); ok {
			p = lp
		}
	}
	if req.At != "" {
		id, err := transcript.ForkClaude(path, req.At)
		if errors.Is(err, transcript.ErrNoEntry) {
			return httpError{http.StatusNotFound, err.Error()}
		}
		if err != nil {
			return err
		}
		p.Command += " --resume " + id
	}
	cmd, err := AgentCommandWith(p, strings.TrimSpace(req.Text), "", "")
	if err != nil {
		return err
	}
	ns, err := b.startSession(r, defaultSessionName(sess.Location, cmd), sess.Location, sess.Dir, cmd, "claude", strings.TrimSpace(req.Text) != "")
	if err != nil {
		return err
	}
	title := req.Title
	if title == "" {
		title = "Fork of " + firstNonEmpty(strings.TrimPrefix(sess.Title, "Fork of "), "the conversation")
	}
	ns = b.titleNew(r.Context(), ns, title, req.Text)
	b.announceOpen(r, ns, req.Open)
	writeJSON(w, ns)
	return nil
}

// RewindRequest takes a Claude Code conversation back to before a prompt.
type RewindRequest struct {
	// Text is the prompt; Nth which of the prompts reading so, counting
	// back from the newest (0).
	Text string `json:"text"`
	Nth  int    `json:"nth,omitempty"`
	// Restore is "conversation" (the default), "both" (and the code), or
	// "code".
	Restore string `json:"restore,omitempty"`
}

// RewindResult says what was restored, and gives back the prompt to edit.
type RewindResult struct {
	Restored string `json:"restored"`
	Text     string `json:"text"`
}

var rewinding sync.Map // session name → *sync.Mutex

// rewindSession answers POST /v1/sessions/{name}/rewind by driving Claude
// Code's own /rewind: open its list, move up to the prompt (checking the
// highlighted line each step), take the restore asked for, and clear the
// prompt it hands back so the reply box is where it is edited. Anything
// unexpected backs out with Esc and says so; nothing is guessed.
func (b *Box) rewindSession(w http.ResponseWriter, r *http.Request) error {
	var req RewindRequest
	if err := decode(r, &req); err != nil {
		return err
	}
	want := pickerText(req.Text)
	if want == "" {
		return badRequest("say which prompt to rewind to")
	}
	switch req.Restore {
	case "":
		req.Restore = "conversation"
	case "conversation", "both", "code":
	default:
		return badRequest("restore must be conversation, both or code")
	}
	sess, _, err := b.claudeRecord(r)
	if err != nil {
		return err
	}
	if b.Turns != nil {
		if st, ok := b.Turns.State(sess.Name); ok && (st.State == "running" || st.State == "waiting") {
			return httpError{http.StatusConflict, "Claude is " + map[string]string{"running": "working", "waiting": "waiting for an answer"}[st.State] + ": rewind once it is idle"}
		}
	}
	mu, _ := rewinding.LoadOrStore(sess.Name, &sync.Mutex{})
	if !mu.(*sync.Mutex).TryLock() {
		return httpError{http.StatusConflict, "already rewinding this conversation"}
	}
	defer mu.(*sync.Mutex).Unlock()

	res, err := b.driveRewind(r.Context(), sess.Name, want, req.Nth, req.Restore)
	if err != nil {
		return err
	}
	res.Text = strings.TrimSpace(req.Text)
	b.publish(r, "session.rewound", map[string]any{"name": sess.Name, "path": sess.Dir, "restored": res.Restored})
	writeJSON(w, res)
	return nil
}

const (
	rewindHeader  = "Restore the code and/or conversation to the point before"
	rewindConfirm = "Confirm you want to restore"
)

func (b *Box) driveRewind(ctx context.Context, name, want string, nth int, restore string) (RewindResult, error) {
	s := b.Sessions
	target := "=" + name + ":"
	keys := func(k ...string) error {
		out, err := s.tmux(ctx, append([]string{"send-keys", "-t", target}, k...)...)
		if err != nil {
			return tmuxSendError("send-keys", out, err)
		}
		return nil
	}
	screen := func(esc bool) string {
		args := []string{"capture-pane", "-p", "-J", "-t", target}
		if esc {
			args = append(args, "-e")
		}
		out, _ := s.tmux(ctx, args...)
		return string(out)
	}
	// until reads the screen until ok says it shows what is next.
	until := func(d time.Duration, ok func(string) bool) (string, bool) {
		end := time.Now().Add(d)
		for {
			sc := screen(false)
			if ok(sc) {
				return sc, true
			}
			if time.Now().After(end) || ctx.Err() != nil {
				return sc, false
			}
			time.Sleep(60 * time.Millisecond)
		}
	}
	fail := func(msg string) (RewindResult, error) {
		_ = keys("Escape")
		time.Sleep(150 * time.Millisecond)
		if strings.Contains(screen(false), rewindHeader) || strings.Contains(screen(false), rewindConfirm) {
			_ = keys("Escape")
		}
		return RewindResult{}, httpError{http.StatusConflict, msg}
	}

	if typedInPrompt(screen(true)) {
		return RewindResult{}, httpError{http.StatusConflict, "something is typed in Claude's prompt: send or clear it in the terminal first"}
	}
	if err := keys("-l", "/rewind"); err != nil {
		return RewindResult{}, err
	}
	time.Sleep(150 * time.Millisecond)
	if err := keys("Enter"); err != nil {
		return RewindResult{}, err
	}
	sc, ok := until(4*time.Second, func(sc string) bool { return strings.Contains(sc, rewindHeader) })
	if !ok {
		return fail("Claude didn't open its rewind list (this Claude Code may not have /rewind)")
	}
	// Up from "(current)", one prompt at a time, until the highlighted one
	// is the nth that reads as wanted.
	prev, seen := pickedLine(sc), 0
	found := false
	for step := 0; step < 400 && !found; step++ {
		if err := keys("Up"); err != nil {
			return RewindResult{}, err
		}
		sc, ok = until(800*time.Millisecond, func(sc string) bool { return pickedLine(sc) != prev })
		if !ok { // the top of the list
			break
		}
		prev = pickedLine(sc)
		if samePrompt(prev, want) {
			if seen == nth {
				found = true
			}
			seen++
		}
	}
	if !found {
		return fail("that prompt isn't in Claude's rewind list")
	}
	if err := keys("Enter"); err != nil {
		return RewindResult{}, err
	}
	sc, ok = until(3*time.Second, func(sc string) bool { return strings.Contains(sc, rewindConfirm) && len(menuOptions(sc)) > 0 })
	if !ok {
		return fail("Claude didn't ask how to rewind")
	}
	opts := menuOptions(sc)
	labels := map[string]string{"both": "Restore code and conversation", "conversation": "Restore conversation", "code": "Restore code"}
	key, restored := opts[labels[restore]], restore
	if key == "" && restore == "both" {
		// No code changed since that prompt: only the conversation goes back.
		key, restored = opts[labels["conversation"]], "conversation"
	}
	if key == "" {
		return fail("Claude doesn't offer that restore here")
	}
	if err := keys(key); err != nil {
		return RewindResult{}, err
	}
	if _, ok := until(5*time.Second, func(sc string) bool {
		return !strings.Contains(sc, rewindConfirm) && !strings.Contains(sc, rewindHeader)
	}); !ok {
		return fail("Claude didn't finish rewinding")
	}
	// Claude hands the prompt back in its own box; the reply box is where
	// it is edited now, so its box is cleared (Ctrl+Y there brings it back).
	for i := 0; i <= strings.Count(want, "\n")+8 && typedInPrompt(screen(true)); i++ {
		_ = keys("C-u")
		_ = keys("BSpace")
		time.Sleep(40 * time.Millisecond)
	}
	return RewindResult{Restored: restored}, nil
}

var (
	ansiSeq  = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)
	optionRe = regexp.MustCompile(`^\s*(?:❯[\s\x{a0}]*)?([1-9])\.[\s\x{a0}]+(.+?)\s*$`)
)

// pickerText is how a prompt reads in Claude Code's lists: its words on
// one line.
func pickerText(s string) string { return strings.Join(strings.Fields(s), " ") }

// samePrompt says a highlighted line is the prompt wanted: lists cut long
// prompts with "…".
func samePrompt(line, want string) bool {
	line = pickerText(strings.TrimSuffix(strings.TrimSpace(line), "…"))
	return line != "" && (line == want || (len(line) >= 12 && strings.HasPrefix(want, line)))
}

// pickedLine is the highlighted line of the rewind list, below its header.
func pickedLine(sc string) string {
	i := strings.LastIndex(sc, rewindHeader)
	if i < 0 {
		return ""
	}
	for _, l := range strings.Split(sc[i:], "\n")[1:] {
		if t := strings.TrimSpace(l); strings.HasPrefix(t, "❯") {
			return strings.TrimSpace(strings.TrimPrefix(t, "❯"))
		}
	}
	return ""
}

// menuOptions are a confirmation's numbered options by label.
func menuOptions(sc string) map[string]string {
	out := map[string]string{}
	i := strings.LastIndex(sc, rewindConfirm)
	if i < 0 {
		return out
	}
	for _, l := range strings.Split(sc[i:], "\n") {
		if m := optionRe.FindStringSubmatch(l); m != nil {
			out[m[2]] = m[1]
		}
	}
	return out
}

// typedInPrompt says Claude Code's prompt holds typed words, from a screen
// read with its colours: a suggestion it offers is dim and doesn't count.
func typedInPrompt(sc string) bool {
	lines := strings.Split(sc, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := lines[i]
		j := strings.Index(l, "❯")
		if j < 0 {
			continue
		}
		rest := l[j+len("❯"):]
		plain := strings.TrimSpace(ansiSeq.ReplaceAllString(rest, ""))
		if plain == "" {
			return false
		}
		// The first styling after the marker: dim (2) is a suggestion.
		if m := ansiSeq.FindString(strings.TrimLeft(rest, " ")); m != "" && strings.HasPrefix(strings.TrimLeft(rest, " "), m) {
			return !strings.Contains(m, "[2m") && !strings.Contains(m, ";2m") && !strings.HasPrefix(m, "\x1b[2;")
		}
		return true
	}
	return false
}
