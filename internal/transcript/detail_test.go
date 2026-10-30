package transcript

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// withResult is a tool's result line as Claude Code writes it, with what it
// keeps about the call beside the message (toolUseResult).
func withResult(id string, extra m) m {
	l := user([]m{{"type": "tool_result", "tool_use_id": id, "content": "The file has been updated successfully."}})
	l["toolUseResult"] = extra
	return l
}

func TestDetailCarriesTheFilesLineNumbers(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	edit := []Hunk{{OldStart: 41, OldLines: 4, NewStart: 41, NewLines: 5, Lines: []string{
		"   const total = sum(items);",
		"-  return total;",
		"+  const tax = total * rate;",
		"+  return total + tax;",
		" }",
		" ",
	}}}
	write(t, p,
		assistant(tool("e1", "Edit", m{"file_path": "/w/shop/src/cart.ts", "old_string": "  return total;", "new_string": "  const tax = total * rate;\n  return total + tax;"})),
		withResult("e1", m{"filePath": "/w/shop/src/cart.ts", "oldString": "  return total;", "newString": "x", "originalFile": "…", "replaceAll": false, "userModified": false, "structuredPatch": edit}),
		// A write over a file: its change against what was there.
		assistant(tool("w1", "Write", m{"file_path": "/w/shop/main.go", "content": "package main\n\nfunc main() {}\n"})),
		withResult("w1", m{"type": "update", "filePath": "/w/shop/main.go", "content": "…", "originalFile": "…", "structuredPatch": []Hunk{
			{OldStart: 1, OldLines: 2, NewStart: 1, NewLines: 3, Lines: []string{" package main", "+", "-func old() {}", "+func main() {}"}},
		}}),
		// A new file: no hunks, the whole text is new.
		assistant(tool("w2", "Write", m{"file_path": "/w/shop/new.md", "content": "# New\n"})),
		withResult("w2", m{"type": "create", "filePath": "/w/shop/new.md", "content": "# New\n", "originalFile": nil, "structuredPatch": []any{}}),
		// An older record: no toolUseResult at all.
		assistant(tool("e2", "Edit", m{"file_path": "/w/shop/a.ts", "old_string": "a", "new_string": "b"})),
		user([]m{{"type": "tool_result", "tool_use_id": "e2", "content": "ok"}}),
		// A failed edit: its result is a string, and nothing changed.
		assistant(tool("e3", "Edit", m{"file_path": "/w/shop/a.ts", "old_string": "zz", "new_string": "b"})),
		func() m {
			l := user([]m{{"type": "tool_result", "tool_use_id": "e3", "content": "String to replace not found", "is_error": true}})
			l["toolUseResult"] = "Error: String to replace not found in file."
			return l
		}(),
		// Malformed hunks are dropped, not passed on.
		assistant(tool("e4", "Edit", m{"file_path": "/w/shop/a.ts", "old_string": "a", "new_string": "b"})),
		withResult("e4", m{"structuredPatch": []m{{"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "lines": []string{"?a"}}}}),
	)

	d, err := Detail("claude", p, "/w/shop", "e1")
	if err != nil || d.File != "src/cart.ts" || d.Old != "  return total;" || !reflect.DeepEqual(d.Hunks, edit) {
		t.Fatalf("edit %+v %v", d, err)
	}
	d, _ = Detail("claude", p, "/w/shop", "w1")
	if len(d.Hunks) != 1 || d.Hunks[0].NewLines != 3 || d.New != "package main\n\nfunc main() {}\n" {
		t.Fatalf("write over %+v", d)
	}
	for _, id := range []string{"w2", "e2", "e3", "e4"} {
		if d, _ := Detail("claude", p, "/w/shop", id); d.Hunks != nil {
			t.Fatalf("%s: want no hunks, got %+v", id, d.Hunks)
		}
	}
}

func TestDetailDropsHugeHunks(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	lines := make([]string, 0, 3000)
	for i := 0; i < 3000; i++ {
		lines = append(lines, "+"+strings.Repeat("x", 60))
	}
	write(t, p,
		assistant(tool("w1", "Write", m{"file_path": "/w/big.txt", "content": "x"})),
		withResult("w1", m{"type": "update", "structuredPatch": []Hunk{{OldStart: 1, NewStart: 1, NewLines: 3000, Lines: lines}}}),
	)
	if d, _ := Detail("claude", p, "/w", "w1"); d.Hunks != nil {
		t.Fatalf("want none past the cap, got %d", len(d.Hunks))
	}
}

// imageBlock is a picture in a tool's result, as Claude Code keeps it.
func imageBlock(mediaType string, data []byte) m {
	return m{"type": "image", "source": m{"type": "base64", "media_type": mediaType, "data": base64.StdEncoding.EncodeToString(data)}}
}

func TestDetailNamesTheImagesAResultHoldsButNotTheirBytes(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	png, gif := []byte("\x89PNG\r\n\x1a\nacme-one"), []byte("GIF89a-acme-two")
	write(t, p,
		assistant(tool("r1", "Read", m{"file_path": "/tmp/acme-shot.png"})),
		user([]m{{"type": "tool_result", "tool_use_id": "r1", "content": []m{
			{"type": "text", "text": "two screenshots"},
			imageBlock("image/png", png),
			imageBlock("image/tiff", []byte("II*\x00acme")),
			imageBlock("image/gif", gif),
		}}}),
	)
	d, err := Detail("claude", p, "/w/shop", "r1")
	if err != nil {
		t.Fatal(err)
	}
	if want := []ToolImage{{N: 0, Line: 1, MediaType: "image/png"}, {N: 2, Line: 3, MediaType: "image/gif"}}; !reflect.DeepEqual(d.Images, want) {
		t.Fatalf("images %+v, want %+v", d.Images, want)
	}
	if d.Output != "two screenshots\n[image]\n[image]\n[image]" {
		t.Fatalf("output %q", d.Output)
	}
	b, _ := json.Marshal(d)
	if strings.Contains(string(b), base64.StdEncoding.EncodeToString(png)) || strings.Contains(string(b), "base64") {
		t.Fatalf("the detail carries the image: %s", b)
	}

	typ, data, err := Image("claude", p, "r1", 0)
	if err != nil || typ != "image/png" || !bytes.Equal(data, png) {
		t.Fatalf("image 0: %q %q %v", typ, data, err)
	}
	if typ, data, err = Image("claude", p, "r1", 2); err != nil || typ != "image/gif" || !bytes.Equal(data, gif) {
		t.Fatalf("image 2: %q %q %v", typ, data, err)
	}
	for _, c := range []struct {
		id string
		n  int
	}{{"r1", 1}, {"r1", 3}, {"r1", -1}, {"nope", 0}, {"", 0}} {
		if _, _, err := Image("claude", p, c.id, c.n); !errors.Is(err, ErrNoImage) {
			t.Fatalf("%s/%d: want ErrNoImage, got %v", c.id, c.n, err)
		}
	}
}

// A picture stands at its own line: never at a text block's line that only
// reads "[image]", and at the cut when the middle of a long output is left
// out.
func TestAToolsImagesStandAtTheirOwnLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	shot := imageBlock("image/png", []byte("\x89PNG acme"))
	long := strings.Repeat("acme log line\n", 4000)
	write(t, p,
		assistant(tool("m1", "mcp__acme__shot", m{"page": "checkout"})),
		user([]m{{"type": "tool_result", "tool_use_id": "m1", "content": []m{
			{"type": "text", "text": "how it is written:\n[image]\nthen"},
			shot,
		}}}),
		assistant(tool("m2", "mcp__acme__shots", m{"page": "logs"})),
		user([]m{{"type": "tool_result", "tool_use_id": "m2", "content": []m{
			shot, {"type": "text", "text": long}, shot, {"type": "text", "text": long}, shot,
		}}}),
	)
	d, _ := Detail("claude", p, "/w", "m1")
	if want := []ToolImage{{N: 0, Line: 3, MediaType: "image/png"}}; !reflect.DeepEqual(d.Images, want) {
		t.Fatalf("images %+v, want %+v", d.Images, want)
	}
	if lines := strings.Split(d.Output, "\n"); lines[1] != "[image]" || lines[3] != "[image]" {
		t.Fatalf("output %q", d.Output)
	}

	d, _ = Detail("claude", p, "/w", "m2")
	if !d.Truncated || len(d.Images) != 3 {
		t.Fatalf("truncated %v, images %+v", d.Truncated, d.Images)
	}
	lines := strings.Split(d.Output, "\n")
	for i, want := range []string{"[image]", "… ", "[image]"} {
		at := d.Images[i].Line
		if at >= len(lines) || !strings.HasPrefix(lines[at], want) {
			t.Fatalf("image %d at line %d of %d: %q", i, at, len(lines), lines[min(at, len(lines)-1)])
		}
	}
}
