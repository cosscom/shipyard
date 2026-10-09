// Package forward bridges local TCP ports on the laptop to ports on a box.
package forward

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"syscall"

	"github.com/cosscom/shipyard/internal/copybuf"
)

// DialFunc opens a stream to a port on the box. It is looked up per
// connection, so a box that re-pairs or reconnects is picked up without
// restarting the forward.
type DialFunc func(ctx context.Context, port int) (net.Conn, error)

// Listen reserves port on both loopback addresses. macOS resolves localhost to
// ::1 first, so if another program already holds ::1 on this port, clients of
// "localhost" would silently reach it instead of the box; that is an error.
// A missing IPv6 stack is not.
func Listen(port int) ([]net.Listener, error) {
	v4, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("local port %d is in use: %w", port, err)
	}
	v6, err := net.Listen("tcp", net.JoinHostPort("::1", strconv.Itoa(port)))
	if errors.Is(err, syscall.EADDRINUSE) {
		v4.Close()
		return nil, fmt.Errorf("local port %d is already used on ::1 by another program", port)
	}
	if err != nil {
		return []net.Listener{v4}, nil
	}
	return []net.Listener{v4, v6}, nil
}

// Serve accepts connections on ln and bridges each to remote on the box until
// ctx is cancelled or ln is closed. A connection the box cannot take is
// closed at once, so clients fail fast and retry rather than hang.
func Serve(ctx context.Context, ln net.Listener, remote int, dial DialFunc, onError func(error)) {
	stop := context.AfterFunc(ctx, func() { ln.Close() })
	defer stop()
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		local, err := ln.Accept()
		if err != nil {
			return
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			upstream, err := dial(ctx, remote)
			if err != nil {
				// Report before closing: the close is what the client sees,
				// and the reason must already be on record when it does.
				if onError != nil {
					onError(err)
				}
				local.Close()
				return
			}
			Bridge(ctx, local, upstream)
		}()
	}
}

type closeWriter interface{ CloseWrite() error }

// Bridge copies both ways until both directions finish, passing half-closes
// through, then closes both connections. Cancelling ctx closes them early.
func Bridge(ctx context.Context, a, b net.Conn) {
	stop := context.AfterFunc(ctx, func() { a.Close(); b.Close() })
	defer stop()
	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		_, err := copybuf.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok && err == nil {
			cw.CloseWrite()
			return
		}
		// Anything other than a clean EOF ends the whole connection; half
		// of a broken bridge is not worth keeping open.
		a.Close()
		b.Close()
	}
	go pipe(a, b)
	go pipe(b, a)
	wg.Wait()
	a.Close()
	b.Close()
}
