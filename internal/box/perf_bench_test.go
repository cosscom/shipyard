package box

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/transcript"
)

// Benchmarks for what the box does over and over while chats are open and
// agents work: answering a chat's poll, reading screens, writing the
// ledger. Each reports how many tmux commands one op ran (execs/op), as a
// fork and exec of tmux costs far more than anything else here.

// benchSessions is testSessions for a benchmark: tmux under a private
// TMUX_TMPDIR, never the developer's own server.
func benchSessions(b *testing.B) (*Sessions, *atomic.Int64) {
	b.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		b.Skip("tmux not installed")
	}
	tmp, err := os.MkdirTemp("/tmp", "cpb")
	if err != nil {
		b.Fatal(err)
	}
	b.Setenv("TMUX_TMPDIR", tmp)
	b.Setenv("TMUX", "")
	b.Setenv("SHELL", "/bin/sh")
	s, err := NewSessions(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		exec.Command("tmux", "-L", tmuxSocket, "kill-server").Run()
		os.RemoveAll(tmp)
	})
	var execs atomic.Int64
	s.trace = func([]string) { execs.Add(1) }
	return s, &execs
}

// cpuPerOp reports berthd's own CPU time per op (cpu-ns/op) when the
// benchmark ends: tmux's is not in it, so execs/op says what it costs.
func cpuPerOp(b *testing.B) func() {
	start := cpuTime()
	return func() {
		if b.N > 0 {
			b.ReportMetric(float64(cpuTime()-start)/float64(b.N), "cpu-ns/op")
		}
	}
}

func cpuTime() int64 {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return ru.Utime.Nano() + ru.Stime.Nano()
}

// BenchmarkTranscriptPoll is one chat's poll of GET …/transcript with
// nothing new, in a folder where three Claude sessions run.
func BenchmarkTranscriptPoll(b *testing.B) {
	ctx := context.Background()
	s, execs := benchSessions(b)
	cfg := b.TempDir()
	b.Setenv("CLAUDE_CONFIG_DIR", cfg)
	dir := b.TempDir()
	for i := range 3 {
		if _, err := s.create(ctx, fmt.Sprintf("acme-%d", i), "acme", dir, "sleep 600", "claude", nil, nil); err != nil {
			b.Fatal(err)
		}
	}
	proj := transcript.ClaudeDir(dir)
	os.MkdirAll(proj, 0o700)
	ts := time.Now().UTC().Format(time.RFC3339Nano)
	var rec strings.Builder
	for i := range 200 {
		fmt.Fprintf(&rec, `{"type":"assistant","timestamp":%q,"uuid":"u%d","message":{"role":"assistant","content":[{"type":"text","text":"step %d of the acme fix"}]}}`+"\n", ts, i, i)
	}
	for i := range 3 {
		os.WriteFile(filepath.Join(proj, fmt.Sprintf("0000000%d-acme-4c1e-9d55-2f7e0c1a9b01.jsonl", i)), []byte(rec.String()), 0o600)
	}
	bx := &Box{Name: "devbox", Sessions: s, Events: &events.Bus{}}
	poll := func() {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/v1/sessions/acme-1/transcript", nil)
		r.SetPathValue("name", "acme-1")
		if err := bx.transcript(w, r); err != nil || !strings.Contains(w.Body.String(), `"source":"claude"`) {
			b.Fatalf("transcript: %v %s", err, w.Body.String())
		}
	}
	poll()
	execs.Store(0)
	b.ReportAllocs()
	defer cpuPerOp(b)()
	n := 0
	for b.Loop() {
		poll()
		n++
	}
	b.ReportMetric(float64(execs.Load())/float64(n), "execs/op")
}

// BenchmarkPollScreens is the 2-second look at the screens of agents no
// hook reports for: four of them, each mid-turn.
func BenchmarkPollScreens(b *testing.B) {
	ctx := context.Background()
	s, execs := benchSessions(b)
	dir := b.TempDir()
	t := &Turns{}
	t.init()
	for i := range 4 {
		name := fmt.Sprintf("acme-%d", i)
		if _, err := s.create(ctx, name, "acme", dir, "sleep 600", "", nil, nil); err != nil {
			b.Fatal(err)
		}
		t.sess[name] = &sessTrack{Name: name, Agent: "acme-cli", Dir: dir, State: "running", Turns: []*Turn{{ID: name + "#1", Session: name, N: 1, State: "running", Fidelity: "screen"}}}
	}
	bx := &Box{Name: "devbox", Sessions: s, Events: &events.Bus{}, Turns: t}
	bx.pollScreens(ctx)
	execs.Store(0)
	b.ReportAllocs()
	defer cpuPerOp(b)()
	n := 0
	for b.Loop() {
		bx.pollScreens(ctx)
		n++
	}
	b.ReportMetric(float64(execs.Load())/float64(n), "execs/op")
}

// BenchmarkTurnsSave is the ledger written after a change, on a box with
// 20 agent sessions of 50 turns each.
func BenchmarkTurnsSave(b *testing.B) {
	dir := b.TempDir()
	t := &Turns{Path: filepath.Join(dir, "turns.json"), LegacyPath: filepath.Join(dir, "agent-states.json")}
	t.init()
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for i := range 20 {
		name := fmt.Sprintf("acme-%d", i)
		s := &sessTrack{Name: name, Agent: "claude", Dir: "/home/acme/w" + fmt.Sprint(i), State: "running", Since: at, N: 50}
		for n := 1; n <= 50; n++ {
			s.Turns = append(s.Turns, &Turn{ID: fmt.Sprintf("%s#%d", name, n), Session: name, N: n, State: "finished", Sent: at, Started: at, Ended: at, Fidelity: "hooks", Origin: "laptop:acme"})
		}
		t.sess[name] = s
	}
	b.ReportAllocs()
	defer cpuPerOp(b)()
	for b.Loop() {
		// A tool started: the ledger moved on, no agent changed state.
		t.mu.Lock()
		t.applied++
		t.dirty = true
		t.mu.Unlock()
		t.save()
	}
}

// writeTurnRecord writes a Claude Code record whose latest turn edited
// three files of about 20 KB each, as Claude Code keeps them.
func writeTurnRecord(tb testing.TB, p string) {
	tb.Helper()
	orig := strings.Repeat("export const acme = 1 // a line of the file as it was\n", 380)
	var rec strings.Builder
	rec.WriteString(`{"type":"user","timestamp":"2026-01-02T03:04:05Z","message":{"role":"user","content":"Fix the acme widgets"}}` + "\n")
	for i := range 3 {
		f := fmt.Sprintf("/home/acme/w/src/f%d.ts", i)
		fmt.Fprintf(&rec, `{"type":"assistant","timestamp":"2026-01-02T03:04:06Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_%d","name":"Edit","input":{"file_path":%q,"old_string":"1","new_string":"2"}}]}}`+"\n", i, f)
		fmt.Fprintf(&rec, `{"type":"user","timestamp":"2026-01-02T03:04:07Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_%d","content":"ok"}]},"toolUseResult":{"filePath":%q,"originalFile":%q}}`+"\n", i, f, orig)
	}
	if err := os.WriteFile(p, []byte(rec.String()), 0o600); err != nil {
		tb.Fatal(err)
	}
}

// BenchmarkTurnCacheRetained is the memory the touched-files cache keeps
// once the box has shown 500 conversations' latest turns (MB-kept/op).
func BenchmarkTurnCacheRetained(b *testing.B) {
	dir := b.TempDir()
	paths := make([]string, 500)
	for i := range paths {
		paths[i] = filepath.Join(dir, fmt.Sprintf("%08d-acme.jsonl", i))
		writeTurnRecord(b, paths[i])
	}
	var kept float64
	for b.Loop() {
		resetTurnCache()
		runtime.GC()
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		for _, p := range paths {
			if _, ok := cachedTurn("claude", p, "/home/acme/w"); !ok {
				b.Fatal("no turn")
			}
		}
		runtime.GC()
		runtime.ReadMemStats(&after)
		kept += float64(int64(after.HeapAlloc)-int64(before.HeapAlloc)) / (1 << 20)
	}
	resetTurnCache()
	b.ReportMetric(kept/float64(b.N), "MB-kept/op")
}

// resetTurnCache forgets every cached turn.
func resetTurnCache() {
	turnCache.Lock()
	clear(turnCache.m)
	turnCache.Unlock()
}

// The cache of latest turns keeps the conversations read most recently,
// never all of them.
func TestTurnCacheIsBounded(t *testing.T) {
	defer resetTurnCache()
	dir := t.TempDir()
	var last string
	for i := range maxTurnCache + 20 {
		last = filepath.Join(dir, fmt.Sprintf("%08d-acme.jsonl", i))
		writeTurnRecord(t, last)
		turn, ok := cachedTurn("claude", last, "/home/acme/w")
		if !ok || len(turn.Files) != 3 || turn.Files[0].Original == nil {
			t.Fatalf("turn = %+v", turn)
		}
	}
	turnCache.Lock()
	n := len(turnCache.m)
	_, kept := turnCache.m[last]
	turnCache.Unlock()
	if n != maxTurnCache || !kept {
		t.Fatalf("cache holds %d (latest kept: %v), want %d", n, kept, maxTurnCache)
	}
}
