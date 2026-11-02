package agenthost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Options say what a host runs and where it keeps it.
type Options struct {
	// Dir is the conversation's folder: its log and, by default, socket.
	Dir string
	// Socket is where the host listens; empty is Dir/host.sock. A unix
	// socket's path is limited to about 100 bytes.
	Socket string
	// Command is the agent and its arguments; WorkDir where it runs (empty
	// is the host's own); Env its environment (nil is the host's own).
	Command []string
	WorkDir string
	Env     []string
	// Render, when set, gets a line for each entry: the tmux pane, so
	// someone attached sees the agent work.
	Render io.Writer
	// StopGrace is how long the agent has to end after its stdin closes,
	// and again after SIGTERM; 0 is 5 seconds.
	StopGrace time.Duration
}

// request is one call on the socket, a JSON line: "attach" streams the log
// from From (one Entry per line, until the agent ends); "write" gives the
// agent Data as one line of its stdin; "stop" ends it.
type request struct {
	Op   string          `json:"op"`
	From int64           `json:"from,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// reply answers a write or a stop.
type reply struct {
	Seq   int64  `json:"seq,omitempty"`
	Error string `json:"error,omitempty"`
}

// Run starts the agent, keeps its log and serves its socket until it ends,
// and returns its exit code (-1 for a signal). Cancelling ctx stops the
// agent as Stop does.
func Run(ctx context.Context, o Options) (int, error) {
	if len(o.Command) == 0 {
		return 0, errors.New("agent-host: no command to run")
	}
	if o.StopGrace <= 0 {
		o.StopGrace = 5 * time.Second
	}
	sock := o.Socket
	if sock == "" {
		sock = filepath.Join(o.Dir, SocketName)
	}
	log, err := OpenLog(o.Dir)
	if err != nil {
		return 0, err
	}
	defer log.Close()
	ln, err := listen(sock)
	if err != nil {
		return 0, err
	}
	defer os.Remove(sock)
	defer ln.Close()

	cmd := exec.Command(o.Command[0], o.Command[1:]...)
	cmd.Dir, cmd.Env = o.WorkDir, o.Env
	// Its own group, so a stop reaches what it starts.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return 0, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		e := Entry{Dir: "host", Event: "exited", Text: err.Error(), Code: intp(127)}
		log.Append(e)
		return 127, err
	}
	h := &host{log: log, stdin: stdin, pid: cmd.Process.Pid, grace: o.StopGrace, render: o.Render, exited: make(chan struct{})}
	h.note(Entry{Dir: "host", Event: "started", PID: h.pid, Text: strings.Join(o.Command, " "), Argv: o.Command})

	var reading sync.WaitGroup
	reading.Add(2)
	go func() { defer reading.Done(); h.read(stdout, "out") }()
	go func() { defer reading.Done(); h.read(stderr, "err") }()
	go h.serve(ln)
	go func() {
		select {
		case <-ctx.Done():
			h.stop()
		case <-h.exited:
		}
	}()

	st, werr := cmd.Process.Wait()
	close(h.exited)
	h.inMu.Lock()
	stdin.Close()
	h.inMu.Unlock()
	// What it wrote is read to the end before its exit is logged, so the
	// exit is the last entry. Something it started may still hold its
	// stdout open: that is cut off after a moment.
	drained := make(chan struct{})
	go func() { reading.Wait(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		stdout.Close()
		stderr.Close()
		<-drained
	}
	code := -1
	if werr == nil && st != nil {
		code = st.ExitCode()
	}
	h.note(Entry{Dir: "host", Event: "exited", Code: intp(code)})
	// Readers get the exit before the host goes: the log's close ends
	// their streams once they have it.
	ln.Close()
	h.connMu.Lock()
	h.done = true
	h.connMu.Unlock()
	log.Close()
	flushed := make(chan struct{})
	go func() { h.conns.Wait(); close(flushed) }()
	select {
	case <-flushed:
	case <-time.After(2 * time.Second):
	}
	return code, nil
}

func intp(i int) *int { return &i }

// listen makes the socket, refusing one a live host still answers on.
func listen(sock string) (net.Listener, error) {
	if c, err := net.DialTimeout("unix", sock, time.Second); err == nil {
		c.Close()
		return nil, fmt.Errorf("agent-host: another host is running on %s", sock)
	}
	os.Remove(sock)
	if err := os.MkdirAll(filepath.Dir(sock), 0o700); err != nil {
		return nil, err
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return nil, err
	}
	os.Chmod(sock, 0o600)
	return ln, nil
}

type host struct {
	log    *Log
	pid    int
	grace  time.Duration
	render io.Writer

	inMu  sync.Mutex
	stdin io.WriteCloser

	stopOnce sync.Once
	exited   chan struct{}
	// conns are the calls being answered; once done is set no more start.
	connMu sync.Mutex
	done   bool
	conns  sync.WaitGroup
}

// note logs an entry and draws it.
func (h *host) note(e Entry) (Entry, error) {
	e, err := h.log.Append(e)
	if err == nil && h.render != nil {
		fmt.Fprintln(h.render, renderLine(e))
	}
	return e, err
}

// read logs each line from the agent's stdout or stderr. Lines can be long
// (a tool's whole output): they are read whole.
func (h *host) read(r io.Reader, dir string) {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := br.ReadBytes('\n')
		if s := strings.TrimRight(string(line), "\r\n"); s != "" {
			e := Entry{Dir: dir}
			if dir == "out" && json.Valid([]byte(s)) {
				e.Data = json.RawMessage(s)
			} else {
				e.Text = s
			}
			h.note(e)
		}
		if err != nil {
			return
		}
	}
}

// write gives the agent one JSON line, logging it first.
func (h *host) write(data json.RawMessage) (int64, error) {
	if !json.Valid(data) {
		return 0, errors.New("data must be JSON")
	}
	var one bytes.Buffer
	if err := json.Compact(&one, data); err != nil {
		return 0, err
	}
	h.inMu.Lock()
	defer h.inMu.Unlock()
	select {
	case <-h.exited:
		return 0, errors.New("the agent has ended")
	default:
	}
	e, err := h.note(Entry{Dir: "in", Data: json.RawMessage(one.String())})
	if err != nil {
		return 0, err
	}
	if _, err := io.WriteString(h.stdin, one.String()+"\n"); err != nil {
		return 0, err
	}
	return e.Seq, nil
}

// stop ends the agent: its stdin closes (structured agents end there), then
// SIGTERM, then SIGKILL to everything it started. The processes are found
// before the first signal, since once the agent goes they are no longer
// its children.
func (h *host) stop() {
	h.stopOnce.Do(func() {
		h.inMu.Lock()
		h.stdin.Close()
		h.inMu.Unlock()
		if h.waitExit(h.grace) {
			return
		}
		kids := descendants(h.pid)
		signalTree(h.pid, syscall.SIGTERM)
		if h.waitExit(h.grace) && !anyAlive(kids) {
			return
		}
		for _, p := range kids {
			syscall.Kill(p, syscall.SIGKILL)
		}
		signalTree(h.pid, syscall.SIGKILL)
	})
}

func (h *host) waitExit(d time.Duration) bool {
	select {
	case <-h.exited:
		return true
	case <-time.After(d):
		return false
	}
}

func anyAlive(pids []int) bool {
	for _, p := range pids {
		if syscall.Kill(p, 0) == nil {
			return true
		}
	}
	return false
}

func (h *host) serve(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		h.connMu.Lock()
		if h.done {
			h.connMu.Unlock()
			c.Close()
			continue
		}
		h.conns.Add(1)
		h.connMu.Unlock()
		go func() {
			defer h.conns.Done()
			h.conn(c)
		}()
	}
}

func (h *host) conn(c net.Conn) {
	defer c.Close()
	var req request
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&req); err != nil {
		return
	}
	enc := json.NewEncoder(c)
	switch req.Op {
	case "attach":
		ch, stop, err := h.log.Follow(req.From)
		if err != nil {
			enc.Encode(reply{Error: err.Error()})
			return
		}
		defer stop()
		// A reader that goes away ends its stream.
		gone := make(chan struct{})
		go func() { io.Copy(io.Discard, c); close(gone) }()
		for {
			select {
			case e, ok := <-ch:
				if !ok {
					return
				}
				if enc.Encode(e) != nil {
					return
				}
			case <-gone:
				return
			}
		}
	case "write":
		seq, err := h.write(req.Data)
		if err != nil {
			enc.Encode(reply{Error: err.Error()})
			return
		}
		enc.Encode(reply{Seq: seq})
	case "stop":
		go h.stop()
		<-h.exited
		enc.Encode(reply{})
	default:
		enc.Encode(reply{Error: "unknown op " + req.Op})
	}
}

// renderLine is an entry as one line for the pane.
func renderLine(e Entry) string {
	switch {
	case e.Dir == "host" && e.Event == "exited" && e.Code != nil:
		return fmt.Sprintf("— the agent ended (exit %d)", *e.Code)
	case e.Dir == "host":
		return "— " + e.Event + " " + e.Text
	case e.Data != nil:
		var head struct{ Type, Subtype, Method string }
		json.Unmarshal(e.Data, &head)
		kind := strings.TrimSpace(strings.Join([]string{head.Type, head.Subtype, head.Method}, " "))
		return e.Dir + " " + firstNonEmpty(kind, "json")
	default:
		t := e.Text
		if len(t) > 200 {
			t = t[:200] + "…"
		}
		return e.Dir + " " + t
	}
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
