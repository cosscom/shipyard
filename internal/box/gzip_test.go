package box

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// big is a JSON answer well past gzipMin.
func big() any {
	out := make([]map[string]string, 60)
	for i := range out {
		out[i] = map[string]string{"name": fmt.Sprintf("worktree-%d", i), "path": fmt.Sprintf("/home/me/code/shop/worktree-%d", i)}
	}
	return out
}

func serveGzip(t *testing.T, h http.HandlerFunc, method string, header http.Header) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, "/v1/x", nil)
	for k, v := range header {
		req.Header[k] = v
	}
	rec := httptest.NewRecorder()
	gzipJSON(h).ServeHTTP(rec, req)
	return rec.Result()
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	var r io.Reader = resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		r = gz
	}
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

var askGzip = http.Header{"Accept-Encoding": {"gzip"}}

func TestLargeJSONIsGzippedForAClientThatAsks(t *testing.T) {
	want, _ := json.Marshal(big())
	resp := serveGzip(t, func(w http.ResponseWriter, r *http.Request) { writeJSON(w, big()) }, "GET", askGzip)
	if resp.Header.Get("Content-Encoding") != "gzip" || !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("headers = %v", resp.Header)
	}
	if got := strings.TrimSpace(readBody(t, resp)); got != string(want) {
		t.Fatalf("body changed:\n%s\n%s", got, want)
	}
}

func TestAnswersPassThroughPlainWhenGzipWouldNotHelpOrIsNotAsked(t *testing.T) {
	cases := map[string]struct {
		h      http.HandlerFunc
		method string
		header http.Header
	}{
		"no Accept-Encoding": {func(w http.ResponseWriter, r *http.Request) { writeJSON(w, big()) }, "GET", nil},
		"gzip refused":       {func(w http.ResponseWriter, r *http.Request) { writeJSON(w, big()) }, "GET", http.Header{"Accept-Encoding": {"gzip;q=0, identity"}}},
		"small":              {func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]string{"screen": "$ "}) }, "GET", askGzip},
		"not GET":            {func(w http.ResponseWriter, r *http.Request) { writeJSON(w, big()) }, "POST", askGzip},
		"an error": {func(w http.ResponseWriter, r *http.Request) {
			writeErr(w, httpError{http.StatusNotFound, strings.Repeat("gone ", 400)})
		}, "GET", askGzip},
		"plain text": {func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			io.WriteString(w, strings.Repeat("log line\n", 400))
		}, "GET", askGzip},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			resp := serveGzip(t, c.h, c.method, c.header)
			if resp.Header.Get("Content-Encoding") != "" {
				t.Fatalf("Content-Encoding = %q", resp.Header.Get("Content-Encoding"))
			}
			if readBody(t, resp) == "" {
				t.Fatal("empty body")
			}
		})
	}
}

func TestAStreamFlushedEarlyGoesOutPlainAndAtOnce(t *testing.T) {
	srv := httptest.NewServer(gzipJSON(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"first":true}`+"\n")
		http.NewResponseController(w).Flush()
		time.Sleep(300 * time.Millisecond)
		io.WriteString(w, strings.Repeat(" ", 4096)+`{"second":true}`+"\n")
	})))
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL, nil)
	req.Header.Set("Accept-Encoding", "gzip")
	start := time.Now()
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Encoding") != "" {
		t.Fatal("a flushed answer was gzipped")
	}
	buf := make([]byte, 64)
	n, _ := resp.Body.Read(buf)
	if !strings.Contains(string(buf[:n]), "first") || time.Since(start) > 250*time.Millisecond {
		t.Fatalf("the first part waited: %q after %v", buf[:n], time.Since(start))
	}
}

// Over the real link: the laptop's client asks for gzip and unpacks it on
// its own, so callers read the same JSON as before.
func TestBoxAnswersReachTheLaptopGzippedAndReadTheSame(t *testing.T) {
	c, _ := servedBox(t)
	root := t.TempDir()
	for i := range 15 {
		dir := filepath.Join(root, fmt.Sprintf("project-with-a-long-name-%02d", i))
		os.MkdirAll(dir, 0o755)
		if code := call(t, c, "POST", "/v1/locations", "", map[string]string{"name": fmt.Sprintf("project-%02d", i), "path": dir}, nil); code != 200 {
			t.Fatalf("add location: %d", code)
		}
	}
	resp, err := c.Do(t.Context(), "GET", "/v1/locations", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !resp.Uncompressed {
		t.Fatal("the answer wasn't gzipped on the link")
	}
	var locs []Location
	if err := json.NewDecoder(resp.Body).Decode(&locs); err != nil || len(locs) != 15 {
		t.Fatalf("decoded %d locations: %v", len(locs), err)
	}
}

// ---- What it saves, on sampleAnswers shaped as a busy box's ----------------------

func fleetLocations(worktrees int) []Location {
	var out []Location
	for p := 0; len(out)*10 < worktrees; p++ {
		name := fmt.Sprintf("project-%02d", p)
		loc := Location{Name: name, Path: "/home/me/code/" + name, Repo: true, Scripts: Scripts{Setup: "pnpm install", From: "repo"}, Remote: "git@github.com:acme/" + name + ".git", Slug: "acme/" + name, DefaultBranch: "main", RepoTrust: "trusted", Check: "pnpm test", CheckFrom: "config"}
		loc.Worktrees = append(loc.Worktrees, Worktree{Name: name, Path: loc.Path, Branch: "main", Head: "4f1c2a9be0d3", Main: true})
		for w := 1; w < 10; w++ {
			wn := fmt.Sprintf("%s-fix-%d", name, w)
			loc.Worktrees = append(loc.Worktrees, Worktree{Name: wn, Path: "/home/me/.berth/worktrees/" + name + "/" + wn, Branch: "me/" + wn, Head: fmt.Sprintf("%012x", p*100+w), Port: 3000 + p*10 + w, Title: "Make checkout retries safe to repeat"})
		}
		out = append(out, loc)
	}
	return out
}

func fleetSessions(n int) []Session {
	out := make([]Session, n)
	t0 := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	for i := range out {
		name := fmt.Sprintf("project-%02d-fix-%d", i/9, i%9+1)
		out[i] = Session{Name: name + "-claude", Location: fmt.Sprintf("project-%02d/%s", i/9, name), Dir: "/home/me/.berth/worktrees/" + name, Command: "claude", Created: t0, Agent: "claude", AgentState: "finished", StateSince: t0.Add(time.Duration(i) * time.Minute), Preset: "claude", Turn: fmt.Sprintf("%s-claude#%d", name, i), StateSeq: int64(i), Fidelity: "hooks", Title: "Make checkout retries safe to repeat"}
	}
	return out
}

func chatWindow(items int) transcript.Result {
	words := strings.Fields("The ledger retries now carry an idempotency key so a slow answer from the payment provider can't make a second order and the test sends the same webhook twice and checks there is one order and one charge")
	res := transcript.Result{Source: "claude", Next: items, Crew: []transcript.CrewMember{}, Gen: "1.0", File: "6b1f0c2e-1d2c-4a8e-9a51-0c3e2f1d9b7a"}
	for i := range items {
		it := transcript.Item{ID: fmt.Sprintf("i%d", i), Off: int64(i) * 2048}
		switch i % 4 {
		case 0:
			it.Kind, it.Text, it.UUID = "user", fmt.Sprintf("Please look at step %d of the checkout flow.", i), fmt.Sprintf("u-%d", i)
		case 1:
			it.Kind, it.Verb, it.Done = "tools", "Read", true
			it.Items = []transcript.ToolCall{{Verb: "Read", Target: fmt.Sprintf("src/checkout/step%d.ts", i)}, {Verb: "Read", Target: fmt.Sprintf("src/payments/retry%d.ts", i)}}
		default:
			var b strings.Builder
			for j := range 60 {
				b.WriteString(words[(i+j)%len(words)])
				b.WriteByte(' ')
			}
			it.Kind, it.Text = "text", b.String()
		}
		res.Items = append(res.Items, it)
	}
	return res
}

var sampleAnswers = map[string]func() any{
	"locations_300_worktrees": func() any { return fleetLocations(300) },
	"sessions_100":            func() any { return fleetSessions(100) },
	"transcript_window_100":   func() any { return chatWindow(100) },
}

// TestGzipSavings logs what each answer is, plain and gzipped (go test -run
// GzipSavings -v ./internal/box).
func TestGzipSavings(t *testing.T) {
	for name, v := range sampleAnswers {
		h := func(w http.ResponseWriter, r *http.Request) { writeJSON(w, v()) }
		plain := serveGzip(t, h, "GET", nil)
		packed := serveGzip(t, h, "GET", askGzip)
		p, _ := io.ReadAll(plain.Body)
		g, _ := io.ReadAll(packed.Body)
		if len(g) >= len(p)/3 {
			t.Errorf("%s: gzip %d of %d bytes", name, len(g), len(p))
		}
		t.Logf("%s: %d bytes plain, %d gzipped (%.1fx)", name, len(p), len(g), float64(len(p))/float64(len(g)))
	}
}

func BenchmarkJSONAnswer(b *testing.B) {
	for _, name := range []string{"locations_300_worktrees", "sessions_100", "transcript_window_100"} {
		v := sampleAnswers[name]()
		h := gzipJSON(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, v) }))
		for _, mode := range []string{"plain", "gzip"} {
			b.Run(name+"/"+mode, func(b *testing.B) {
				req := httptest.NewRequest("GET", "/v1/x", nil)
				if mode == "gzip" {
					req.Header.Set("Accept-Encoding", "gzip")
				}
				b.ReportAllocs()
				var n int
				for b.Loop() {
					rec := httptest.NewRecorder()
					h.ServeHTTP(rec, req)
					n = rec.Body.Len()
				}
				b.ReportMetric(float64(n), "B/answer")
			})
		}
	}
}
