// Package agentcli installs the agent CLIs Shipyard runs (Claude Code, Codex,
// Cursor Agent, OpenCode, Grok CLI) on a box, as the box's user, without
// sudo, into ~/.local/bin. Each install checks first and does nothing when
// the agent is already there, so running it again is safe. Signing in stays
// the person's own: nothing here touches an agent's login.
package agentcli

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/agentpath"
)

// Agent is an agent CLI Shipyard knows how to install.
type Agent struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
	// Install is what Shipyard runs, as a person would type it.
	Install string `json:"install,omitempty"`
	// Verified says how the download is checked.
	Verified string `json:"verified,omitempty"`
	// Default agents are ticked when nothing was chosen before.
	Default bool `json:"default,omitempty"`
	// Offered is false for an agent Shipyard leaves to the person; Why says
	// why, and Install then is the command to type.
	Offered bool   `json:"offered"`
	Why     string `json:"why,omitempty"`
}

// CodexVersion is the Codex release Shipyard installs: pinned, with each
// archive's sha256 below, so a box gets exactly the build that was checked.
const CodexVersion = "0.160.1"

// codexArchives are the sha256 of each codex-<target>.tar.gz in
// github.com/openai/codex's rust-v<CodexVersion> release, as GitHub lists
// them (an asset's "digest").
var codexArchives = map[string]string{
	"x86_64-unknown-linux-musl":  "9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f",
	"aarch64-unknown-linux-musl": "f54dc5852042445bf41da3aa31156f3cb02f52c5a1a04074de73dc5598f7e1f7",
	"aarch64-apple-darwin":       "670af2b049d9c95afb74d7da385f30c5033d13a07175001dd8958c51944984d0",
	"x86_64-apple-darwin":        "8d938ddb93c4424b1d45f1606984ed514c5aa70e463302a6a2227fba7af02db7",
}

const (
	claudeInstaller   = "https://claude.ai/install.sh"
	cursorInstaller   = "https://cursor.com/install"
	opencodeInstaller = "https://opencode.ai/install"
	grokInstaller     = "https://x.ai/cli/install.sh"
)

// Catalog is every agent CLI the add-a-box screen lists, in its order.
var Catalog = []Agent{
	{ID: "claude", Name: "Claude Code", Command: "claude", Default: true, Offered: true,
		Install:  "curl -fsSL " + claudeInstaller + " | bash",
		Verified: "Anthropic's native installer checks the build it downloads against its checksum"},
	{ID: "codex", Name: "Codex", Command: "codex", Offered: true,
		Install:  "codex " + CodexVersion + " from github.com/openai/codex/releases → ~/.local/bin/codex",
		Verified: "pinned to " + CodexVersion + " and checked against its sha256"},
	{ID: "cursor", Name: "Cursor Agent", Command: "cursor-agent", Offered: true,
		Install:  "curl -fsS " + cursorInstaller + " | bash",
		Verified: "Cursor's installer, over HTTPS; Cursor publishes no checksums for it"},
	{ID: "opencode", Name: "OpenCode", Command: "opencode", Offered: true,
		Install:  "curl -fsSL " + opencodeInstaller + " | bash -s -- --no-modify-path",
		Verified: "OpenCode's installer, over HTTPS; it publishes no checksums for it"},
	{ID: "grok", Name: "Grok CLI", Command: "grok", Offered: true,
		Install:  "curl -fsSL " + grokInstaller + " | bash",
		Verified: "xAI's installer, over HTTPS; xAI publishes no checksums for it"},
	{ID: "gemini", Name: "Gemini CLI", Command: "gemini",
		Install: "npm install -g @google/gemini-cli",
		Why:     "it installs with npm and needs Node.js 20 or newer, which Shipyard doesn't install; install Node, then run the command"},
}

// ByID finds an agent in the catalog.
func ByID(id string) (Agent, bool) {
	for _, a := range Catalog {
		if a.ID == id {
			return a, true
		}
	}
	return Agent{}, false
}

// Defaults are the agents ticked when nothing was chosen.
func Defaults() []string {
	var out []string
	for _, a := range Catalog {
		if a.Default {
			out = append(out, a.ID)
		}
	}
	return out
}

// ParseList reads a comma- or space-separated list of agent ids ("none"
// is the empty list), refusing ids Shipyard doesn't install. Repeats go.
func ParseList(s string) ([]string, error) {
	s = strings.TrimSpace(s)
	if s == "" || s == "none" {
		return []string{}, nil
	}
	seen := map[string]bool{}
	out := []string{}
	for _, id := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		a, ok := ByID(id)
		if !ok {
			return nil, fmt.Errorf("%q is not an agent Shipyard installs (%s)", id, strings.Join(offeredIDs(), ", "))
		}
		if !a.Offered {
			return nil, fmt.Errorf("Shipyard doesn't install %s: %s (%s)", a.Name, a.Why, a.Install)
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

func offeredIDs() []string {
	var out []string
	for _, a := range Catalog {
		if a.Offered {
			out = append(out, a.ID)
		}
	}
	return out
}

// Names says the agents in words: "Claude Code and Codex".
func Names(ids []string) string {
	var names []string
	for _, id := range ids {
		if a, ok := ByID(id); ok {
			names = append(names, a.Name)
		} else {
			names = append(names, id)
		}
	}
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// Installer installs agents for one user. The zero value's fields are
// filled from this machine by New; tests set their own.
type Installer struct {
	Home   string
	GOOS   string
	GOARCH string
	// Out gets what each install prints.
	Out io.Writer
	// Fetch downloads a URL.
	Fetch func(ctx context.Context, url string) (io.ReadCloser, error)
	// Run runs a program with its output on out.
	Run func(ctx context.Context, out io.Writer, env []string, name string, args ...string) error
	// LookPath finds a program on PATH.
	LookPath func(string) (string, error)
	// Locate, when set, finds an agent as the person's terminal would
	// (internal/agentpath): an npm install under nvm counts as installed.
	Locate func(command string) (string, bool)
	// Codex is the sha256 of each archive, by target; nil is the pinned
	// release's.
	Codex map[string]string
}

// New is an installer for this user on this machine.
func New(home, goos, goarch string, out io.Writer) *Installer {
	in := &Installer{Home: home, GOOS: goos, GOARCH: goarch, Out: out, Fetch: httpFetch, Run: runProgram, LookPath: exec.LookPath}
	if d := agentpath.Default(); filepath.Clean(d.Home) == filepath.Clean(home) {
		f := &agentpath.Finder{Home: home, Shell: d.Shell, NoVersion: true}
		in.Locate = func(command string) (string, bool) {
			r, ok := f.Find(command)
			return r.Path, ok
		}
	}
	return in
}

// Result is what one install did.
type Result struct {
	ID      string
	Path    string
	Already bool
}

// BinDir is where agents go: ~/.local/bin.
func (in *Installer) BinDir() string { return filepath.Join(in.Home, ".local", "bin") }

// Find reports where an agent's command is: as the person's shell finds it
// (Locate), else ~/.local/bin, then the places its own installer uses, then
// PATH.
func (in *Installer) Find(a Agent) (string, bool) {
	if in.Locate != nil {
		if p, ok := in.Locate(a.Command); ok {
			return p, true
		}
	}
	return in.findInstalled(a)
}

// findInstalled is where Shipyard's own install of a would be.
func (in *Installer) findInstalled(a Agent) (string, bool) {
	dirs := []string{in.BinDir()}
	if a.ID == "opencode" {
		dirs = append(dirs, filepath.Join(in.Home, ".opencode", "bin"))
	}
	if a.ID == "grok" {
		dirs = append(dirs, filepath.Join(in.Home, ".grok", "bin"))
	}
	if a.ID == "claude" {
		dirs = append(dirs, filepath.Join(in.Home, ".claude", "local"))
	}
	for _, d := range dirs {
		p := filepath.Join(d, a.Command)
		if executable(p) {
			return p, true
		}
	}
	if in.LookPath != nil {
		if p, err := in.LookPath(a.Command); err == nil {
			return p, true
		}
	}
	return "", false
}

// Install installs one agent, unless it is already there.
func (in *Installer) Install(ctx context.Context, id string) (Result, error) {
	a, ok := ByID(id)
	if !ok {
		return Result{}, fmt.Errorf("%q is not an agent Shipyard installs", id)
	}
	if !a.Offered {
		return Result{}, fmt.Errorf("Shipyard doesn't install %s: %s (%s)", a.Name, a.Why, a.Install)
	}
	if p, ok := in.Find(a); ok {
		fmt.Fprintf(in.Out, "%s is already installed (%s)\n", a.Name, p)
		return Result{ID: id, Path: p, Already: true}, nil
	}
	if err := os.MkdirAll(in.BinDir(), 0o755); err != nil {
		return Result{}, err
	}
	var err error
	switch id {
	case "claude":
		err = in.script(ctx, a, claudeInstaller)
	case "codex":
		err = in.codex(ctx)
	case "cursor":
		err = in.script(ctx, a, cursorInstaller)
	case "opencode":
		err = in.script(ctx, a, opencodeInstaller, "--no-modify-path")
		if err == nil {
			err = in.linkOpencode()
		}
	case "grok":
		err = in.script(ctx, a, grokInstaller)
		if err == nil {
			err = in.linkGrok()
		}
	}
	if err != nil {
		return Result{}, fmt.Errorf("%s did not install: %w", a.Name, err)
	}
	p, ok := in.findInstalled(a)
	if !ok {
		return Result{}, fmt.Errorf("%s's installer finished, but there is no %s in %s", a.Name, a.Command, in.BinDir())
	}
	fmt.Fprintf(in.Out, "%s installed: %s\n", a.Name, p)
	return Result{ID: id, Path: p}, nil
}

// script runs an agent's own install script with bash, fetched over HTTPS
// to a file first, so a download cut short never runs half a script.
func (in *Installer) script(ctx context.Context, a Agent, url string, args ...string) error {
	bash, err := in.LookPath("bash")
	if err != nil {
		return fmt.Errorf("its installer needs bash, which this box doesn't have")
	}
	fmt.Fprintf(in.Out, "Running %s's installer (%s)\n", a.Name, url)
	body, err := in.Fetch(ctx, url)
	if err != nil {
		return err
	}
	defer body.Close()
	dir, err := os.MkdirTemp("", "berth-agent-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "install.sh")
	f, err := os.OpenFile(file, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(body, 4<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("downloading %s: %w", url, err)
	}
	env := []string{"HOME=" + in.Home, "PATH=" + in.BinDir() + string(os.PathListSeparator) + os.Getenv("PATH")}
	return in.Run(ctx, in.Out, env, bash, append([]string{file}, args...)...)
}

// codexTarget is the release target for a platform.
func codexTarget(goos, goarch string) string {
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[goarch]
	switch {
	case arch == "":
		return ""
	case goos == "linux":
		return arch + "-unknown-linux-musl"
	case goos == "darwin":
		return arch + "-apple-darwin"
	}
	return ""
}

// CodexURL is the archive Shipyard downloads for a platform.
func CodexURL(goos, goarch string) string {
	t := codexTarget(goos, goarch)
	if t == "" {
		return ""
	}
	return "https://github.com/openai/codex/releases/download/rust-v" + CodexVersion + "/codex-" + t + ".tar.gz"
}

// codex downloads the pinned release's archive, checks it, and puts its
// one binary in ~/.local/bin/codex, renamed into place.
func (in *Installer) codex(ctx context.Context) error {
	target := codexTarget(in.GOOS, in.GOARCH)
	sums := in.Codex
	if sums == nil {
		sums = codexArchives
	}
	want := sums[target]
	if target == "" || want == "" {
		return fmt.Errorf("Codex has no build for %s/%s", in.GOOS, in.GOARCH)
	}
	url := CodexURL(in.GOOS, in.GOARCH)
	fmt.Fprintf(in.Out, "Downloading Codex %s (%s)\n", CodexVersion, url)
	body, err := in.Fetch(ctx, url)
	if err != nil {
		return err
	}
	defer body.Close()
	tmp, err := os.CreateTemp("", "codex-*.tar.gz")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(body, 1<<30)); err != nil {
		return fmt.Errorf("downloading %s: %w", url, err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("the download does not match Codex %s's sha256 (got %s, want %s); nothing was installed", CodexVersion, got, want)
	}
	fmt.Fprintf(in.Out, "Checked against its sha256 (%s…)\n", want[:12])
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	gz, err := gzip.NewReader(tmp)
	if err != nil {
		return fmt.Errorf("the Codex archive is not gzip: %w", err)
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("the Codex archive has no codex-%s in it", target)
		}
		if err != nil {
			return fmt.Errorf("reading the Codex archive: %w", err)
		}
		name := filepath.Base(hdr.Name)
		if hdr.Typeflag != tar.TypeReg || (name != "codex-"+target && name != "codex") {
			continue
		}
		dest := filepath.Join(in.BinDir(), "codex")
		part := dest + ".berth-new"
		f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		_, err = io.Copy(f, io.LimitReader(tr, 2<<30))
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(part)
			return err
		}
		return os.Rename(part, dest)
	}
}

// linkOpencode puts opencode, which its installer keeps in ~/.opencode/bin,
// in ~/.local/bin beside the others, so one PATH entry finds every agent.
func (in *Installer) linkOpencode() error {
	return in.linkHomeBin("opencode", filepath.Join(".opencode", "bin", "opencode"))
}

// linkGrok puts grok, which xAI's installer keeps in ~/.grok/bin, in
// ~/.local/bin beside the others. The installer may already have linked it
// there when ~/.local/bin was on PATH; this covers the rest.
func (in *Installer) linkGrok() error {
	return in.linkHomeBin("grok", filepath.Join(".grok", "bin", "grok"))
}

func (in *Installer) linkHomeBin(command, rel string) error {
	src := filepath.Join(in.Home, rel)
	if !executable(src) {
		return nil
	}
	dest := filepath.Join(in.BinDir(), command)
	if _, err := os.Lstat(dest); err == nil {
		return nil
	}
	return os.Symlink(src, dest)
}

func executable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
}

var httpClient = &http.Client{Timeout: 30 * time.Minute}

func httpFetch(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "berthd")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("downloading %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("downloading %s: %s", url, resp.Status)
	}
	return resp.Body, nil
}

func runProgram(ctx context.Context, out io.Writer, env []string, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout, cmd.Stderr = out, out
	cmd.Stdin = nil
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", filepath.Base(name), err)
	}
	return nil
}
