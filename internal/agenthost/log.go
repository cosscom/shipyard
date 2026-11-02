// Package agenthost keeps a structured agent (Claude Code's stream-json,
// Codex's app-server, an ACP agent) alive apart from berthd. `berthd
// agent-host` runs in the agent's tmux session, owns the agent's stdin and
// stdout, writes everything that passes between them to the conversation's
// log, and serves that log and the agent's stdin on a unix socket. berthd
// can restart or upgrade, or the laptop's link drop, and the agent keeps
// working: berthd attaches again from the last entry it saw.
//
// The log is berthd's own record of the conversation, so nothing the agent
// streamed is lost when it is killed mid-turn (the agents' own transcripts
// keep only finished messages).
package agenthost

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Entry is one line of a conversation's log.
type Entry struct {
	// Seq numbers the entries from 1, across every host that ran in the
	// conversation's folder (a resumed conversation carries on its log).
	Seq int64 `json:"seq"`
	// At is when the entry was written, in Unix milliseconds.
	At int64 `json:"at"`
	// Dir is where it came from: "out" the agent's stdout, "in" what was
	// written to its stdin, "err" its stderr, "host" the host itself.
	Dir string `json:"dir"`
	// Data is a JSON line as the agent wrote or was sent it.
	Data json.RawMessage `json:"data,omitempty"`
	// Text is a line that isn't JSON, or what a host entry says.
	Text string `json:"text,omitempty"`
	// Event is a host entry's kind: "started" (PID and Argv set) or
	// "exited" (Code set; -1 when the agent was killed by a signal).
	Event string `json:"event,omitempty"`
	PID   int    `json:"pid,omitempty"`
	Code  *int   `json:"code,omitempty"`
	// Argv is the agent's command as it was run, word for word: Text joins
	// it with spaces, which can't tell an argument with a space in it, or
	// an empty one, from the words around it.
	Argv []string `json:"argv,omitempty"`
}

// LogName and SocketName are the files a host keeps in its folder.
const (
	LogName    = "events.jsonl"
	SocketName = "host.sock"
)

// subBuffer is how many entries an attached reader may fall behind before
// it is let go (it attaches again from the last entry it saw).
const subBuffer = 1024

// Log is a conversation's log, appended to by one host, and the readers
// following it live.
type Log struct {
	mu   sync.Mutex
	f    *os.File
	last int64
	subs map[chan Entry]struct{}
}

// OpenLog opens the log in dir, carrying on its numbering. A line cut short
// (a host that died mid-write) is dropped.
func OpenLog(dir string) (*Log, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, LogName)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	var last, good int64
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			break // a line without its newline is cut short
		}
		var e Entry
		if json.Unmarshal(line, &e) == nil {
			last = e.Seq
		}
		good += int64(len(line))
	}
	if err := f.Truncate(good); err != nil {
		f.Close()
		return nil, err
	}
	if _, err := f.Seek(good, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	return &Log{f: f, last: last, subs: map[chan Entry]struct{}{}}, nil
}

// Append numbers e, writes it, and hands it to the readers following.
func (l *Log) Append(e Entry) (Entry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return e, errors.New("the log is closed")
	}
	e.Seq = l.last + 1
	if e.At == 0 {
		e.At = time.Now().UnixMilli()
	}
	b, err := json.Marshal(e)
	if err != nil {
		return e, err
	}
	if _, err := l.f.Write(append(b, '\n')); err != nil {
		return e, err
	}
	l.last = e.Seq
	for ch := range l.subs {
		select {
		case ch <- e:
		default:
			// Too far behind: let it go, so one slow reader never holds
			// the agent up.
			delete(l.subs, ch)
			close(ch)
		}
	}
	return e, nil
}

// Follow sends the entries after from, then every new one, to the channel
// it returns, with none missed or repeated between the two. The channel
// closes when the log does, or when the reader falls too far behind; stop
// lets it go.
func (l *Log) Follow(from int64) (ch <-chan Entry, stop func(), err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil, nil, errors.New("the log is closed")
	}
	var past []Entry
	if from < l.last {
		err := ReadLog(l.f.Name(), from, func(e Entry) error {
			past = append(past, e)
			return nil
		})
		if err != nil {
			return nil, nil, err
		}
	}
	c := make(chan Entry, len(past)+subBuffer)
	for _, e := range past {
		c <- e
	}
	l.subs[c] = struct{}{}
	stop = func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		if _, ok := l.subs[c]; ok {
			delete(l.subs, c)
			close(c)
		}
	}
	return c, stop, nil
}

// Close ends the log and every reader's channel.
func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for ch := range l.subs {
		close(ch)
	}
	l.subs = map[chan Entry]struct{}{}
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// ReadLog calls fn with each entry in the log at path after from, in
// order. A missing log has none.
func ReadLog(path string, from int64, fn func(Entry) error) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return nil // the end, or a line still being written
		}
		var e Entry
		if json.Unmarshal(bytes.TrimSpace(line), &e) != nil || e.Seq <= from {
			continue
		}
		if err := fn(e); err != nil {
			return err
		}
	}
}
