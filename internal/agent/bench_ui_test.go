package agent

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/box"
)

// BenchmarkUIBoxAPI is one app request relayed to a box through the
// laptop agent's app API (/v1/boxes/{box}/api/…), the way the app reads
// every box's sessions, worktrees and files.
func BenchmarkUIBoxAPI(b *testing.B) {
	one := newBox(b)
	one.services = []box.Service{{Location: "shop", Worktree: "checkout", Port: 3000}}
	a := startAgentConfig(b, one.pairLaptop(), &fakeNetworks{}, func(c *Config) { c.HealthInterval = time.Hour })
	eventually(b, "box online", func() bool { return stateOf(b, a) == StateOnline })
	var tok string
	eventually(b, "ui token", func() bool {
		raw, err := os.ReadFile(filepath.Join(a.dir, UITokenFile))
		tok = strings.TrimSpace(string(raw))
		return err == nil && tok != ""
	})
	c := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64}}
	get := func() error {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+a.ui+"/v1/boxes/devbox/api/services", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		resp, err := c.Do(req)
		if err != nil {
			return err
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			b.Fatalf("status %d", resp.StatusCode)
		}
		return nil
	}
	eventually(b, "ui up", func() bool { return get() == nil })
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if err := get(); err != nil {
				b.Error(err)
				return
			}
		}
	})
}
