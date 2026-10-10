package trust

import (
	"crypto/sha256"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/identity"
)

// BenchmarkTrusted looks a key up in a store of a few peers, as a box does
// for every request a laptop makes.
func BenchmarkTrusted(b *testing.B) {
	s := NewStore(filepath.Join(b.TempDir(), "clients.json"))
	var last identity.Fingerprint
	for i := range 4 {
		last = identity.Fingerprint(sha256.Sum256([]byte{byte(i)}))
		if err := s.Add(Peer{Name: "laptop-" + strconv.Itoa(i), Fingerprint: last, PairedAt: time.Now()}); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, ok, err := s.Trusted(last); !ok || err != nil {
				b.Fatal(ok, err)
			}
		}
	})
}
