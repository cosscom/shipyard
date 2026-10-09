package wire

import (
	"context"
	"io"
	"net"
	"testing"
)

// benchEcho is a server on the box's loopback that echoes what it reads.
func benchEcho(b *testing.B) int {
	b.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// BenchmarkDialPortRoundTrip opens a stream to a box port, sends a small
// request, reads the answer and closes it: one proxied connection.
func BenchmarkDialPortRoundTrip(b *testing.B) {
	c := paired(b, startBox(b))
	port := benchEcho(b)
	msg := make([]byte, 1<<10)
	buf := make([]byte, len(msg))
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		conn, err := c.DialPort(context.Background(), port)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := conn.Write(msg); err != nil {
			b.Fatal(err)
		}
		if _, err := io.ReadFull(conn, buf); err != nil {
			b.Fatal(err)
		}
		conn.Close()
	}
}

// BenchmarkStreamEcho pushes data through one long stream and back.
func BenchmarkStreamEcho(b *testing.B) {
	c := paired(b, startBox(b))
	port := benchEcho(b)
	conn, err := c.DialPort(context.Background(), port)
	if err != nil {
		b.Fatal(err)
	}
	defer conn.Close()
	chunk := make([]byte, 64<<10)
	buf := make([]byte, len(chunk))
	b.SetBytes(int64(len(chunk)))
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		go conn.Write(chunk)
		if _, err := io.ReadFull(conn, buf); err != nil {
			b.Fatal(err)
		}
	}
}
