package boxcmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cosscom/shipyard/internal/box"
)

// recorder is a fake box that records each request and replies with body.
type recorder struct {
	method, path, origin string
	body                 map[string]any
	reply                string
}

func (r *recorder) DoWithHeader(_ context.Context, method, path string, body io.Reader, h http.Header) (*http.Response, error) {
	r.method, r.path, r.origin = method, path, h.Get(box.OriginHeader)
	r.body = nil
	if body != nil {
		json.NewDecoder(body).Decode(&r.body)
	}
	rec := httptest.NewRecorder()
	rec.WriteString(r.reply)
	return rec.Result(), nil
}

func run(t *testing.T, reply string, args ...string) (*recorder, string) {
	t.Helper()
	r := &recorder{reply: reply}
	var out bytes.Buffer
	if err := Run(context.Background(), &box.Client{Doer: r}, args, &out); err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	return r, out.String()
}

func TestFlagsMayFollowTheReference(t *testing.T) {
	r, _ := run(t, `{"name":"billing","path":"/w/cal-billing","branch":"alex/billing"}`,
		"worktree", "new", "cal/billing", "--base", "main", "--branch", "alex/billing")
	if r.method != "POST" || r.path != "/v1/locations/cal/worktrees" {
		t.Fatalf("request %s %s", r.method, r.path)
	}
	for k, want := range map[string]string{"name": "billing", "base": "main", "branch": "alex/billing"} {
		if r.body[k] != want {
			t.Errorf("body[%s] = %v, want %s", k, r.body[k], want)
		}
	}
}

func TestWorktreeNewChecksOutAPullRequest(t *testing.T) {
	r, _ := run(t, `{"name":"pr-7","path":"/w/cal-pr-7","branch":"alex/fix"}`,
		"worktree", "new", "cal/pr-7", "--pr", "7", "--branch", "alex/fix", "--ref", "pull/7/merge")
	if r.body["pr"] != float64(7) || r.body["branch"] != "alex/fix" || r.body["ref"] != "pull/7/merge" {
		t.Fatalf("body = %v", r.body)
	}
}

func TestSessionNewPassesTheCommandAfterDoubleDash(t *testing.T) {
	r, _ := run(t, `{"name":"s","dir":"/w"}`, "session", "new", "cal/billing", "--name", "fix", "--", "claude", "--resume", "--model", "x")
	if r.body["location"] != "cal/billing" || r.body["name"] != "fix" || r.body["command"] != "claude --resume --model x" {
		t.Fatalf("session body = %v", r.body)
	}
}

func TestLocationAddAndRemoveWorktree(t *testing.T) {
	r, out := run(t, `{"name":"cal","path":"/home/alex/work/cal","repo":true,"worktrees":[{"name":"cal","main":true}]}`, "location", "add", "cal", "~/work/cal")
	if r.body["name"] != "cal" || r.body["path"] != "~/work/cal" || !strings.Contains(out, "git repository") {
		t.Fatalf("location add: %v %q", r.body, out)
	}
	r, _ = run(t, `{}`, "worktree", "rm", "cal/billing", "--force")
	if r.method != "DELETE" || r.path != "/v1/locations/cal/worktrees/billing?force=1" {
		t.Fatalf("worktree rm: %s %s", r.method, r.path)
	}
}

func TestEmitCarriesDataAndOrigin(t *testing.T) {
	r, _ := run(t, `{"ok":true}`, "emit", "agent.finished", "path=/w/cal", "--origin", "cursor", "status=done")
	if r.body["type"] != "agent.finished" || r.origin != "cursor" {
		t.Fatalf("emit: %v origin %q", r.body, r.origin)
	}
	data, _ := r.body["data"].(map[string]any)
	if data["path"] != "/w/cal" || data["status"] != "done" {
		t.Fatalf("emit data = %v", data)
	}
}

func TestShareUsesThePort(t *testing.T) {
	r, out := run(t, `{"id":"ab12","port":3000,"url":"https://x.trycloudflare.com"}`, "share", "3000")
	if r.body["port"] != float64(3000) || !strings.Contains(out, "https://x.trycloudflare.com") || !strings.Contains(out, "unshare ab12") {
		t.Fatalf("share: %v %q", r.body, out)
	}
}

func TestUsageErrors(t *testing.T) {
	for _, args := range [][]string{
		{"worktree", "new", "no-slash"},
		{"worktree", "new", "cal/x", "--ref", "pull/7/head"},
		{"location", "add", "only-name"},
		{"share", "not-a-port"},
		{"emit"},
		{"nope"},
	} {
		if err := Run(context.Background(), &box.Client{Doer: &recorder{reply: "{}"}}, args, io.Discard); err == nil {
			t.Errorf("%v accepted", args)
		}
	}
}

func TestUnitsListsWhatTheBoxReports(t *testing.T) {
	reply := `[{"name":"berth-orca","state":"installed","log_path":"/home/sean/.config/berth/units/berth-orca.log"}]`
	rec, out := run(t, reply, "units")
	if rec.path != "/v1/units" {
		t.Fatalf("called %q; want /v1/units", rec.path)
	}
	if !strings.Contains(out, "berth-orca") || !strings.Contains(out, "installed") {
		t.Fatalf("units output = %q; want the unit and its state", out)
	}
}

func TestUnitAddSendsTheCommandAfterDoubleDash(t *testing.T) {
	reply := `{"name":"berth-orca","state":"installed","log_path":"/tmp/berth-orca.log"}`
	rec, _ := run(t, reply, "unit", "add", "berth-orca", "--", "orca", "serve")
	if rec.body["program"] != "orca" {
		t.Fatalf("program = %v; want orca", rec.body["program"])
	}
	args, ok := rec.body["args"].([]any)
	if !ok || len(args) != 1 || args[0] != "serve" {
		t.Fatalf("args = %v; want [serve]", rec.body["args"])
	}
}

func TestPreviewAnnouncesTheWorktreesPage(t *testing.T) {
	locs := `[{"name":"cal","path":"/w/cal","repo":true,"worktrees":[{"name":"cal","path":"/w/cal","main":true,"port":41000},{"name":"billing","path":"/w/cal-billing","port":41010}]}]`
	r, out := run(t, locs, "preview", "cal/billing", "--path", "settings")
	if r.path != "/v1/events" || r.body["type"] != "preview.open" {
		t.Fatalf("request %s %v", r.path, r.body)
	}
	data, _ := r.body["data"].(map[string]any)
	if data["path"] != "/w/cal-billing" || data["port"] != float64(41010) || data["url_path"] != "/settings" || data["location"] != "cal" {
		t.Fatalf("data = %v", data)
	}
	if !strings.Contains(out, "41010/settings") {
		t.Fatalf("out = %q", out)
	}
	// A port given explicitly wins; a bare location means its main checkout.
	r, _ = run(t, locs, "preview", "cal", "5173")
	data, _ = r.body["data"].(map[string]any)
	if data["port"] != float64(5173) || data["path"] != "/w/cal" {
		t.Fatalf("data = %v", data)
	}
}

func TestWordsAfterDoubleDashKeepTheirQuoting(t *testing.T) {
	for words, want := range map[string]string{
		"claude\x00Create loop.sh, don't commit": `claude 'Create loop.sh, don'\''t commit'`,
		"pnpm test && echo ok":                   "pnpm test && echo ok",
		"ls\x00-la":                              "ls -la",
	} {
		if got := commandLine(strings.Split(words, "\x00")); got != want {
			t.Errorf("%q → %s, want %s", words, got, want)
		}
	}
}

func TestSecretTestPrintsTheLengthNeverAValue(t *testing.T) {
	r, out := run(t, `{"ok":true,"length":24}`, "secret", "test", "op://dev/db/password")
	if r.method != "POST" || r.path != "/v1/secrets/test" || r.body["ref"] != "op://dev/db/password" {
		t.Fatalf("request %s %s %v", r.method, r.path, r.body)
	}
	if out != "Resolved op://dev/db/password: 24 characters\n" {
		t.Fatalf("out = %q", out)
	}
	rec := &recorder{reply: `{"ok":false,"error":"op: \"op://dev/x/y\" isn't an item in the \"dev\" vault"}`}
	err := Run(context.Background(), &box.Client{Doer: rec}, []string{"secret", "test", "op://dev/x/y"}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "isn't an item") {
		t.Fatalf("a failed test gave %v", err)
	}
}

type failingDoer struct{ err error }

func (f failingDoer) DoWithHeader(context.Context, string, string, io.Reader, http.Header) (*http.Response, error) {
	return nil, f.err
}

func TestSessionSendQueueHandsAFailedSendToTheQueue(t *testing.T) {
	cause := errors.New("dial tcp 100.64.0.1:7444: connect: no route to host")
	c := &box.Client{Doer: failingDoer{cause}}
	var out bytes.Buffer
	if err := Run(context.Background(), c, []string{"session", "send", "billing", "hi", "--queue"}, &out); err == nil || !strings.Contains(err.Error(), "laptop") {
		t.Fatalf("--queue without a queue (on a box): %v", err)
	}

	var got struct {
		session, text string
		enter         bool
		cause         error
	}
	Queue = func(ctx context.Context, session, text string, enter bool, err error) (string, error) {
		got.session, got.text, got.enter, got.cause = session, text, enter, err
		return "q1", nil
	}
	defer func() { Queue = nil }()
	if err := Run(context.Background(), c, []string{"session", "send", "billing", "hi there", "--queue", "--no-enter"}, &out); err != nil {
		t.Fatal(err)
	}
	if got.session != "billing" || got.text != "hi there" || got.enter || !errors.Is(got.cause, cause) {
		t.Fatalf("queued %+v", got)
	}
	if !strings.Contains(out.String(), "Queued as q1") {
		t.Fatalf("output %q", out.String())
	}

	// Without --queue a failed send is just an error.
	got.session = ""
	if err := Run(context.Background(), c, []string{"session", "send", "billing", "hi"}, &out); !errors.Is(err, cause) || got.session != "" {
		t.Fatalf("plain send: %v (queued %q)", err, got.session)
	}
}

func TestBrowserReapAsksTheBox(t *testing.T) {
	reply := `{"sessions":[{"berth_session":"old-task","session":"qa","daemon":10,"pids":[10,11]}],"text":"Closed 1 agent-browser session left by ended berth sessions:\n  \"qa\" of old-task (daemon 10, 2 processes)"}`
	r, out := run(t, reply, "browser", "reap")
	if r.method != "POST" || r.path != "/v1/browser/reap" || r.body["dry_run"] != false {
		t.Fatalf("request %s %s %v", r.method, r.path, r.body)
	}
	if !strings.HasPrefix(out, "Closed 1 agent-browser session") {
		t.Fatalf("out = %q", out)
	}
	r, out = run(t, reply, "browser", "reap", "--dry-run", "--json")
	if r.body["dry_run"] != true || !strings.Contains(out, `"berth_session": "old-task"`) {
		t.Fatalf("dry run: %v, out = %q", r.body, out)
	}
}

func TestWorktreeRenameSetsAndClearsTheDisplayName(t *testing.T) {
	r, out := run(t, `{"name":"https-linear-app-acme","path":"/w/cal-https-linear-app-acme","branch":"https-linear-app-acme","title":"Fix checkout"}`,
		"worktree", "rename", "cal/https-linear-app-acme", "Fix checkout")
	if r.method != "PATCH" || r.path != "/v1/locations/cal/worktrees/https-linear-app-acme" || r.body["title"] != "Fix checkout" {
		t.Fatalf("rename: %s %s %v", r.method, r.path, r.body)
	}
	if !strings.Contains(out, `"Fix checkout"`) || !strings.Contains(out, "branch https-linear-app-acme is unchanged") {
		t.Fatalf("rename said %q", out)
	}
	r, out = run(t, `{"name":"https-linear-app-acme","path":"/w/x"}`, "worktree", "rename", "cal/https-linear-app-acme")
	if v, ok := r.body["title"]; !ok || v != "" {
		t.Fatalf("clear body = %v", r.body)
	}
	if !strings.Contains(out, "by its name again") {
		t.Fatalf("clear said %q", out)
	}
}

// oldBox answers like a berthd from before worktree titles: the path has
// DELETE, so PATCH is 405.
type oldBox struct{}

func (oldBox) DoWithHeader(context.Context, string, string, io.Reader, http.Header) (*http.Response, error) {
	rec := httptest.NewRecorder()
	http.Error(rec, "Method Not Allowed", http.StatusMethodNotAllowed)
	return rec.Result(), nil
}

func TestWorktreeRenameOnAnOlderBoxSaysToUpdate(t *testing.T) {
	var out bytes.Buffer
	err := Run(context.Background(), &box.Client{Doer: oldBox{}}, []string{"worktree", "rename", "cal/x", "Name"}, &out)
	if err == nil || !strings.Contains(err.Error(), "older berthd") {
		t.Fatalf("err = %v", err)
	}
}

func TestBrowserSizesFromTheCommandLine(t *testing.T) {
	reply := `{"text":"size: 390×844 @2x"}`
	r, out := run(t, reply, "browser", "resize", "cal/billing", "390x844", "--scale", "2")
	if r.method != "POST" || r.path != "/v1/worktrees/cal/billing/browser/resize" || r.body["size"] != "390x844" || r.body["scale"] != "2" || out != "size: 390×844 @2x\n" {
		t.Fatalf("resize: %s %s %v %q", r.method, r.path, r.body, out)
	}
	r, _ = run(t, reply, "browser", "resize", "cal/billing", "--scale", "3")
	if r.body["size"] != "" || r.body["scale"] != "3" {
		t.Fatalf("scale only: %v", r.body)
	}
	r, _ = run(t, reply, "browser", "resize", "cal/billing", "phone")
	if r.body["size"] != "phone" {
		t.Fatalf("preset: %v", r.body)
	}
	r, _ = run(t, `{"text":"url: x"}`, "browser", "open", "cal/billing", "/cart", "--size", "1280x800", "--scale", "2")
	if r.path != "/v1/worktrees/cal/billing/browser/open" || r.body["url"] != "/cart" || r.body["size"] != "1280x800" || r.body["scale"] != "2" {
		t.Fatalf("open: %s %v", r.path, r.body)
	}
	r, _ = run(t, `{"text":"shot"}`, "browser", "shot", "cal/billing", "--native")
	if r.body["native"] != true {
		t.Fatalf("shot: %v", r.body)
	}
	// A size out of range never reaches the box, and says why.
	for _, args := range [][]string{
		{"browser", "resize", "cal/billing", "100x100"},
		{"browser", "resize", "cal/billing", "1280x800", "--scale", "5"},
		{"browser", "resize", "cal/billing", "huge"},
		{"browser", "resize", "cal/billing"},
		{"browser", "open", "cal/billing", "--size", "99999x1"},
	} {
		rec := &recorder{reply: reply}
		err := Run(context.Background(), &box.Client{Doer: rec}, args, io.Discard)
		if err == nil || rec.path != "" {
			t.Errorf("%v: %v (sent %q)", args, err, rec.path)
		}
	}
	err := Run(context.Background(), &box.Client{Doer: &recorder{}}, []string{"browser", "resize", "cal/billing", "5000x800"}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "width 5000 is out of range: 320 to 3840") {
		t.Fatalf("error: %v", err)
	}
}

func TestLogInAsFromTheCommandLine(t *testing.T) {
	r, _ := run(t, `{"text":"url: x"}`, "browser", "open", "shop/fix-x", "--as", "pro@acme.test", "--path", "/settings")
	if r.path != "/v1/worktrees/shop/fix-x/browser/open" || r.body["as"] != "pro@acme.test" || r.body["url"] != "/settings" {
		t.Fatalf("open --as: %s %v", r.path, r.body)
	}
	r, _ = run(t, `{"text":"visual diff"}`, "shots", "compare", "shop/fix-x", "--as", "pro@acme.test", "--pages", "/", "/billing")
	if r.path != "/v1/worktrees/shop/fix-x/shots/compare" || r.body["as"] != "pro@acme.test" || len(r.body["pages"].([]any)) != 2 {
		t.Fatalf("shots --as: %s %v", r.path, r.body)
	}
	// An email that isn't one never reaches the box.
	for _, args := range [][]string{
		{"browser", "open", "shop/fix-x", "--as", "a@b.c; rm -rf /"},
		{"browser", "open", "shop/fix-x", "--as", "$(id)@acme.test"},
		{"browser", "open", "shop/fix-x", "--path", "settings"},
		{"browser", "open", "shop/fix-x", "/x", "--path", "/y"},
		{"shots", "compare", "shop/fix-x", "--as", "pro"},
	} {
		rec := &recorder{}
		if err := Run(context.Background(), &box.Client{Doer: rec}, args, io.Discard); err == nil || rec.path != "" {
			t.Errorf("%v: %v (sent %q)", args, err, rec.path)
		}
	}
}
