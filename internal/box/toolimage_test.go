package box

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// A picture a call returned is served from the transcript, by its place in
// the result: the file it was read from is gone, and the detail names the
// pictures without carrying them.
func TestAToolsImagesAreServedFromTheTranscript(t *testing.T) {
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nexec sleep 600\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	account := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", account)
	c, _ := servedBox(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "shop", "path": gitRepo(t)}, nil)
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", SessionRequest{Location: "shop", Command: "claude"}, &sess); status != 200 {
		t.Fatalf("session: %d", status)
	}
	png, jpeg := []byte("\x89PNG\r\n\x1a\nacme-shot"), []byte("\xff\xd8\xff\xe0acme-photo")
	img := func(typ string, data []byte) map[string]any {
		return map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": typ, "data": base64.StdEncoding.EncodeToString(data)}}
	}
	at := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	lines := []map[string]any{
		{"type": "assistant", "timestamp": at, "message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "id": "toolu_shot", "name": "Read", "input": map[string]any{"file_path": "/tmp/acme-shot.png"}},
		}}},
		{"type": "user", "timestamp": at, "message": map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "toolu_shot", "content": []any{img("image/png", png), img("image/jpeg", jpeg)}},
		}}},
	}
	var rec bytes.Buffer
	for _, l := range lines {
		b, _ := json.Marshal(l)
		rec.Write(append(b, '\n'))
	}
	proj := transcript.ClaudeDirIn(account, sess.Dir)
	os.MkdirAll(proj, 0o755)
	conv := filepath.Join(proj, "conv.jsonl")
	os.WriteFile(conv, rec.Bytes(), 0o600)
	// A helper's record holds the same call.
	os.MkdirAll(transcript.HelpersDir(conv), 0o755)
	os.WriteFile(filepath.Join(transcript.HelpersDir(conv), "agent-a1.jsonl"), rec.Bytes(), 0o600)

	base := "/v1/sessions/" + url.PathEscape(sess.Name)
	var d transcript.ToolDetail
	if status := call(t, c, "GET", base+"/transcript/tool/toolu_shot", "", nil, &d); status != 200 || len(d.Images) != 2 || d.Images[1].MediaType != "image/jpeg" {
		t.Fatalf("detail: %d %+v", status, d)
	}
	get := func(path string) (int, string, []byte) {
		t.Helper()
		resp, err := c.Do(context.Background(), "GET", path, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, resp.Header.Get("Content-Type"), b
	}
	for _, prefix := range []string{base + "/transcript/tool/toolu_shot", base + "/subagents/a1/tool/toolu_shot"} {
		for i, want := range []struct {
			typ  string
			data []byte
		}{{"image/png", png}, {"image/jpeg", jpeg}} {
			status, typ, body := get(prefix + "/image/" + string(rune('0'+i)))
			if status != 200 || typ != want.typ || !bytes.Equal(body, want.data) {
				t.Fatalf("%s image %d: %d %q %q", prefix, i, status, typ, body)
			}
		}
		if status, _, _ := get(prefix + "/image/2"); status != http.StatusNotFound {
			t.Fatalf("%s: a third image: %d", prefix, status)
		}
		if status, _, _ := get(prefix + "/image/x"); status != http.StatusNotFound {
			t.Fatalf("%s: a bad index: %d", prefix, status)
		}
	}
	if status, _, _ := get(base + "/transcript/tool/toolu_none/image/0"); status != http.StatusNotFound {
		t.Fatalf("an unknown call: %d", status)
	}
}
