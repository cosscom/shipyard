package forward

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// pairs hands out both ends of Unix socket connections: like loopback TCP
// connections, with half-close, but using no ephemeral ports, which a
// benchmark opening thousands would run out of.
type pairs struct{ ln net.Listener }

func newPairs(b *testing.B) pairs {
	b.Helper()
	dir, err := os.MkdirTemp("", "fwd")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { os.RemoveAll(dir) })
	ln, err := net.Listen("unix", filepath.Join(dir, "s"))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { ln.Close() })
	return pairs{ln}
}

func (p pairs) next(b *testing.B) (net.Conn, net.Conn) {
	c, err := net.Dial("unix", p.ln.Addr().String())
	if err != nil {
		b.Fatal(err)
	}
	s, err := p.ln.Accept()
	if err != nil {
		b.Fatal(err)
	}
	return c, s
}

// BenchmarkBridgeConn bridges one short connection per op (a request and
// its answer), as a forwarded port's clients make them.
func BenchmarkBridgeConn(b *testing.B) {
	p := newPairs(b)
	msg := make([]byte, 4<<10)
	b.SetBytes(int64(len(msg)))
	b.ReportAllocs()
	for range b.N {
		client, local := p.next(b)
		upstream, server := p.next(b)
		done := make(chan struct{})
		go func() { Bridge(context.Background(), local, upstream); close(done) }()
		go func() {
			// The far end answers what it reads, with a buffer of its own.
			buf := make([]byte, len(msg))
			for {
				n, err := server.Read(buf)
				server.Write(buf[:n])
				if err != nil {
					break
				}
			}
			server.Close()
		}()
		client.Write(msg)
		client.(*net.UnixConn).CloseWrite()
		io.Copy(io.Discard, client)
		client.Close()
		<-done
	}
}

// BenchmarkBridgeStream pushes data one way through a long bridge.
func BenchmarkBridgeStream(b *testing.B) {
	p := newPairs(b)
	client, local := p.next(b)
	upstream, server := p.next(b)
	go Bridge(context.Background(), local, upstream)
	go io.Copy(io.Discard, server)
	chunk := make([]byte, 64<<10)
	b.SetBytes(int64(len(chunk)))
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, err := client.Write(chunk); err != nil {
			b.Fatal(err)
		}
	}
	b.StopTimer()
	client.Close()
	server.Close()
}
