// Package copybuf copies between connections with pooled buffers. io.Copy
// between a TCP connection and anything but another socket (an HTTP/2
// stream, a hijacked HTTP connection) makes a fresh 32 KB buffer each time,
// and so does httputil.ReverseProxy for every request it relays: the
// *.localhost proxy, port forwards and box streams do that for every
// connection and request, so the buffers are kept here and reused.
package copybuf

import (
	"io"
	"net"
	"sync"
)

// Size is the buffer size, io.Copy's own.
const Size = 32 << 10

var pool = sync.Pool{New: func() any { return new([Size]byte) }}

// Copy is io.Copy with a pooled buffer. Between two TCP connections it is
// io.Copy itself, which on Linux moves the data in the kernel instead.
func Copy(dst io.Writer, src io.Reader) (int64, error) {
	if _, ok := dst.(*net.TCPConn); ok {
		if _, ok := src.(*net.TCPConn); ok {
			return io.Copy(dst, src)
		}
	}
	buf := pool.Get().(*[Size]byte)
	defer pool.Put(buf)
	// Hiding ReadFrom and WriteTo makes CopyBuffer use buf: the
	// connections' own fallbacks would make a buffer of their own.
	return io.CopyBuffer(writerOnly{dst}, readerOnly{src}, buf[:])
}

type writerOnly struct{ io.Writer }
type readerOnly struct{ io.Reader }

// Pool is a httputil.BufferPool over the same buffers.
type Pool struct{}

func (Pool) Get() []byte { return pool.Get().(*[Size]byte)[:] }

func (Pool) Put(b []byte) {
	if cap(b) >= Size {
		pool.Put((*[Size]byte)(b[:Size]))
	}
}
