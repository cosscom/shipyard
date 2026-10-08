package agentcli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fake is an installer whose downloads and programs are stand-ins: fetched
// records each URL, and running "bash" acts as the agent's installer would.
type fake struct {
	*Installer
	fetched []string
	ran     []string
	files   map[string][]byte
}

func newFake(t *testing.T) *fake {
	t.Helper()
	home := t.TempDir()
	f := &fake{files: map[string][]byte{}}
	var out bytes.Buffer
	f.Installer = &Installer{
		Home: home, GOOS: "linux", GOARCH: "arm64", Out: &out,
		Fetch: func(_ context.Context, url string) (io.ReadCloser, error) {
			f.fetched = append(f.fetched, url)
			b, ok := f.files[url]
			if !ok {
				return nil, errors.New("404 " + url)
			}
			return io.NopCloser(bytes.NewReader(b)), nil
		},
		Run: func(_ context.Context, _ io.Writer, env []string, name string, args ...string) error {
			script, _ := os.ReadFile(args[0])
			f.ran = append(f.ran, filepath.Base(name)+" "+strings.TrimSpace(string(script))+" "+strings.Join(args[1:], " "))
			// Each installer leaves its command where it puts it.
			switch {
			case strings.Contains(string(script), "claude"):
				exe(t, filepath.Join(home, ".local", "bin", "claude"))
			case strings.Contains(string(script), "cursor"):
				exe(t, filepath.Join(home, ".local", "bin", "cursor-agent"))
			case strings.Contains(string(script), "opencode"):
				exe(t, filepath.Join(home, ".opencode", "bin", "opencode"))
			case strings.Contains(string(script), "grok"):
				exe(t, filepath.Join(home, ".grok", "bin", "grok"))
			}
			return nil
		},
		LookPath: func(name string) (string, error) {
			if name == "bash" {
				return "/bin/bash", nil
			}
			return "", errors.New("not found")
		},
	}
	f.files[claudeInstaller] = []byte("echo claude installer")
	f.files[cursorInstaller] = []byte("echo cursor installer")
	f.files[opencodeInstaller] = []byte("echo opencode installer")
	f.files[grokInstaller] = []byte("echo grok installer")
	return f
}

func exe(t *testing.T, path string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeRunsItsOwnInstallerOnce(t *testing.T) {
	f := newFake(t)
	res, err := f.Install(context.Background(), "claude")
	if err != nil {
		t.Fatal(err)
	}
	if res.Already || res.Path != filepath.Join(f.Home, ".local", "bin", "claude") {
		t.Errorf("result = %+v", res)
	}
	if !reflect.DeepEqual(f.fetched, []string{"https://claude.ai/install.sh"}) || len(f.ran) != 1 || !strings.HasPrefix(f.ran[0], "bash echo claude installer") {
		t.Errorf("fetched %v, ran %v", f.fetched, f.ran)
	}
	// Again: it is there, so nothing is fetched or run.
	res, err = f.Install(context.Background(), "claude")
	if err != nil || !res.Already || len(f.fetched) != 1 || len(f.ran) != 1 {
		t.Errorf("second install: %+v %v; fetched %v ran %v", res, err, f.fetched, f.ran)
	}
}

func TestOpencodeIsLinkedIntoLocalBin(t *testing.T) {
	f := newFake(t)
	if _, err := f.Install(context.Background(), "opencode"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(f.ran[0], "--no-modify-path") {
		t.Errorf("ran %v", f.ran)
	}
	link, err := os.Readlink(filepath.Join(f.Home, ".local", "bin", "opencode"))
	if err != nil || link != filepath.Join(f.Home, ".opencode", "bin", "opencode") {
		t.Errorf("link = %q %v", link, err)
	}
}

func TestGrokIsLinkedIntoLocalBin(t *testing.T) {
	f := newFake(t)
	res, err := f.Install(context.Background(), "grok")
	if err != nil {
		t.Fatal(err)
	}
	if res.Already || res.Path != filepath.Join(f.Home, ".local", "bin", "grok") {
		t.Errorf("result = %+v", res)
	}
	if !reflect.DeepEqual(f.fetched, []string{"https://x.ai/cli/install.sh"}) || len(f.ran) != 1 || !strings.HasPrefix(f.ran[0], "bash echo grok installer") {
		t.Errorf("fetched %v, ran %v", f.fetched, f.ran)
	}
	link, err := os.Readlink(filepath.Join(f.Home, ".local", "bin", "grok"))
	if err != nil || link != filepath.Join(f.Home, ".grok", "bin", "grok") {
		t.Errorf("link = %q %v", link, err)
	}
	res, err = f.Install(context.Background(), "grok")
	if err != nil || !res.Already || len(f.fetched) != 1 || len(f.ran) != 1 {
		t.Errorf("second install: %+v %v; fetched %v ran %v", res, err, f.fetched, f.ran)
	}
}

func codexArchive(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
	tw.Write(body)
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestCodexIsCheckedAgainstItsSHA256(t *testing.T) {
	f := newFake(t)
	archive := codexArchive(t, "codex-aarch64-unknown-linux-musl", []byte("#!/bin/sh\necho codex\n"))
	sum := sha256.Sum256(archive)
	f.files[CodexURL("linux", "arm64")] = archive
	f.Codex = map[string]string{"aarch64-unknown-linux-musl": hex.EncodeToString(sum[:])}
	res, err := f.Install(context.Background(), "codex")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(res.Path)
	if res.Path != filepath.Join(f.Home, ".local", "bin", "codex") || string(got) != "#!/bin/sh\necho codex\n" {
		t.Errorf("installed %s: %q", res.Path, got)
	}
	if !strings.Contains(f.fetched[0], "/rust-v"+CodexVersion+"/codex-aarch64-unknown-linux-musl.tar.gz") {
		t.Errorf("fetched %v", f.fetched)
	}
}

func TestCodexWithTheWrongSHA256InstallsNothing(t *testing.T) {
	f := newFake(t)
	f.files[CodexURL("linux", "arm64")] = codexArchive(t, "codex-aarch64-unknown-linux-musl", []byte("tampered"))
	f.Codex = map[string]string{"aarch64-unknown-linux-musl": strings.Repeat("0", 64)}
	_, err := f.Install(context.Background(), "codex")
	if err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.Home, ".local", "bin", "codex")); err == nil {
		t.Error("a codex that failed its check was installed")
	}
}

func TestPinnedCodexCoversEveryBoxPlatform(t *testing.T) {
	for _, p := range [][2]string{{"linux", "amd64"}, {"linux", "arm64"}, {"darwin", "arm64"}, {"darwin", "amd64"}} {
		if len(codexArchives[codexTarget(p[0], p[1])]) != 64 {
			t.Errorf("no sha256 for codex on %s/%s", p[0], p[1])
		}
	}
}

func TestParseList(t *testing.T) {
	got, err := ParseList("claude, codex claude")
	if err != nil || !reflect.DeepEqual(got, []string{"claude", "codex"}) {
		t.Errorf("got %v %v", got, err)
	}
	if got, err := ParseList("none"); err != nil || len(got) != 0 {
		t.Errorf("none = %v %v", got, err)
	}
	if _, err := ParseList("gemini"); err == nil || !strings.Contains(err.Error(), "Node.js") {
		t.Errorf("gemini: %v", err)
	}
	if _, err := ParseList("vim"); err == nil {
		t.Error("vim parsed as an agent")
	}
	if !reflect.DeepEqual(Defaults(), []string{"claude"}) {
		t.Errorf("defaults = %v", Defaults())
	}
	if Names([]string{"claude", "codex", "cursor"}) != "Claude Code, Codex and Cursor Agent" {
		t.Errorf("names = %q", Names([]string{"claude", "codex", "cursor"}))
	}
	if got, err := ParseList("grok"); err != nil || !reflect.DeepEqual(got, []string{"grok"}) {
		t.Errorf("grok: %v %v", got, err)
	}
}

func TestEnsureLoginPATH(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, ".local", "bin")
	if file, err := EnsureLoginPATH(home, "/bin/bash", "/usr/bin:"+bin); err != nil || file != "" {
		t.Errorf("already on PATH: %q %v", file, err)
	}
	file, err := EnsureLoginPATH(home, "/bin/bash", "/usr/bin:/bin")
	if err != nil || file != filepath.Join(home, ".profile") {
		t.Fatalf("file = %q %v", file, err)
	}
	// Once only.
	if again, _ := EnsureLoginPATH(home, "/bin/bash", "/usr/bin:/bin"); again != "" {
		t.Errorf("added twice, to %s", again)
	}
	b, _ := os.ReadFile(file)
	if strings.Count(string(b), `export PATH="$HOME/.local/bin:$PATH"`) != 1 {
		t.Errorf("profile = %q", b)
	}
	if file, _ := EnsureLoginPATH(home, "/usr/bin/zsh", "/usr/bin"); file != filepath.Join(home, ".zprofile") {
		t.Errorf("zsh file = %q", file)
	}
}
