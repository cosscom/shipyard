package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/box"
)

// The wrapper replaces its process, so the test runs it in a copy of the
// test binary.
func TestSecretExecHelper(t *testing.T) {
	if os.Getenv("BERTH_TEST_SECRET_EXEC") != "1" {
		t.Skip("run by TestSecretExecResolvesReferencesThenRunsTheProgram")
	}
	err := secretExec(boxHome{dir: t.TempDir()}, []string{"--socket", os.Getenv("BERTH_TEST_SOCKET"), "--", "/bin/sh", "-c", `echo "DB=${DB_PASSWORD-unset} MISSING=${MISSING-unset} PLAIN=$PLAIN VARS=${BERTH_SECRET_VARS-unset}"`})
	t.Fatalf("secret exec returned: %v", err)
}

func TestSecretExecResolvesReferencesThenRunsTheProgram(t *testing.T) {
	// A stub op; never the real one.
	dir := t.TempDir()
	op := filepath.Join(dir, "op")
	os.WriteFile(op, []byte(`#!/bin/sh
case "$2" in
op://dev/db/password) printf 'wrapped-secret-value\n' ;;
*) echo "[ERROR] 2024/01/01 00:00:00 \"$2\" isn't an item in the \"dev\" vault" >&2; exit 1 ;;
esac
`), 0o755)

	// A box that records what the wrapper reports.
	sockDir, err := os.MkdirTemp("/tmp", "bsx")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(sockDir)
	sock := filepath.Join(sockDir, "berthd.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var paths []string
	var got []box.SecretReport
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var rep box.SecretReport
		json.NewDecoder(r.Body).Decode(&rep)
		mu.Lock()
		paths, got = append(paths, r.Method+" "+r.URL.Path), append(got, rep)
		mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	})}
	go srv.Serve(ln)
	defer srv.Close()

	cmd := exec.Command(os.Args[0], "-test.run=^TestSecretExecHelper$")
	cmd.Env = append(os.Environ(),
		"BERTH_TEST_SECRET_EXEC=1", "BERTH_TEST_SOCKET="+sock, "BERTH_OP="+op, "PATH="+dir+":/usr/bin:/bin",
		"DB_PASSWORD=op://dev/db/password", "MISSING=op://dev/nope/field", "PLAIN=plain", "BERTH_SECRET_VARS=DB_PASSWORD,MISSING",
		"BERTH_LOCATION=cal", "BERTH_WORKTREE_NAME=billing", "BERTH_WORKTREE_PATH=/w/cal-billing")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if strings.TrimSpace(string(out)) != "DB=wrapped-secret-value MISSING=unset PLAIN=plain VARS=unset" {
		t.Fatalf("program saw %q", out)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || paths[0] != "POST /v1/secrets/report" {
		t.Fatalf("reported %v %+v", paths, got)
	}
	rep := got[0]
	if rep.Location != "cal" || rep.Name != "billing" || rep.Path != "/w/cal-billing" || len(rep.Results) != 2 {
		t.Fatalf("report = %+v", rep)
	}
	for _, r := range rep.Results {
		switch r.Variable {
		case "DB_PASSWORD":
			if r != (box.SecretResult{Variable: "DB_PASSWORD", Ref: "op://dev/db/password"}) {
				t.Fatalf("resolved result = %+v", r)
			}
		case "MISSING":
			if r.Ref != "op://dev/nope/field" || !strings.Contains(r.Reason, "isn't an item") {
				t.Fatalf("failed result = %+v", r)
			}
		default:
			t.Fatalf("result = %+v", r)
		}
	}
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "wrapped-secret-value") {
		t.Fatalf("the report carries a value: %s", raw)
	}
}

// berthd secret signin runs op signin in the terminal and keeps the
// session for berthd's reads; --check only says whether it can read now.
func TestSecretSigninKeepsOpsSession(t *testing.T) {
	dir := t.TempDir()
	op := filepath.Join(dir, "op")
	os.WriteFile(op, []byte(`#!/bin/sh
case "$1" in
whoami) [ "$OP_SESSION_abc" = tok-123 ] && { echo dev@acme.test; exit 0; }
  echo '[ERROR] 2024/01/01 00:00:00 account is not signed in' >&2; exit 1 ;;
signin)
  printf 'Enter the password for dev@acme.test at my.1password.com: ' >&2
  read -r pw
  [ "$pw" = op-pass ] || { echo '[ERROR] incorrect password' >&2; exit 1; }
  echo 'export OP_SESSION_abc="tok-123"'
  echo "# This command is meant to be used with your shell's eval function." ;;
esac
`), 0o755)
	t.Setenv("BERTH_OP", op)
	t.Setenv("BERTH_USER_DIR", t.TempDir())
	b := boxHome{dir: t.TempDir()}
	var code exitCode
	if err := secretSignin(b, []string{"--check"}); !errors.As(err, &code) || code != 1 {
		t.Fatalf("check before: %v", err)
	}
	withStdin(t, "op-pass\n", func() {
		if err := secretSignin(b, nil); err != nil {
			t.Fatal(err)
		}
	})
	got, _ := os.ReadFile(b.opSessionFile())
	if !strings.Contains(string(got), "\nOP_SESSION_abc=tok-123\n") {
		t.Fatalf("session file: %q", got)
	}
	if err := secretSignin(b, []string{"--check"}); err != nil {
		t.Fatalf("check after: %v", err)
	}
	// Without op, it says how to get it.
	t.Setenv("BERTH_OP", filepath.Join(dir, "nope"))
	if err := secretSignin(b, nil); !errors.As(err, &code) || code != 127 {
		t.Fatalf("no op: %v", err)
	}
}

func withStdin(t *testing.T, input string, f func()) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	w.WriteString(input)
	w.Close()
	old := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = old; r.Close() }()
	f()
}

// TestSecretExecArgsHelper runs secret exec with the arguments the parent
// test gives, against its box folder.
func TestSecretExecArgsHelper(t *testing.T) {
	if os.Getenv("BERTH_TEST_SECRET_ARGS") == "" {
		t.Skip("run by the --env/--file tests")
	}
	var args []string
	json.Unmarshal([]byte(os.Getenv("BERTH_TEST_SECRET_ARGS")), &args)
	err := secretExec(boxHome{dir: os.Getenv("BERTH_TEST_BOX_DIR")}, args)
	var code exitCode
	if errors.As(err, &code) {
		os.Exit(int(code))
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "berthd:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

// savedSecretBox is a box folder with ACME_TOKEN saved in its encrypted
// file, as a secret card would have saved it.
func savedSecretBox(t *testing.T, value string) string {
	t.Helper()
	dir := t.TempDir()
	stores := &box.SecretStores{Dir: dir, Box: "devbox", Bins: map[string]string{"security": "/nonexistent", "secret-tool": "/nonexistent"}}
	st, err := stores.Open("local", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Save(context.Background(), box.SecretSave{Name: "ACME_TOKEN", Value: value}); err != nil {
		t.Fatal(err)
	}
	return dir
}

func secretExecCmd(dir string, args ...string) *exec.Cmd {
	raw, _ := json.Marshal(args)
	cmd := exec.Command(os.Args[0], "-test.run=^TestSecretExecArgsHelper$")
	cmd.Env = append(os.Environ(), "BERTH_TEST_SECRET_ARGS="+string(raw), "BERTH_TEST_BOX_DIR="+dir, "BERTH_SECRET_VARS=")
	return cmd
}

func TestSecretExecHandsASavedSecretToOneCommand(t *testing.T) {
	const value = "acme-sentinel-exec-31"
	dir := savedSecretBox(t, value)
	sum := sha256.Sum256([]byte(value))
	want := hex.EncodeToString(sum[:])
	out, err := secretExecCmd(dir, "--env", "T=box://ACME_TOKEN", "--file", "F=box://ACME_TOKEN", "--", "/bin/sh", "-c",
		`printf %s "$T" | sha256sum | cut -d' ' -f1; sha256sum < "$F" | cut -d' ' -f1; echo "$F"; stat -c %a "$F" 2>/dev/null || stat -f %Lp "$F"`).Output()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 4 || lines[0] != want || lines[1] != want || lines[3] != "600" {
		t.Fatalf("the command saw %q", out)
	}
	if _, err := os.Stat(lines[2]); !os.IsNotExist(err) {
		t.Fatalf("the file %s is still there", lines[2])
	}
	// One that can't be resolved stops the command.
	out, err = secretExecCmd(dir, "--env", "T=box://NOT_SAVED", "--", "/bin/echo", "ran").CombinedOutput()
	if err == nil || strings.Contains(string(out), "ran") || !strings.Contains(string(out), "NOT_SAVED is not saved") {
		t.Fatalf("an unresolved reference: %v %s", err, out)
	}
	for _, bad := range []string{"T=box://lower", "T=plain", "1T=box://ACME_TOKEN", "T=gcp://acme/x"} {
		var r refFlags
		if r.Set(bad) == nil {
			t.Errorf("--env %s was taken", bad)
		}
	}
	var r refFlags
	if err := r.Set("K=gcp://projects/acme-staging/secrets/ACME_TOKEN"); err != nil || r["K"] != "gcp://projects/acme-staging/secrets/ACME_TOKEN" {
		t.Fatalf("a gcp reference: %v %v", err, r)
	}
}

func TestSecretExecFileGoesWhenTheCommandIsStopped(t *testing.T) {
	dir := savedSecretBox(t, "acme-sentinel-term")
	mark := filepath.Join(t.TempDir(), "path")
	cmd := secretExecCmd(dir, "--file", "F=box://ACME_TOKEN", "--", "/bin/sh", "-c", `echo "$F" > `+mark+`; exec sleep 30`)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var path string
	for deadline := time.Now().Add(10 * time.Second); path == ""; time.Sleep(50 * time.Millisecond) {
		if b, _ := os.ReadFile(mark); len(b) > 0 {
			path = strings.TrimSpace(string(b))
		}
		if time.Now().After(deadline) {
			cmd.Process.Kill()
			t.Fatal("the command never started")
		}
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the file isn't there while it runs: %v", err)
	}
	cmd.Process.Signal(syscall.SIGTERM)
	err := cmd.Wait()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 128+int(syscall.SIGTERM) {
		t.Fatalf("stopped: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the file %s outlived a SIGTERM", path)
	}
}
