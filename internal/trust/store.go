// Package trust records which peers an installation has paired with: the box
// keeps its paired laptops, the laptop keeps its paired boxes.
package trust

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/identity"
	"github.com/cosscom/shipyard/internal/statefile"
)

type Peer struct {
	Name    string `json:"name"`
	Address string `json:"address,omitempty"`
	// Network names the tailnet the box is reached through; empty means
	// this machine's own network.
	Network     string               `json:"network,omitempty"`
	Fingerprint identity.Fingerprint `json:"fingerprint"`
	PairedAt    time.Time            `json:"paired_at"`
}

var (
	ErrNameTaken = errors.New("name is already used by another paired peer")
	ErrNotFound  = errors.New("no paired peer with that name or fingerprint")
	validName    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
)

// ValidName reports whether name is safe to show in listings and use in URLs.
func ValidName(name string) bool { return validName.MatchString(name) }

type Store struct {
	path string
	// cache keeps the peers until the file changes. A box looks the
	// caller up for every request; reading the file each time took a
	// file lock that every request queued behind.
	cache statefile.Cache[[]Peer]
}

func NewStore(path string) *Store { return &Store{path: path} }

func (s *Store) List() ([]Peer, error) {
	peers, err := s.peers()
	return slices.Clone(peers), err
}

// peers is the store as last read, read again once the file changes (a
// pairing, a revoke, by this process or another). It is shared: callers
// must not change it. Errors are never kept: a store that cannot be read
// fails every lookup until it can.
func (s *Store) peers() ([]Peer, error) {
	return s.cache.Load(s.path, func() ([]Peer, error) {
		unlock, err := statefile.Lock(s.path)
		if err != nil {
			return nil, err
		}
		defer unlock()
		return s.read()
	})
}

// Trusted looks a peer up by the key it presented.
func (s *Store) Trusted(fp identity.Fingerprint) (Peer, bool, error) {
	peers, err := s.peers()
	if err != nil {
		return Peer{}, false, err
	}
	for _, p := range peers {
		if p.Fingerprint == fp {
			return p, true, nil
		}
	}
	return Peer{}, false, nil
}

func (s *Store) ByName(name string) (Peer, bool, error) {
	peers, err := s.peers()
	if err != nil {
		return Peer{}, false, err
	}
	for _, p := range peers {
		if strings.EqualFold(p.Name, name) {
			return p, true, nil
		}
	}
	return Peer{}, false, nil
}

// Add pins p. Re-pairing a known key replaces its entry; a name held by a
// different key is refused rather than silently reassigned.
func (s *Store) Add(p Peer) error {
	if !ValidName(p.Name) {
		return fmt.Errorf("invalid peer name %q", p.Name)
	}
	// Names are hostnames in URLs, which browsers lowercase.
	p.Name = strings.ToLower(p.Name)
	return s.update(func(peers []Peer) ([]Peer, error) {
		out := peers[:0]
		for _, existing := range peers {
			if existing.Fingerprint == p.Fingerprint {
				continue
			}
			if strings.EqualFold(existing.Name, p.Name) {
				return nil, ErrNameTaken
			}
			out = append(out, existing)
		}
		return append(out, p), nil
	})
}

// AddWithFreeName pins p under its name, or the first free "-2", "-3", …
// variant of it, and returns the name used.
func (s *Store) AddWithFreeName(p Peer) (string, error) {
	base := p.Name
	for i := 1; i <= 100; i++ {
		if i > 1 {
			p.Name = fmt.Sprintf("%s-%d", truncate(base, 58), i)
		}
		err := s.Add(p)
		if !errors.Is(err, ErrNameTaken) {
			return p.Name, err
		}
	}
	return "", ErrNameTaken
}

// Remove unpins the peer matching a name or full fingerprint.
func (s *Store) Remove(nameOrFingerprint string) (Peer, error) {
	var removed Peer
	err := s.update(func(peers []Peer) ([]Peer, error) {
		for i, p := range peers {
			if strings.EqualFold(p.Name, nameOrFingerprint) || p.Fingerprint.String() == nameOrFingerprint {
				removed = p
				return append(peers[:i], peers[i+1:]...), nil
			}
		}
		return nil, ErrNotFound
	})
	return removed, err
}

func (s *Store) update(change func([]Peer) ([]Peer, error)) error {
	unlock, err := statefile.Lock(s.path)
	if err != nil {
		return err
	}
	defer unlock()
	peers, err := s.read()
	if err != nil {
		return err
	}
	peers, err = change(peers)
	if err != nil {
		return err
	}
	sort.Slice(peers, func(i, j int) bool { return peers[i].Name < peers[j].Name })
	b, err := json.MarshalIndent(peers, "", "  ")
	if err != nil {
		return err
	}
	return statefile.WriteWithBackup(s.path, append(b, '\n'))
}

// read fails closed: an unreadable store is an error, never an empty one, so
// a corrupt file cannot quietly become "nobody is trusted" and get rewritten.
func (s *Store) read() ([]Peer, error) {
	b, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var peers []Peer
	if err := json.Unmarshal(b, &peers); err != nil {
		return nil, fmt.Errorf("%s is unreadable (a backup may be at %s.bak): %w", s.path, s.path, err)
	}
	return peers, nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
