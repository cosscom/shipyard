package box

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParseSessions(t *testing.T) {
	out := []byte("cal-claude\t1759000000\t1\tcal/billing\tclaude\t0\t/home/alex/work/cal-billing\nold\t1759000100\t0\t\t\t1\t/tmp\n")
	got := parseSessions(out)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	if got[0].Name != "cal-claude" || got[0].Location != "cal/billing" || got[0].Command != "claude" || got[0].Attached != 1 || got[0].Exited || got[0].Dir != "/home/alex/work/cal-billing" {
		t.Errorf("first session = %+v", got[0])
	}
	if !got[1].Exited || got[1].Attached != 0 {
		t.Errorf("second session = %+v", got[1])
	}
}

// Some tmux versions escape "$" when a format reads an option back; the
// base64 copy of the command is what counts when it's there.
func TestParseSessionsPrefersTheEncodedCommand(t *testing.T) {
	command := `echo "${HOME}" && claude`
	escaped := `echo "\${HOME}" && claude`
	out := []byte("a\t1700000000\t0\tcal\t" + escaped + "\t0\t/w\t" + base64.StdEncoding.EncodeToString([]byte(command)) + "\n")
	got := parseSessions(out)
	if len(got) != 1 || got[0].Command != command {
		t.Fatalf("parseSessions = %+v, want command %q", got, command)
	}
}

// testSessions isolates tmux under a private TMUX_TMPDIR so tests never touch
// the developer's own tmux servers.
func testSessions(t *testing.T) *Sessions {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	tmp, err := os.MkdirTemp("/tmp", "cpt")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_TMPDIR", tmp)
	t.Setenv("TMUX", "")
	t.Setenv("SHELL", "/bin/sh")
	s, err := NewSessions(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		exec.Command("tmux", "-L", tmuxSocket, "kill-server").Run()
		os.RemoveAll(tmp)
	})
	return s
}

// launchd starts berthd with no locale. tmux 3.7 then printed formats with
// their tabs as "_", so berthd couldn't read a session it had just made
// and none could start ("the session ended as soon as it started").
func TestSessionsStartWithNoLocale(t *testing.T) {
	s := testSessions(t)
	// TMUX, even empty, also makes tmux assume UTF-8: launchd sets none.
	for _, k := range []string{"LC_ALL", "LC_CTYPE", "LANG", "TMUX"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	ctx := context.Background()
	sess, err := s.Create(ctx, "no-locale", "cal", t.TempDir(), "sleep 30", nil)
	if err != nil {
		t.Fatal(err)
	}
	if sess.Name != "no-locale" || sess.Location != "cal" || sess.Exited {
		t.Fatalf("session = %+v", sess)
	}
}

func TestSessionsLifecycle(t *testing.T) {
	s := testSessions(t)
	ctx := context.Background()
	if all, err := s.List(ctx); err != nil || len(all) != 0 {
		t.Fatalf("empty list = %+v, %v", all, err)
	}
	dir := t.TempDir()
	sess, err := s.Create(ctx, "agent-1", "cal/billing", dir, "echo started-in-$(pwd); sleep 30", nil)
	if err != nil {
		t.Fatal(err)
	}
	resolved, _ := filepath.EvalSymlinks(dir)
	if sess.Location != "cal/billing" || (sess.Dir != dir && sess.Dir != resolved) || sess.Exited {
		t.Fatalf("created session = %+v", sess)
	}
	if _, err := s.Create(ctx, "agent-1", "", dir, "true", nil); !errors.Is(err, ErrSessionExists) {
		t.Fatalf("duplicate session: %v", err)
	}
	for _, bad := range []string{"has space", "a.b", "a:b", ""} {
		if _, err := s.Create(ctx, bad, "", dir, "true", nil); err == nil {
			t.Errorf("created session named %q", bad)
		}
	}
	if err := s.Kill(ctx, "agent-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, "agent-1"); !errors.Is(err, ErrUnknownSession) {
		t.Fatalf("killed session still listed: %v", err)
	}
}

// A task's command carries its prompt, line breaks and all: the session
// must still list, or the task fails ("no session with that name") and
// removes the worktree it just made.
func TestASessionWhoseCommandHasLineBreaksStillLists(t *testing.T) {
	s := testSessions(t)
	ctx := context.Background()
	dir := t.TempDir()
	command := "sleep 30 # 'Reply with hi\nJust that word.\tThanks'"
	sess, err := s.Create(ctx, "task-1", "demo/reply-with-hi", dir, command, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if sess.Command != command || sess.Location != "demo/reply-with-hi" {
		t.Fatalf("created session = %+v", sess)
	}
	if _, err := s.Create(ctx, "other", "demo", dir, "sleep 30", nil); err != nil {
		t.Fatal(err)
	}
	all, err := s.List(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("list = %+v, %v", all, err)
	}
	for _, x := range all {
		if x.Name == "task-1" && x.Command != command {
			t.Errorf("listed command = %q, want %q", x.Command, command)
		}
	}
}

func TestAFinishedProgramStaysVisible(t *testing.T) {
	s := testSessions(t)
	ctx := context.Background()
	if _, err := s.Create(ctx, "quick", "", t.TempDir(), "echo done", nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		sess, err := s.Get(ctx, "quick")
		if err != nil {
			t.Fatalf("a finished session disappeared: %v", err)
		}
		if sess.Exited {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("session never reported its program as exited")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestAttachShowsTheSessionAndCarriesKeystrokes(t *testing.T) {
	s := testSessions(t)
	ctx := context.Background()
	if _, err := s.Create(ctx, "echoer", "", t.TempDir(), "cat", nil); err != nil {
		t.Fatal(err)
	}
	master, cmd, err := s.Attach(ctx, "echoer", 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	defer master.Close()
	var out syncBuffer
	done := make(chan struct{})
	go func() { io.Copy(&out, master); close(done) }()
	time.Sleep(300 * time.Millisecond)
	master.Write([]byte("typed-through-berth\r"))
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(out.String(), "typed-through-berth") {
		if time.Now().After(deadline) {
			t.Fatalf("keystrokes never echoed; screen: %q", out.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// syncBuffer is a bytes.Buffer safe to poll while another goroutine copies
// terminal output into it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestScreenShowsTheSessionsOutput(t *testing.T) {
	s := testSessions(t)
	ctx := context.Background()
	if _, err := s.Create(ctx, "shows", "", t.TempDir(), "echo visible-output; sleep 30", nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		text, err := s.Screen(ctx, "shows", 100)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(text, "visible-output") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("screen = %q", text)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// getAndCapture reads a session as Get does, and its pane, in one tmux
// command.
func TestGetAndCaptureIsGetAndAScreen(t *testing.T) {
	s := testSessions(t)
	ctx := context.Background()
	// Set before any list starts the background sweep, which reads it.
	var mu sync.Mutex
	asked := map[string]int{}
	s.trace = func(args []string) { mu.Lock(); asked[args[0]]++; mu.Unlock() }
	if _, err := s.create(ctx, "both", "acme", t.TempDir(), "printf 'acme ready\\n'; sleep 30", "claude", nil, nil); err != nil {
		t.Fatal(err)
	}
	want, err := s.Get(ctx, "both")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, raw, err := s.getAndCapture(ctx, "both", "-J", "-e")
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("session = %+v, want %+v", got, want)
		}
		if strings.Contains(string(raw), "acme ready") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("screen = %q", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// One read is one display-message, the capture riding along in it.
	mu.Lock()
	clear(asked)
	mu.Unlock()
	s.getAndCapture(ctx, "both")
	mu.Lock()
	if asked["display-message"] != 1 || asked["capture-pane"] != 0 {
		t.Fatalf("one read asked tmux %v", asked)
	}
	mu.Unlock()
	if _, _, err := s.getAndCapture(ctx, "gone"); !errors.Is(err, ErrUnknownSession) {
		t.Fatalf("gone: %v", err)
	}
}

// A session's environment never changes, so EnvVar asks tmux once per
// variable, an unset one included: every chat poll asks it for each agent
// in the folder.
func TestEnvVarAsksTmuxOnce(t *testing.T) {
	s := testSessions(t)
	ctx := context.Background()
	// Set before any list starts the background sweep, which reads it.
	var mu sync.Mutex
	asked := 0
	s.trace = func(args []string) {
		mu.Lock()
		defer mu.Unlock()
		if len(args) > 0 && args[0] == "show-environment" {
			asked++
		}
	}
	sess, err := s.Create(ctx, "envs", "acme", t.TempDir(), "sleep 30", []string{"ACME_HOME=/srv/acme"})
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if v := s.EnvVar(ctx, sess, "ACME_HOME"); v != "/srv/acme" {
			t.Fatalf("ACME_HOME = %q", v)
		}
		if v := s.EnvVar(ctx, sess, "ACME_UNSET"); v != "" {
			t.Fatalf("ACME_UNSET = %q", v)
		}
	}
	mu.Lock()
	if asked != 2 {
		t.Fatalf("asked tmux %d times, want 2", asked)
	}
	mu.Unlock()
	// A session that is gone is not remembered as having it unset.
	gone := Session{Name: "gone", Created: sess.Created}
	s.EnvVar(ctx, gone, "ACME_HOME")
	s.EnvVar(ctx, gone, "ACME_HOME")
	mu.Lock()
	defer mu.Unlock()
	if asked != 4 {
		t.Fatalf("asked tmux %d times for a gone session, want 2 more", asked-2)
	}
}
