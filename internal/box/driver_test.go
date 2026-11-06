package box

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
	"github.com/cosscom/shipyard/internal/transcript"
)

// recordingDriver stands in for a session's driver and notes each call.
type recordingDriver struct {
	mu    sync.Mutex
	calls []string
}

func (d *recordingDriver) note(s string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, s)
}

func (d *recordingDriver) seen() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.calls)
}

func (d *recordingDriver) Kind() string { return DriverTerminal }

func (d *recordingDriver) Send(_ context.Context, sess Session, text string, enter bool) error {
	d.note("send " + sess.Name + " " + text)
	return nil
}

func (d *recordingDriver) Interrupt(_ context.Context, sess Session) (bool, error) {
	d.note("interrupt " + sess.Name)
	return true, nil
}

func (d *recordingDriver) Controls(_ context.Context, sess Session) (Controls, error) {
	d.note("controls " + sess.Name)
	return Controls{Agent: "claude", Mode: "plan"}, nil
}

func (d *recordingDriver) SetMode(_ context.Context, sess Session, mode string) (string, error) {
	d.note("mode " + sess.Name + " " + mode)
	return mode, nil
}

func (d *recordingDriver) Answer(_ context.Context, sess Session, req AnswerRequest) ([]string, error) {
	d.note("answer " + sess.Name + " " + req.Tool)
	return []string{"Tea"}, nil
}

func (d *recordingDriver) Conversation(_ context.Context, sess Session, _ []Session, since int, _ string) (transcript.Result, error) {
	d.note("conversation " + sess.Name)
	return transcript.Result{Source: "driver", Items: []transcript.Item{{Kind: "text", ID: "1", Text: "hello"}}}, nil
}

func (d *recordingDriver) Record(_ context.Context, sess Session, _ []Session) (string, string) {
	return "", ""
}

func (d *recordingDriver) Draft(_ context.Context, sess Session) (Draft, error) {
	d.note("draft " + sess.Name)
	return Draft{Agent: "claude", Text: "writing"}, nil
}

func TestTheAgentIsReachedThroughItsSessionsDriver(t *testing.T) {
	d := &recordingDriver{}
	c, _ := servedBox(t, func(b *Box) { b.Drivers = map[string]Driver{DriverTerminal: d} })
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	bin := t.TempDir()
	fake := filepath.Join(bin, "claude")
	os.WriteFile(fake, []byte("#!/bin/sh\nexec cat\n"), 0o755)
	call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "acme", "name": "agent", "command": fake}, nil)

	var list []Session
	call(t, c, "GET", "/v1/sessions", "", nil, &list)
	if len(list) != 1 || list[0].Driver != DriverTerminal {
		t.Fatalf("the session doesn't say its driver: %+v", list)
	}

	for _, step := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/v1/sessions/agent/send", map[string]any{"text": "fix the build"}},
		{"POST", "/v1/sessions/agent/interrupt", nil},
		{"GET", "/v1/sessions/agent/controls", nil},
		{"POST", "/v1/sessions/agent/mode", map[string]string{"mode": "plan"}},
		{"POST", "/v1/sessions/agent/answer", map[string]any{"tool": "toolu_1", "answers": []any{map[string]any{"picks": []string{"Tea"}}}}},
	} {
		if status := call(t, c, step.method, step.path, "", step.body, nil); status != 200 {
			t.Fatalf("%s %s: %d", step.method, step.path, status)
		}
	}
	var conv transcript.Result
	call(t, c, "GET", "/v1/sessions/agent/transcript?since=0", "", nil, &conv)
	if conv.Source != "driver" || len(conv.Items) != 1 {
		t.Fatalf("the conversation didn't come from the driver: %+v", conv)
	}

	want := []string{"send agent fix the build", "interrupt agent", "controls agent", "mode agent plan", "answer agent toolu_1", "conversation agent"}
	if got := d.seen(); !slices.Equal(got, want) {
		t.Fatalf("driver calls = %q, want %q", got, want)
	}
}

// An answer to an agent's questions is a send, wherever it comes from: the
// box's events say it went (who, never what) with the turn the agent waits
// in, so a plugin watching them sees the question is answered, and a
// before:session.send gate can refuse it as it refuses a prompt.
func TestAnAnswerIsAnnouncedAndPassesTheSendGate(t *testing.T) {
	d := &recordingDriver{}
	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		b.Drivers = map[string]Driver{DriverTerminal: d}
		b.Turns = &Turns{}
		b.Turns.Attach(b.Events)
		bx = b
	})
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	fake := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(fake, []byte("#!/bin/sh\nexec cat\n"), 0o755)
	var sess Session
	call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "acme", "name": "agent", "command": fake}, &sess)
	hook(bus, "agent.started", "agent", sess.Dir, "claude", "signal", "prompt")
	hook(bus, "agent.waiting", "agent", sess.Dir, "claude", "reason", "question")
	st, ok := bx.Turns.State("agent")
	if !ok || st.State != "waiting" || st.Turn == "" {
		t.Fatalf("the agent isn't waiting in a turn: %+v %v", st, ok)
	}

	var mu sync.Mutex
	var sent []events.Event
	defer bus.Observe(func(e events.Event) {
		if e.Type == "session.sent" {
			mu.Lock()
			sent = append(sent, e)
			mu.Unlock()
		}
	})()
	answer := map[string]any{"tool": "toolu_1", "answers": []any{map[string]any{"picks": []string{"Tea"}, "other": "oat milk"}}}
	if status := call(t, c, "POST", "/v1/sessions/agent/answer", "", answer, nil); status != 200 {
		t.Fatalf("answer: %d", status)
	}
	mu.Lock()
	got := slices.Clone(sent)
	mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("the answer published %d session.sent events, want 1: %+v", len(got), got)
	}
	if e := got[0]; e.Data["name"] != "agent" || e.Data["answer"] != true || e.Data["turn"] != st.Turn {
		t.Fatalf("the answer's event = %+v, want name agent, answer true, turn %s", e.Data, st.Turn)
	}
	if raw, _ := json.Marshal(got[0]); strings.Contains(string(raw), "Tea") || strings.Contains(string(raw), "oat milk") {
		t.Fatalf("the event carries the answer itself: %s", raw)
	}
	if now, _ := bx.Turns.State("agent"); now.Turn != st.Turn {
		t.Fatalf("the answer started a turn of its own: %s, was %s", now.Turn, st.Turn)
	}

	cfg := filepath.Join(t.TempDir(), "hooks.json")
	os.WriteFile(cfg, []byte(`{"hooks":[{"on":"before:session.send","run":"echo answers wait for the review; exit 1"}]}`), 0o600)
	bx.Hooks = &hooks.Runner{Path: cfg}
	var refused map[string]any
	if status := call(t, c, "POST", "/v1/sessions/agent/answer", "", answer, &refused); status != 403 || !strings.Contains(fmt.Sprint(refused), "answers wait for the review") {
		t.Fatalf("a gated answer = %d %v, want 403 with the gate's words", status, refused)
	}
	if n := strings.Count(strings.Join(d.seen(), "\n"), "answer agent"); n != 1 {
		t.Fatalf("the refused answer reached the agent: %q", d.seen())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 {
		t.Fatalf("the refused answer was announced: %+v", sent)
	}
}
