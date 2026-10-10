package statefile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCacheReadsAFileAgainOnlyOnceItChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	var c Cache[string]
	reads := 0
	load := func() string {
		t.Helper()
		v, err := c.Load(path, func() (string, error) {
			reads++
			b, err := os.ReadFile(path)
			if os.IsNotExist(err) {
				return "none", nil
			}
			return string(b), err
		})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	if v := load(); v != "none" || reads != 1 {
		t.Fatalf("missing file: %q after %d reads", v, reads)
	}
	if v := load(); v != "none" || reads != 1 {
		t.Fatalf("still missing: %q after %d reads", v, reads)
	}
	if err := Write(path, []byte("aaaa")); err != nil {
		t.Fatal(err)
	}
	if v := load(); v != "aaaa" || reads != 2 {
		t.Fatalf("new file: %q after %d reads", v, reads)
	}
	for range 3 {
		if v := load(); v != "aaaa" || reads != 2 {
			t.Fatalf("unchanged file: %q after %d reads", v, reads)
		}
	}
	// The same size, written straight after: still a new version.
	if err := Write(path, []byte("bbbb")); err != nil {
		t.Fatal(err)
	}
	if v := load(); v != "bbbb" || reads != 3 {
		t.Fatalf("rewritten file: %q after %d reads", v, reads)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if v := load(); v != "none" || reads != 4 {
		t.Fatalf("removed file: %q after %d reads", v, reads)
	}
}

func TestCacheKeepsNoErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	if err := Write(path, []byte("x")); err != nil {
		t.Fatal(err)
	}
	var c Cache[int]
	broken := errors.New("unreadable")
	if _, err := c.Load(path, func() (int, error) { return 0, broken }); err != broken {
		t.Fatalf("err = %v", err)
	}
	if v, err := c.Load(path, func() (int, error) { return 7, nil }); err != nil || v != 7 {
		t.Fatalf("after an error: %d, %v", v, err)
	}
}
