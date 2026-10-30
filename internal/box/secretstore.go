package box

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/statefile"
)

// Saved secrets: a value a person typed into a secret card is kept by a
// store, and an agent gets a reference to it (box://NAME, gcp://…), never
// the value. Each store is a provider behind one interface, registered by
// id and reference scheme, so another provider (Vercel, AWS) is one file:
// the card, the API, `berthd secret exec` and Settings only ever go
// through SecretStore.
//
// Besides what each store keeps, the box keeps an index of the secrets it
// saved (name, store, environment, who asked and why, when it expires;
// never a value), which reuse, Settings and the expiry sweep read.

// SecretStore is one provider's store, opened for one place in it (a GCP
// project; "" for a provider with one place).
type SecretStore interface {
	// Label says where a value goes, for the card and Settings:
	// "Keychain", "Encrypted file", "GCP Secret Manager".
	Label() string
	// Save keeps a value and returns the reference that reads it.
	Save(ctx context.Context, s SecretSave) (ref string, err error)
	// Resolve reads a reference's value.
	Resolve(ctx context.Context, ref string) (string, error)
	// List is what the store holds that Shipyard saved, without values.
	List(ctx context.Context) ([]SecretMeta, error)
	// Delete removes a reference's secret.
	Delete(ctx context.Context, ref string) error
}

// SecretSave is one value to keep, and what it is for.
type SecretSave struct {
	Name        string
	Value       string
	Environment string
	Location    string
	// Grant is a service account to give read access to this one secret,
	// where the store can (StoreCaps.Grant).
	Grant string
}

// StoreCaps is what a provider can do beyond keeping values.
type StoreCaps struct {
	// Expiry: a saved secret can be given a lifetime, after which the box
	// deletes it.
	Expiry bool `json:"expiry"`
	// Labels: the store marks what Shipyard saved, so it can list it.
	Labels bool `json:"labels"`
	// Grant: the store can give one service account access to one secret.
	Grant bool `json:"grant"`
}

// StoreEnv is what a provider opens its store with.
type StoreEnv struct {
	// Dir is the box's state folder; Box names the box.
	Dir string
	Box string
	// Where is the place in the provider: a GCP project.
	Where string
	// Bins overrides the programs a provider runs, by name ("security",
	// "secret-tool", "gcloud"): tests' fakes.
	Bins map[string]string
}

func (e StoreEnv) bin(name string) (string, error) {
	if p := e.Bins[name]; p != "" {
		if _, err := os.Stat(p); err != nil {
			return "", err
		}
		return p, nil
	}
	if p, err := toolPath(name); err == nil {
		return p, nil
	}
	// Where gcloud and the like install themselves, which a service
	// manager's PATH may leave out.
	dirs := []string{"/opt/homebrew/bin", "/usr/local/bin", "/snap/bin"}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, "google-cloud-sdk", "bin"))
	}
	for _, dir := range dirs {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s is not installed on this box", name)
}

// secretProvider is one registered provider.
type secretProvider struct {
	// ID is what a request's --store names; Scheme the references it
	// reads ("box" reads box://NAME).
	ID, Scheme string
	// Name is the provider, for the store list ("Local", "GCP Secret Manager").
	Name string
	Caps StoreCaps
	// NeedsWhere: the store must be told a place (a GCP project).
	NeedsWhere bool
	// ValidateRef says what is wrong with a reference to this provider.
	ValidateRef func(ref string) error
	// WhereOf is the place a reference names, so it resolves without the
	// settings that saved it.
	WhereOf func(ref string) string
	Open func(env StoreEnv) SecretStore
}

var (
	secretProvidersMu sync.RWMutex
	secretProviders   = map[string]*secretProvider{}
)

// registerSecretStore adds a provider; each provider's file registers
// itself in an init.
func registerSecretStore(p *secretProvider) {
	secretProvidersMu.Lock()
	defer secretProvidersMu.Unlock()
	secretProviders[p.ID] = p
}

func secretProviderByID(id string) *secretProvider {
	secretProvidersMu.RLock()
	defer secretProvidersMu.RUnlock()
	return secretProviders[id]
}

func secretProviderByScheme(scheme string) *secretProvider {
	secretProvidersMu.RLock()
	defer secretProvidersMu.RUnlock()
	for _, p := range secretProviders {
		if p.Scheme == scheme {
			return p
		}
	}
	return nil
}

func secretProviderOf(ref string) *secretProvider {
	scheme, _, ok := strings.Cut(ref, "://")
	if !ok {
		return nil
	}
	return secretProviderByScheme(scheme)
}

// secretProviderIDs are the registered providers, local first.
func secretProviderIDs() []string {
	secretProvidersMu.RLock()
	defer secretProvidersMu.RUnlock()
	ids := make([]string, 0, len(secretProviders))
	for id := range secretProviders {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if (ids[i] == "local") != (ids[j] == "local") {
			return ids[i] == "local"
		}
		return ids[i] < ids[j]
	})
	return ids
}

// secretName is what a saved secret may be called: an environment
// variable's name.
var secretName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)

// SecretMeta is one saved secret as Settings lists it: never a value.
type SecretMeta struct {
	Name  string `json:"name"`
	Ref   string `json:"ref"`
	Store string `json:"store"`
	// StoreLabel is where the value is ("Keychain", "GCP Secret Manager");
	// Where the place in the store (a GCP project).
	StoreLabel  string     `json:"store_label"`
	Where       string     `json:"where,omitempty"`
	Environment string     `json:"environment,omitempty"`
	Created     time.Time  `json:"created"`
	Expires     *time.Time `json:"expires,omitempty"`
	Session     string     `json:"session,omitempty"`
	Reason      string     `json:"reason,omitempty"`
	Location    string     `json:"location,omitempty"`
}

func (m SecretMeta) expired(now time.Time) bool {
	return m.Expires != nil && !now.Before(*m.Expires)
}

// SecretIndex is the box's record of the secrets it saved, in one private
// file. It never holds a value.
type SecretIndex struct {
	Path string
	mu   sync.Mutex
}

func (x *SecretIndex) read() []SecretMeta {
	var all []SecretMeta
	if b, err := os.ReadFile(x.Path); err == nil {
		json.Unmarshal(b, &all)
	}
	return all
}

// All is every secret the box saved.
func (x *SecretIndex) All() []SecretMeta {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.read()
}

// Get is the secret a reference names.
func (x *SecretIndex) Get(ref string) (SecretMeta, bool) {
	for _, m := range x.All() {
		if m.Ref == ref {
			return m, true
		}
	}
	return SecretMeta{}, false
}

// Put records a saved secret, replacing what was recorded for its
// reference.
func (x *SecretIndex) Put(m SecretMeta) error {
	return x.update(func(all []SecretMeta) []SecretMeta {
		out := all[:0]
		for _, o := range all {
			if o.Ref != m.Ref {
				out = append(out, o)
			}
		}
		return append(out, m)
	})
}

// Remove forgets a reference.
func (x *SecretIndex) Remove(ref string) error {
	return x.update(func(all []SecretMeta) []SecretMeta {
		out := all[:0]
		for _, o := range all {
			if o.Ref != ref {
				out = append(out, o)
			}
		}
		return out
	})
}

func (x *SecretIndex) update(f func([]SecretMeta) []SecretMeta) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	unlock, err := statefile.Lock(x.Path)
	if err != nil {
		return err
	}
	defer unlock()
	all := f(x.read())
	if all == nil {
		all = []SecretMeta{}
	}
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	return statefile.Write(x.Path, b)
}

// SecretStores opens the box's stores: the registered providers, with the
// box's settings for where each keeps things.
type SecretStores struct {
	// Dir is the box's state folder; the index and the local store live in
	// it.
	Dir string
	Box string
	// Bins overrides providers' programs (tests).
	Bins map[string]string
	// Now is the clock; nil is time.Now.
	Now func() time.Time

	once  sync.Once
	index *SecretIndex
	// mu keeps a store's write and its index entry together, apart from the
	// sweep's check and delete.
	mu sync.Mutex
}

// locked runs f with the stores' writes held.
func (s *SecretStores) locked(f func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return f()
}

// Expired says whether ref is a saved secret past its expiry.
func (s *SecretStores) Expired(ref string) error {
	if m, ok := s.Index().Get(ref); ok && m.expired(s.now()) {
		return fmt.Errorf("%s %w on %s", m.Name, errSecretExpired, m.Expires.Local().Format("2 Jan 15:04"))
	}
	return nil
}

func (s *SecretStores) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Index is the box's record of what it saved.
func (s *SecretStores) Index() *SecretIndex {
	s.once.Do(func() { s.index = &SecretIndex{Path: filepath.Join(s.Dir, "secrets", "index.json")} })
	return s.index
}

func (s *SecretStores) env(where string) StoreEnv {
	return StoreEnv{Dir: s.Dir, Box: s.Box, Where: where, Bins: s.Bins}
}

// Open is provider id's store at where.
func (s *SecretStores) Open(id, where string) (SecretStore, error) {
	p := secretProviderByID(id)
	if p == nil {
		return nil, fmt.Errorf("there is no secret store %q; this box has %s", id, strings.Join(secretProviderIDs(), ", "))
	}
	if p.NeedsWhere && where == "" {
		return nil, fmt.Errorf("the %s store needs a project: set it in Settings → Secrets", p.Name)
	}
	return p.Open(s.env(where)), nil
}

// ForRef is the store that reads ref.
func (s *SecretStores) ForRef(ref string) (SecretStore, error) {
	p := secretProviderOf(ref)
	if p == nil {
		return nil, fmt.Errorf("%q is not a saved secret's reference", ref)
	}
	if err := p.ValidateRef(ref); err != nil {
		return nil, err
	}
	where := ""
	if p.WhereOf != nil {
		where = p.WhereOf(ref)
	}
	return p.Open(s.env(where)), nil
}

// errSecretExpired is a saved secret read after its time.
var errSecretExpired = errors.New("expired")

// Resolve reads a saved secret's reference; one past its expiry reads as
// gone even before the sweep deletes it.
func (s *SecretStores) Resolve(ctx context.Context, ref string) (string, error) {
	st, err := s.ForRef(ref)
	if err != nil {
		return "", err
	}
	if err := s.Expired(ref); err != nil {
		return "", err
	}
	return st.Resolve(ctx, ref)
}

// Sweep deletes the saved secrets whose time is up, from their stores and
// the index, and returns them. Each is looked at again with writes held,
// so a replacement saved since is never deleted.
func (s *SecretStores) Sweep(ctx context.Context) []SecretMeta {
	var gone []SecretMeta
	for _, m := range s.Index().All() {
		if !m.expired(s.now()) {
			continue
		}
		s.locked(func() error {
			now, ok := s.Index().Get(m.Ref)
			if !ok || !now.expired(s.now()) {
				return nil
			}
			st, err := s.ForRef(m.Ref)
			if err == nil {
				err = st.Delete(ctx, m.Ref)
			}
			if err != nil && !errors.Is(err, errSecretNotFound) {
				return err
			}
			s.Index().Remove(m.Ref)
			gone = append(gone, now)
			return nil
		})
	}
	return gone
}

// errSecretNotFound is a store with no such secret.
var errSecretNotFound = errors.New("no such secret")

// SecretSettings is where this box saves secrets: a default store, and
// projects of its own. The per-project choices live in each location's
// box-local config (RepoConfig.Secrets), never in the repository's file.
type SecretSettings struct {
	Store      string `json:"store"`
	GCPProject string `json:"gcp_project,omitempty"`
	// Locations are the projects' own choices, by location.
	Locations map[string]SecretStoreChoice `json:"locations,omitempty"`
}

// SecretStoreChoice is a project's choice of store, over the box's.
type SecretStoreChoice struct {
	Store      string `json:"store,omitempty"`
	GCPProject string `json:"gcp_project,omitempty"`
}

func (c SecretStoreChoice) validate() error {
	if c.Store != "" && secretProviderByID(c.Store) == nil {
		return fmt.Errorf("there is no secret store %q", c.Store)
	}
	if c.GCPProject != "" && !gcpProjectID.MatchString(c.GCPProject) {
		return fmt.Errorf("%q is not a GCP project ID", c.GCPProject)
	}
	return nil
}

// whereFor is the place a store id is opened at, from a choice.
func (c SecretStoreChoice) whereFor(id string) string {
	if id == "gcp" {
		return c.GCPProject
	}
	return ""
}

// secretSettingsFile keeps the box's own choice.
func (s *SecretStores) settingsPath() string { return filepath.Join(s.Dir, "secrets", "settings.json") }

// BoxSettings is the box's default store; local unless set.
func (s *SecretStores) BoxSettings() SecretStoreChoice {
	var c SecretStoreChoice
	if b, err := os.ReadFile(s.settingsPath()); err == nil {
		json.Unmarshal(b, &c)
	}
	if c.Store == "" || secretProviderByID(c.Store) == nil {
		c.Store = "local"
	}
	return c
}

// SetBoxSettings keeps the box's default store.
func (s *SecretStores) SetBoxSettings(c SecretStoreChoice) error {
	if err := c.validate(); err != nil {
		return err
	}
	b, _ := json.Marshal(c)
	return statefile.Write(s.settingsPath(), b)
}

// Choose is the store a request saves to: the request's own --store, then
// the project's choice, then the box's default. A GCP project comes the
// same way: the project's, then the box's.
func Choose(request string, project, boxDefault SecretStoreChoice) (id, where string) {
	id = firstNonEmptyStr(request, project.Store, boxDefault.Store, "local")
	where = firstNonEmptyStr(project.whereFor(id), boxDefault.whereFor(id))
	return id, where
}
