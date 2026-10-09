package transcript

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Benchmarks on a synthetic Claude Code record shaped like a real one: each
// step an assistant line (thinking, text, a tool call) and the user line
// with its result, whose toolUseResult carries what Claude Code keeps
// beside it (a Read's whole file, an Edit's original file and patch).
// Every name and path is made up ("acme").

// synthClaude writes a record of about n lines to a temp file and returns
// its path and the ID of a tool call near its end.
func synthClaude(tb testing.TB, n int) (string, string) {
	tb.Helper()
	dir := tb.TempDir()
	p := filepath.Join(dir, "0b8f3a52-acme-4c1e-9d55-2f7e0c1a9b01.jsonl")
	f, err := os.Create(p)
	if err != nil {
		tb.Fatal(err)
	}
	defer f.Close()
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	file := strings.Repeat("export function acme(x: number): number {\n  return x * 2 // keep it simple\n}\n", 60) // ~5KB
	out := strings.Repeat("ok   github.com/acme/widgets/pkg/thing\t0.123s\n", 40)
	parent := ""
	uuid := 0
	line := func(v map[string]any) {
		uuid++
		id := fmt.Sprintf("00000000-0000-4000-8000-%012d", uuid)
		v["uuid"], v["parentUuid"], v["isSidechain"] = id, parent, false
		v["timestamp"] = at.Format(time.RFC3339Nano)
		v["cwd"], v["sessionId"], v["version"], v["gitBranch"], v["userType"] = "/home/acme/widgets", "0b8f3a52-acme", "2.1.0", "main", "external"
		at = at.Add(1500 * time.Millisecond)
		parent = id
		b, _ := json.Marshal(v)
		f.Write(append(b, '\n'))
	}
	usage := map[string]any{"input_tokens": 12, "cache_creation_input_tokens": 3400, "cache_read_input_tokens": 88000, "output_tokens": 420}
	assistant := func(blocks ...map[string]any) {
		line(map[string]any{"type": "assistant", "requestId": "req_acme", "message": map[string]any{
			"id": "msg_acme", "type": "message", "role": "assistant", "model": "claude-acme-1", "content": blocks, "usage": usage}})
	}
	result := func(tool string, content string, extra any) {
		line(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []map[string]any{
			{"type": "tool_result", "tool_use_id": tool, "content": content}}}, "toolUseResult": extra})
	}
	lastTool := ""
	for i := 0; uuid < n; i++ {
		if i%25 == 0 {
			line(map[string]any{"type": "user", "permissionMode": "default", "message": map[string]any{"role": "user", "content": fmt.Sprintf("Please fix widget %d in the acme repo and run the tests", i)}})
		}
		assistant(map[string]any{"type": "thinking", "thinking": "", "signature": strings.Repeat("Q2xhdWRl", 120)})
		assistant(map[string]any{"type": "text", "text": fmt.Sprintf("Looking at widget %d now; I'll read the file first.", i)})
		tool := fmt.Sprintf("toolu_%06d", i)
		lastTool = tool
		path := fmt.Sprintf("/home/acme/widgets/src/widget%d.ts", i%40)
		switch i % 4 {
		case 0:
			assistant(map[string]any{"type": "tool_use", "id": tool, "name": "Read", "input": map[string]any{"file_path": path}})
			result(tool, file, map[string]any{"type": "text", "file": map[string]any{"filePath": path, "content": file, "numLines": 180, "startLine": 1, "totalLines": 180}})
		case 1:
			assistant(map[string]any{"type": "tool_use", "id": tool, "name": "Edit", "input": map[string]any{"file_path": path, "old_string": "x * 2", "new_string": "x * 3"}})
			result(tool, "The file "+path+" has been updated.", map[string]any{"filePath": path, "oldString": "x * 2", "newString": "x * 3", "originalFile": file,
				"structuredPatch": []map[string]any{{"oldStart": 2, "oldLines": 1, "newStart": 2, "newLines": 1, "lines": []string{"-  return x * 2", "+  return x * 3"}}}})
		case 2:
			assistant(map[string]any{"type": "tool_use", "id": tool, "name": "Bash", "input": map[string]any{"command": "go test ./...", "description": "Run tests"}})
			result(tool, out, map[string]any{"stdout": out, "stderr": "", "interrupted": false, "isImage": false})
		case 3:
			assistant(map[string]any{"type": "tool_use", "id": tool, "name": "Grep", "input": map[string]any{"pattern": "acme", "path": "/home/acme/widgets"}})
			result(tool, "Found 3 files\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts", map[string]any{"mode": "files_with_matches", "filenames": []string{"src/a.ts", "src/b.ts", "src/c.ts"}, "numFiles": 3})
		}
	}
	return p, lastTool
}

// cpuPerOp reports the process's CPU time per op (cpu-ns/op) when the
// benchmark ends: on a busy machine it moves far less than wall time.
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

func fileSize(tb testing.TB, p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		tb.Fatal(err)
	}
	return st.Size()
}

// BenchmarkFollowCold is a chat opening a long conversation: the last
// maxStart bytes read and parsed from scratch.
func BenchmarkFollowCold(b *testing.B) {
	p, _ := synthClaude(b, 20000)
	b.SetBytes(min(fileSize(b, p), maxStart))
	b.ReportAllocs()
	defer cpuPerOp(b)()
	for b.Loop() {
		if _, err := NewReader().Read("claude", p, "/home/acme/widgets", 0); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkFollowWarm is the 2-second poll of an open chat with nothing
// new: the answer is built from what is kept.
func BenchmarkFollowWarm(b *testing.B) {
	p, _ := synthClaude(b, 5000)
	r := NewReader()
	res, err := r.Read("claude", p, "/home/acme/widgets", 0)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	defer cpuPerOp(b)()
	for b.Loop() {
		if _, err := r.Follow("claude", p, "/home/acme/widgets", res.Next, res.Gen); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkBefore is a page of 80 older items from the end of a long file.
func BenchmarkBefore(b *testing.B) {
	p, _ := synthClaude(b, 20000)
	b.ReportAllocs()
	defer cpuPerOp(b)()
	for b.Loop() {
		if _, err := Before("claude", p, "/home/acme/widgets", 0, 80); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkLastTurn finds the latest prompt and reads its edits.
func BenchmarkLastTurn(b *testing.B) {
	p, _ := synthClaude(b, 20000)
	b.ReportAllocs()
	defer cpuPerOp(b)()
	for b.Loop() {
		if _, err := LastTurn("claude", p, "/home/acme/widgets"); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkDetail opens one tool call near the end of a long file.
func BenchmarkDetail(b *testing.B) {
	p, id := synthClaude(b, 20000)
	b.SetBytes(fileSize(b, p))
	b.ReportAllocs()
	defer cpuPerOp(b)()
	for b.Loop() {
		if _, err := Detail("claude", p, "/home/acme/widgets", id); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkAssignClaude assigns a folder's transcripts to its sessions,
// as every chat poll does, in a project folder holding 200 records.
func BenchmarkAssignClaude(b *testing.B) {
	cfg := b.TempDir()
	b.Setenv("CLAUDE_CONFIG_DIR", cfg)
	dir := "/home/acme/widgets"
	proj := ClaudeDir(dir)
	if err := os.MkdirAll(proj, 0o755); err != nil {
		b.Fatal(err)
	}
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for i := range 200 {
		ts := start.Add(time.Duration(i) * time.Minute).Format(time.RFC3339Nano)
		os.WriteFile(filepath.Join(proj, fmt.Sprintf("%08d-acme-4c1e-9d55-2f7e0c1a9b01.jsonl", i)), []byte(`{"type":"user","timestamp":"`+ts+`"}`+"\n"), 0o600)
	}
	claims := []Claim{{Name: "a", Started: start.Add(150 * time.Minute)}, {Name: "b", Started: start.Add(170 * time.Minute)}}
	b.ReportAllocs()
	defer cpuPerOp(b)()
	for b.Loop() {
		AssignClaude(dir, claims)
	}
}
