package copybuf

import (
	"bytes"
	"io"
	"net"
	"runtime"
	"strings"
	"testing"
)

func TestCopyCopiesEverything(t *testing.T) {
	src := strings.Repeat("shipyard ", 20000) // several buffers' worth
	var dst bytes.Buffer
	n, err := Copy(&dst, strings.NewReader(src))
	if err != nil || n != int64(len(src)) || dst.String() != src {
		t.Fatalf("copied %d, %v", n, err)
	}
}

func TestCopyBetweenConnectionsReusesItsBuffer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
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
			go func() { io.Copy(c, bytes.NewReader(make([]byte, 4096))); c.Close() }()
		}
	}()
	copyOne := func() {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		if n, err := Copy(io.Discard, c); err != nil || n != 4096 {
			t.Fatalf("copied %d, %v", n, err)
		}
	}
	copyOne()
	if raceEnabled {
		return
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	const runs = 20
	for range runs {
		copyOne()
	}
	runtime.ReadMemStats(&after)
	// io.Copy from a TCP connection makes a 32 KB buffer every time; the
	// pooled one is reused (the dial itself allocates a little).
	if per := (after.TotalAlloc - before.TotalAlloc) / runs; per > 16<<10 {
		t.Errorf("%d bytes allocated per copy", per)
	}
}

func TestPoolHandsBackFullBuffers(t *testing.T) {
	var p Pool
	b := p.Get()
	if len(b) != Size {
		t.Fatalf("got %d bytes", len(b))
	}
	p.Put(b)
	p.Put(make([]byte, 10)) // too small: dropped, not kept
	if b := p.Get(); len(b) != Size {
		t.Fatalf("got %d bytes", len(b))
	}
}
