package agent

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestFanOutAsksEveryBoxAFewAtATime(t *testing.T) {
	const n = 3*fanOutLimit + 1
	var running, most atomic.Int32
	asked := make([]bool, n)
	fanOut(n, func(i int) {
		now := running.Add(1)
		for {
			m := most.Load()
			if now <= m || most.CompareAndSwap(m, now) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		asked[i] = true
		running.Add(-1)
	})
	for i, ok := range asked {
		if !ok {
			t.Fatalf("box %d was not asked", i)
		}
	}
	// More than one at once (in turn would be one), never past the limit.
	if m := most.Load(); m > fanOutLimit || m < 2 {
		t.Errorf("%d asked at once", m)
	}
}
