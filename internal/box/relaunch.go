package box

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
)

// A structured conversation's agent is started again (resumed in its pane,
// in a new session, or on another of its conversations) from what berthd
// knows of it: its meta.json and its agent's preset, never a command line
// read back. Whether it came up is read from its log: an agent that exits
// non-zero as it starts (a flag it refuses, a conversation it can't find)
// failed to start, and says why on its stderr. The conversation keeps that
// (Conversation.Failed), so it reads as failed, not as running or as one
// that ended by itself.

// quickExit is how long an agent started again has to fail: one that exits
// non-zero sooner failed to start; one that runs this long, or says
// anything on its stdout first, is up.
const quickExit = 3 * time.Second

// maxFailureText is how much of what a failed agent wrote to its stderr
// is kept, from the end.
const maxFailureText = 2 << 10

// LaunchFailure is an agent that exited as it was started again.
type LaunchFailure struct {
	At   time.Time `json:"at"`
	Code int       `json:"code"`
	// Error is the end of what it wrote to its stderr.
	Error string `json:"error,omitempty"`
}

// agentFailed is the error a start that failed answers with (409,
// agent_failed): the agent itself refused to start, not the box.
type agentFailed struct{ msg string }

func (e agentFailed) Error() string { return e.msg }

func launchFailed(agent string, f *LaunchFailure) error {
	who := "The agent"
	if agent == "" || agent == "claude" {
		who = "Claude"
	} else if agent == "codex" {
		who = "Codex"
	}
	msg := who + " exited as it started (code " + strconv.Itoa(f.Code) + ")"
	if f.Error != "" {
		msg += ": " + f.Error
	}
	return agentFailed{msg}
}

// noteFailed keeps a failed start in the conversation's meta.json.
func noteFailed(dir string, f *LaunchFailure) {
	noteConversation(dir, func(c *Conversation) { c.Failed = f })
}

// logEnd is where a conversation's log ends now: what a start writes from
// here is that start's.
func logEnd(conv string) int64 {
	st, err := os.Stat(filepath.Join(conv, agenthost.LogName))
	if err != nil {
		return 0
	}
	return st.Size()
}

// awaitStart waits for an agent started in conv's folder, on sock, to come
// up: its host listening, and its first output, or quickExit gone by with
// it still running. An agent that exits non-zero first failed: the failure
// says how, with what it wrote to its stderr. from is the log's end before
// it was started (logEnd); limit bounds the whole wait, as awaitHost did.
func awaitStart(conv, sock string, from int64, limit time.Duration) *LaunchFailure {
	deadline := time.Now().Add(limit)
	tail := &logReader{path: filepath.Join(conv, agenthost.LogName), at: from}
	var started time.Time
	var stderr []string
	for {
		for _, e := range tail.read() {
			switch {
			case e.Dir == "host" && e.Event == "started":
				started, stderr = time.UnixMilli(e.At), nil
			case e.Dir == "host" && e.Event == "exited" && started.IsZero():
				// Before this start: the host it replaced, killed. Unless the
				// host couldn't run the agent at all (not installed), and
				// says why.
				if e.Text != "" {
					f := &LaunchFailure{At: time.UnixMilli(e.At).UTC(), Code: -1, Error: e.Text}
					if e.Code != nil {
						f.Code = *e.Code
					}
					return f
				}
			case e.Dir == "host" && e.Event == "exited":
				if e.Code == nil || *e.Code == 0 {
					// It ended by itself, as an agent may: not a failure.
					return nil
				}
				return &LaunchFailure{At: time.UnixMilli(e.At).UTC(), Code: *e.Code, Error: lastBytes(stderr, maxFailureText)}
			case e.Dir == "err":
				if t := strings.TrimSpace(e.Text); t != "" {
					stderr = append(stderr, t)
				}
			case e.Dir == "out" && !started.IsZero() && !isResult(e.Data):
				// It said something of its own (a hook, its first event):
				// it took its arguments and is up. A result first is the
				// error it ends with, as for a conversation it can't find.
				return nil
			}
		}
		if !started.IsZero() && time.Since(started) >= quickExit && hostAlive(sock) {
			return nil
		}
		if time.Now().After(deadline) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// isResult says a stream-json line is a turn's result.
func isResult(data json.RawMessage) bool {
	var l struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(data, &l) == nil && l.Type == "result"
}

// lastBytes joins lines, keeping at most max bytes from the end.
func lastBytes(lines []string, max int) string {
	s := strings.Join(lines, "\n")
	if len(s) <= max {
		return s
	}
	s = s[len(s)-max:]
	if i := strings.IndexByte(s, '\n'); i >= 0 && i < len(s)-1 {
		s = s[i+1:]
	}
	return "…" + s
}

// logReader reads the entries a log gains from a byte offset on, a whole line
// at a time: a line still being written is read once it is done.
type logReader struct {
	path string
	at   int64
}

func (t *logReader) read() []agenthost.Entry {
	f, err := os.Open(t.path)
	if err != nil {
		return nil
	}
	defer f.Close()
	if _, err := f.Seek(t.at, io.SeekStart); err != nil {
		return nil
	}
	var out []agenthost.Entry
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return out
		}
		t.at += int64(len(line))
		var e agenthost.Entry
		if json.Unmarshal(bytes.TrimSpace(line), &e) == nil {
			out = append(out, e)
		}
	}
}

// conversationRunning says a session runs its structured conversation now:
// its own host answers on its socket. A session left in its agent's
// terminal (no host) runs it while its pane does. Nothing else in the same
// folder counts: another agent there runs its own conversation.
func conversationRunning(s Session) bool {
	if s.conv == "" || s.Exited {
		return false
	}
	if s.sock == "" || !structuredDriver(s.Driver) {
		return true
	}
	return hostAlive(s.sock)
}

// commandConversation is the conversation of this box's that a command line
// runs `berthd agent-host` for, by the folder its --dir names: what an
// older Shipyard sent to start a structured agent again, from the command
// it read back.
func (b *Box) commandConversation(command string) (string, bool) {
	if b.ConversationsDir == "" || !strings.Contains(command, "--dir") {
		return "", false
	}
	words, ok := shellWords(command)
	if !ok {
		return "", false
	}
	if i := slices.Index(words, "--"); i >= 0 {
		words = words[:i]
	}
	// `berthd agent-host`, by any path, or this box's own host command.
	at := slices.Index(words, "agent-host") + 1
	if host, err := b.agentHostCommand(); at == 0 && err == nil && len(words) > len(host) && slices.Equal(words[:len(host)], host) {
		at = len(host)
	}
	if at == 0 {
		return "", false
	}
	for i := at; i+1 < len(words); i++ {
		if words[i] != "--dir" {
			continue
		}
		dir := filepath.Clean(words[i+1])
		if filepath.Dir(dir) != filepath.Clean(b.ConversationsDir) {
			return "", false
		}
		d, err := b.conversationDir(filepath.Base(dir))
		return d, err == nil
	}
	return "", false
}

// shellWords splits a command line into the words sh would give its
// program: single and double quotes and backslashes, as shellQuote writes
// them. ok is false for a quote left open.
func shellWords(s string) (words []string, ok bool) {
	var cur strings.Builder
	in := false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return nil, false
			}
			cur.WriteString(s[i+1 : i+1+j])
			i += j + 1
			in = true
		case '"':
			in = true
			for i++; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) && strings.IndexByte("\\\"$`", s[i+1]) >= 0 {
					i++
				}
				cur.WriteByte(s[i])
			}
			if i >= len(s) {
				return nil, false
			}
		case '\\':
			if i+1 < len(s) {
				i++
				cur.WriteByte(s[i])
			}
			in = true
		case ' ', '\t', '\n':
			if in {
				words = append(words, cur.String())
				cur.Reset()
				in = false
			}
		default:
			cur.WriteByte(c)
			in = true
		}
	}
	if in {
		words = append(words, cur.String())
	}
	return words, true
}
