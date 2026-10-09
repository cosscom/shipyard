package trust

import (
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/identity"
)

func fp() identity.Fingerprint {
	var f identity.Fingerprint
	rand.Read(f[:])
	return f
}

func TestAddAndLookUpByKeyAndName(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "boxes.json"))
	box := Peer{Name: "dev-alex", Address: "203.0.113.5:7444", Fingerprint: fp(), PairedAt: time.Now().UTC()}
	if err := s.Add(box); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := s.Trusted(box.Fingerprint); err != nil || !ok || got.Name != "dev-alex" {
		t.Fatalf("Trusted = %+v, %v, %v", got, ok, err)
	}
	if _, ok, _ := s.Trusted(fp()); ok {
		t.Fatal("an unknown key was trusted")
	}
	if got, ok, err := s.ByName("dev-alex"); err != nil || !ok || got.Address != box.Address {
		t.Fatalf("ByName = %+v, %v, %v", got, ok, err)
	}
}

func TestANameHeldByAnotherKeyIsNotReassigned(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "boxes.json"))
	original := Peer{Name: "dev-alex", Fingerprint: fp()}
	if err := s.Add(original); err != nil {
		t.Fatal(err)
	}
	if err := s.Add(Peer{Name: "dev-alex", Fingerprint: fp()}); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("a second key took an existing name: %v", err)
	}
	if got, _, _ := s.ByName("dev-alex"); got.Fingerprint != original.Fingerprint {
		t.Fatal("the name now points at a different key")
	}
}

// Names are hostnames in URLs, which browsers lowercase, so they must not
// differ by case alone.
func TestNamesAreCaseInsensitive(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "boxes.json"))
	if err := s.Add(Peer{Name: "Dev-Alex", Fingerprint: fp()}); err != nil {
		t.Fatal(err)
	}
	if got, ok, _ := s.ByName("dev-alex"); !ok || got.Name != "dev-alex" {
		t.Fatalf("ByName(dev-alex) = %+v, %v; want the box, stored lowercase", got, ok)
	}
	if err := s.Add(Peer{Name: "DEV-ALEX", Fingerprint: fp()}); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("a second key took the same name in another case: %v", err)
	}
}

func TestRepairingAKnownKeyReplacesItsEntry(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "boxes.json"))
	key := fp()
	if err := s.Add(Peer{Name: "old", Address: "a:1", Fingerprint: key}); err != nil {
		t.Fatal(err)
	}
	if err := s.Add(Peer{Name: "new", Address: "b:2", Fingerprint: key}); err != nil {
		t.Fatal(err)
	}
	peers, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].Name != "new" || peers[0].Address != "b:2" {
		t.Fatalf("peers = %+v, want the single re-paired entry", peers)
	}
}

func TestAddWithFreeNameSuffixesCollisions(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "clients.json"))
	for i, want := range []string{"alex-mbp", "alex-mbp-2", "alex-mbp-3"} {
		got, err := s.AddWithFreeName(Peer{Name: "alex-mbp", Fingerprint: fp()})
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("pairing %d named %q, want %q", i+1, got, want)
		}
	}
}

func TestRemoveByNameOrFingerprint(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "clients.json"))
	a := Peer{Name: "a", Fingerprint: fp()}
	b := Peer{Name: "b", Fingerprint: fp()}
	s.Add(a)
	s.Add(b)
	if _, err := s.Remove("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Remove(b.Fingerprint.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Remove("a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removing twice: %v", err)
	}
	if peers, _ := s.List(); len(peers) != 0 {
		t.Fatalf("peers left after removal: %+v", peers)
	}
}

func TestACorruptStoreFailsClosedAndIsNotOverwritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(path)
	if _, _, err := s.Trusted(fp()); err == nil {
		t.Fatal("a corrupt store answered a trust lookup")
	}
	if err := s.Add(Peer{Name: "x", Fingerprint: fp()}); err == nil {
		t.Fatal("a corrupt store was rewritten by Add")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "{not json" {
		t.Fatalf("corrupt store was modified: %q", b)
	}
}

// A box keeps its laptops between requests, yet a laptop that another
// process (berthd revoke) removes is refused on its very next request, and
// a store that turns unreadable fails closed at once.
func TestARevokeByAnotherProcessAppliesAtOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clients.json")
	box, cli := NewStore(path), NewStore(path)
	alex := Peer{Name: "alex", Fingerprint: fp()}
	sam := Peer{Name: "sam1", Fingerprint: fp()} // same length: same file size
	if err := cli.Add(alex); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, ok, err := box.Trusted(alex.Fingerprint); !ok || err != nil {
			t.Fatalf("trusted = %v, %v", ok, err)
		}
	}
	if _, err := cli.Remove("alex"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := box.Trusted(alex.Fingerprint); ok {
		t.Fatal("a revoked laptop was still trusted")
	}
	if err := cli.Add(alex); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := box.Trusted(alex.Fingerprint); !ok {
		t.Fatal("a paired laptop was not trusted")
	}
	// One peer swapped for another of the same size, straight after.
	if _, err := cli.Remove("alex"); err != nil {
		t.Fatal(err)
	}
	if err := cli.Add(Peer{Name: sam.Name, Fingerprint: sam.Fingerprint, PairedAt: alex.PairedAt}); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := box.Trusted(alex.Fingerprint); ok {
		t.Fatal("a replaced laptop was still trusted")
	}
	if _, ok, _ := box.Trusted(sam.Fingerprint); !ok {
		t.Fatal("its replacement was not trusted")
	}
	if list, _ := box.List(); len(list) == 1 {
		list[0].Fingerprint = alex.Fingerprint
	}
	if _, ok, _ := box.Trusted(sam.Fingerprint); !ok {
		t.Fatal("changing a listing changed the store")
	}
	if err := os.WriteFile(path+".tmp", []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		t.Fatal(err)
	}
	if _, _, err := box.Trusted(sam.Fingerprint); err == nil {
		t.Fatal("a corrupt store answered a trust lookup")
	}
}

func TestInvalidNamesAreRefused(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "boxes.json"))
	for _, name := range []string{"", "-leading", "has space", "a/b", "ünïcode", string(make([]byte, 64))} {
		if err := s.Add(Peer{Name: name, Fingerprint: fp()}); err == nil {
			t.Errorf("accepted invalid name %q", name)
		}
	}
}
