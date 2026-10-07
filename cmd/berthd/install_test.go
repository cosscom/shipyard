package main

import (
	"bytes"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestChooseListen(t *testing.T) {
	tailnet := ips("10.0.0.5", "100.101.102.103")
	for _, tc := range []struct {
		name, flag, current string
		keep                bool
		ips                 []net.IP
		want                string
		wantErr             bool
	}{
		{name: "the tailnet address by default", ips: tailnet, want: "100.101.102.103:7444"},
		{name: "--listen wins", flag: "0.0.0.0:7444", ips: tailnet, current: "10.0.0.5:7444", keep: true, want: "0.0.0.0:7444"},
		{name: "an upgrade keeps an address chosen before", keep: true, current: "0.0.0.0:7444", ips: tailnet, want: "0.0.0.0:7444"},
		{name: "an upgrade keeps it without a tailnet too", keep: true, current: "0.0.0.0:7444", want: "0.0.0.0:7444"},
		{name: "an old tailnet address is not kept", keep: true, current: "100.64.0.9:7444", ips: tailnet, want: "100.101.102.103:7444"},
		{name: "without --keep-listen the tailnet address comes back", current: "0.0.0.0:7444", ips: tailnet, want: "100.101.102.103:7444"},
		{name: "no tailnet and nothing chosen is an error", ips: ips("203.0.113.5"), wantErr: true},
	} {
		got, err := chooseListen(tc.flag, tc.keep, tc.current, tc.ips)
		if (err != nil) != tc.wantErr || got != tc.want {
			t.Errorf("%s: got %q, %v; want %q (error %v)", tc.name, got, err, tc.want, tc.wantErr)
		}
	}
}

func TestUnitListen(t *testing.T) {
	systemd := "[Service]\nExecStart=/home/me/.local/bin/berthd serve --listen 0.0.0.0:7444\nEnvironment=BERTH_HOME=/home/me/.berth\n"
	plist := "<array>\n<string>/Users/me/.local/bin/berthd</string>\n<string>serve</string>\n<string>--listen</string>\n<string>100.64.0.2:7444</string>\n</array>"
	for unit, want := range map[string]string{
		systemd: "0.0.0.0:7444",
		plist:   "100.64.0.2:7444",
		"[Service]\nExecStart=/usr/local/bin/berthd serve\n": "",
	} {
		if got := unitListen([]byte(unit)); got != want {
			t.Errorf("unitListen(%q) = %q, want %q", unit, got, want)
		}
	}
}

func TestPrintPlan(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	b := boxHome{dir: t.TempDir()}
	var out bytes.Buffer
	if err := printPlan(&out, b, "100.64.0.2:7444", "0.0.0.0:7444", nil); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"version dev\n", "unit " + os.Getenv("HOME"), "current 0.0.0.0:7444\n", "listen 100.64.0.2:7444\n"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("plan missing %q:\n%s", want, out.String())
		}
	}
	out.Reset()
	if err := printPlan(&out, b, "", "", errors.New("this box has no tailnet address")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "listen none (this box has no tailnet address)\n") || strings.Contains(out.String(), "current") {
		t.Errorf("plan without an address:\n%s", out.String())
	}
}

func TestWaitServingNeedsTheNewDaemon(t *testing.T) {
	// Unix socket paths are short on macOS; t.TempDir can be too long.
	dir, err := os.MkdirTemp("/tmp", "bw")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	b := boxHome{dir: dir}

	ln, err := net.Listen("unix", b.socket())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	// A daemon from before the install answers, but has not written its
	// address since: still waiting.
	old := time.Now().Add(-time.Hour)
	listen := filepath.Join(dir, "listen")
	os.WriteFile(listen, []byte("100.64.0.2:7444"), 0o600)
	os.Chtimes(listen, old, old)
	if err := waitServing(b, time.Now(), 300*time.Millisecond); err == nil {
		t.Fatal("an old daemon counted as the new one")
	}
	since := time.Now()
	os.WriteFile(listen, []byte("100.64.0.2:7444"), 0o600)
	if err := waitServing(b, since, 2*time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestLogTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "berthd.log")
	os.WriteFile(path, []byte("one\ntwo\nthree\nlisten tcp 100.64.0.2:7444: bind: address already in use\n"), 0o600)
	got := logTail(path, 2)
	if !strings.Contains(got, "three\n  listen tcp") || strings.Contains(got, "two") {
		t.Errorf("logTail = %q", got)
	}
	if logTail(filepath.Join(t.TempDir(), "missing"), 2) != "" {
		t.Error("a missing log has no tail")
	}
}

// berthd install sets up hooks for the agent CLIs it finds. (Which ones it
// finds, and the advice for the others, are integrations' tests.)
func TestInstallSetsUpIntegrationsForAgentsOnThisBox(t *testing.T) {
	home, path := t.TempDir(), t.TempDir()
	for _, tool := range []string{"claude", "codex", "cursor-agent", "grok"} {
		os.WriteFile(filepath.Join(path, tool), []byte("#!/bin/sh\n"), 0o755)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", path)
	var out bytes.Buffer
	installIntegrations(&out, "/home/alex/.local/bin/berthd")
	settings, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil || !strings.Contains(string(settings), "/home/alex/.local/bin/berthd hook claude Stop") {
		t.Fatalf("settings.json = %s, %v", settings, err)
	}
	for _, want := range []string{"Claude Code: hooks and 7 skills in ~/.claude", "hooks added in", "Codex: hooks in ~/.codex; 7 skills in", "notify added in", "Cursor: hooks added", "Grok CLI: hooks added"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output missing %q:\n%s", want, out.String())
		}
	}
	out.Reset()
	installIntegrations(&out, "/home/alex/.local/bin/berthd")
	if !strings.Contains(out.String(), "hooks already present") || strings.Contains(out.String(), "added") {
		t.Errorf("second install:\n%s", out.String())
	}
}

func TestCommandNameIsBerthdWhenPathFindsIt(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "berthd")
	os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", dir)
	if got := commandName(bin); got != "berthd" {
		t.Errorf("commandName = %q", got)
	}
	t.Setenv("PATH", t.TempDir())
	if got := commandName(bin); got != bin {
		t.Errorf("commandName off PATH = %q", got)
	}
}
