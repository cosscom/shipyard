package box

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/wire"
)

// Secret requests: an agent that needs a key asks for it by name (`berthd
// secret request NAME --reason …`, or the berth_secret_request tool), and
// the person types it into a masked card in the app. The value goes from
// the app to the box in one direct call (POST
// /v1/secrets/requests/{id}/save), which the box's own socket can't make,
// into a store (secretstore.go); the agent hears back with a
// <berth-notification> holding a reference, never the value. While a
// request waits its session reads as needing someone, wherever a question
// shows.
//
// A request names nothing secret, so it is kept, announced and listed like
// anything else: the name, the reason, the store. The value is never in a
// request, an event, a log, a hook's data or a reply.

// secretRequestTTL is how long a request waits for an answer.
const secretRequestTTL = time.Hour

// Request outcomes.
const (
	secretPending  = "pending"
	secretSaved    = "saved"
	secretDeclined = "declined"
	secretTimedOut = "timed_out"
)

// secretTTLs are the lifetimes a card offers besides none.
var secretTTLs = map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour}

// SecretRequest is one ask for a secret, as the card shows it.
type SecretRequest struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Reason  string `json:"reason"`
	Session string `json:"session"`
	// Location is the session's project.
	Location string `json:"location,omitempty"`
	// Store is the provider it saves to; StoreLabel where the value goes
	// ("Keychain", "GCP Secret Manager"), Where the place in it (a GCP
	// project).
	Store       string `json:"store"`
	StoreLabel  string `json:"store_label"`
	Where       string `json:"where,omitempty"`
	Environment string `json:"environment,omitempty"`
	Grant       string `json:"grant,omitempty"`
	// TTL is the lifetime the agent suggests; the card preselects it.
	TTL string `json:"ttl,omitempty"`
	// Replace is a request for a new value over one saved before, at
	// ReplacedAt.
	Replace    bool       `json:"replace,omitempty"`
	ReplacedAt *time.Time `json:"replaced_at,omitempty"`
	Created    time.Time  `json:"created"`
	Expires    time.Time  `json:"expires"`
	Status     string     `json:"status"`
	// Ref is what a saved request gives the agent; Reused says it was
	// saved before, and no card was shown.
	Ref    string     `json:"ref,omitempty"`
	Reused bool       `json:"reused,omitempty"`
	Ended  *time.Time `json:"ended,omitempty"`
}

// SecretRequests keeps the requests, pending and lately ended, in one
// private file, so a restart loses none.
type SecretRequests struct {
	Path string
	// Now is the clock; nil is time.Now.
	Now func() time.Time

	mu     sync.Mutex
	loaded bool
	all    []*SecretRequest
}

const keepEndedRequests = 24 * time.Hour

func (s *SecretRequests) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *SecretRequests) load() {
	if s.loaded {
		return
	}
	s.loaded = true
	if s.Path == "" {
		return
	}
	if b, err := os.ReadFile(s.Path); err == nil {
		json.Unmarshal(b, &s.all)
	}
}

func (s *SecretRequests) save() {
	if s.Path == "" {
		return
	}
	now := s.now()
	keep := s.all[:0]
	for _, r := range s.all {
		if r.Ended == nil || now.Sub(*r.Ended) < keepEndedRequests {
			keep = append(keep, r)
		}
	}
	s.all = keep
	if b, err := json.Marshal(s.all); err == nil {
		statefile.Write(s.Path, b)
	}
}

func newSecretRequestID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return "sr_" + hex.EncodeToString(b)
}

// add keeps a new request, or gives back the one already pending for the
// same session and name (made false).
func (s *SecretRequests) add(r SecretRequest) (_ SecretRequest, made bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	for _, o := range s.all {
		if o.Status == secretPending && o.Session == r.Session && o.Name == r.Name {
			return *o, false
		}
	}
	now := s.now()
	r.ID, r.Created, r.Expires, r.Status = newSecretRequestID(), now, now.Add(secretRequestTTL), secretPending
	s.all = append(s.all, &r)
	s.save()
	return r, true
}

// Get is one request.
func (s *SecretRequests) Get(id string) (SecretRequest, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	for _, r := range s.all {
		if r.ID == id {
			return *r, true
		}
	}
	return SecretRequest{}, false
}

// Pending are the requests that wait for an answer, oldest first.
func (s *SecretRequests) Pending() []SecretRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	out := []SecretRequest{}
	for _, r := range s.all {
		if r.Status == secretPending {
			out = append(out, *r)
		}
	}
	return out
}

// ForSession is the request a session waits on, if any.
func (s *SecretRequests) ForSession(name string) *SecretRequest {
	for _, r := range s.Pending() {
		if r.Session == name {
			return &r
		}
	}
	return nil
}

// end settles a pending request; false when it was settled already.
func (s *SecretRequests) end(id, status, ref string) (SecretRequest, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	for _, r := range s.all {
		if r.ID == id {
			if r.Status != secretPending {
				return *r, false
			}
			now := s.now()
			r.Status, r.Ref, r.Ended = status, ref, &now
			s.save()
			return *r, true
		}
	}
	return SecretRequest{}, false
}

// expired are the pending requests whose hour is up.
func (s *SecretRequests) expired() []string {
	now := s.now()
	var ids []string
	for _, r := range s.Pending() {
		if !now.Before(r.Expires) {
			ids = append(ids, r.ID)
		}
	}
	return ids
}

// The secrets API. Requests are made from the box's own socket, by an
// agent session (the caller), and answered from a paired laptop only.
func (b *Box) mountSecrets(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("POST /v1/secrets/requests", b.createSecretRequest)
	route("GET /v1/secrets/requests", b.listSecretRequests)
	route("GET /v1/secrets/requests/{id}", b.getSecretRequest)
	route("POST /v1/secrets/requests/{id}/save", b.saveSecretRequest)
	route("POST /v1/secrets/requests/{id}/decline", b.declineSecretRequest)
	route("GET /v1/secrets", b.listSavedSecrets)
	route("POST /v1/secrets/delete", b.deleteSavedSecret)
	route("GET /v1/secrets/settings", b.getSecretSettings)
	route("PUT /v1/secrets/settings", b.putSecretSettings)
}

// fromLaptop refuses what only a person, in the app, may do.
func fromLaptop(r *http.Request, what string) error {
	if wire.IsLocal(r.Context()) {
		return httpError{http.StatusForbidden, what + " from the Shipyard app on a paired laptop, not from the box's own socket"}
	}
	return nil
}

func (b *Box) secretStores() (*SecretStores, error) {
	if b.SecretRequests == nil || b.secrets().Stores == nil {
		return nil, httpError{http.StatusNotImplemented, "this box keeps no secrets"}
	}
	return b.secrets().Stores, nil
}

// SecretRequestBody is what an agent asks with.
type SecretRequestBody struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
	// New asks for a value even when one is saved: a replacement.
	New         bool   `json:"new,omitempty"`
	Store       string `json:"store,omitempty"`
	Environment string `json:"environment,omitempty"`
	Grant       string `json:"grant,omitempty"`
	TTL         string `json:"ttl,omitempty"`
}

// projectChoice is a location's own choice of store, from its box-local
// config.
func (b *Box) projectChoice(location string) SecretStoreChoice {
	if location == "" || b.Locations == nil {
		return SecretStoreChoice{}
	}
	saved, err := b.Locations.saved(location)
	if err != nil || saved.Config == nil || saved.Config.Secrets == nil {
		return SecretStoreChoice{}
	}
	return *saved.Config.Secrets
}

func (b *Box) createSecretRequest(w http.ResponseWriter, r *http.Request) error {
	if !wire.IsLocal(r.Context()) {
		return httpError{http.StatusForbidden, "secrets are requested by agents on the box, through its own socket"}
	}
	stores, err := b.secretStores()
	if err != nil {
		return err
	}
	caller := strings.TrimSpace(r.Header.Get(CallerHeader))
	if caller == "" || !sessionName.MatchString(caller) {
		return badRequest("a secret is requested by an agent session: run it in one (BERTH_SESSION names it)")
	}
	sess, err := b.Sessions.Get(r.Context(), caller)
	if err != nil || sess.Exited || agentFor(sess) == "" {
		return badRequest("%s is not an agent session on this box", caller)
	}
	var req SecretRequestBody
	if err := decode(r, &req); err != nil {
		return err
	}
	req.Name, req.Reason = strings.TrimSpace(req.Name), strings.TrimSpace(req.Reason)
	switch {
	case !secretName.MatchString(req.Name):
		return badRequest("%q is not a secret name: use an environment variable's, like ACME_TOKEN", req.Name)
	case req.Reason == "":
		return badRequest("say why the secret is needed (--reason): the person reads it on the card")
	case utf8.RuneCountInString(req.Reason) > 500:
		return badRequest("the reason is longer than 500 characters")
	case req.Environment != "" && req.Environment != "staging" && req.Environment != "production":
		return badRequest("the environment is staging or production")
	}
	if req.TTL != "" {
		if _, ok := secretTTLs[req.TTL]; !ok {
			return badRequest("the ttl is 1h, 24h or 7d (or none: kept until deleted)")
		}
		if req.Environment == "production" {
			return badRequest("a production secret doesn't expire: leave out the ttl")
		}
	}
	id, where := Choose(req.Store, b.projectChoice(sess.Location), stores.BoxSettings())
	st, err := stores.Open(id, where)
	if err != nil {
		return badRequest("%v", err)
	}
	if req.Grant != "" {
		if !secretProviderByID(id).Caps.Grant {
			return badRequest("the %s store can't grant access: --grant is for gcp", id)
		}
		if err := ValidateServiceAccount(req.Grant); err != nil {
			return badRequest("%v", err)
		}
	}
	// One saved and unexpired is given at once, with no card.
	var prev *SecretMeta
	now := time.Now()
	for _, m := range stores.Index().All() {
		if m.Name == req.Name && m.Store == id && m.Where == where && !m.expired(now) {
			m := m
			prev = &m
		}
	}
	if prev != nil && !req.New {
		writeJSON(w, SecretRequest{Name: req.Name, Session: caller, Store: id, StoreLabel: prev.StoreLabel, Where: where, Status: secretSaved, Ref: prev.Ref, Reused: true})
		return nil
	}
	sr := SecretRequest{Name: req.Name, Reason: req.Reason, Session: caller, Location: sess.Location, Store: id, StoreLabel: st.Label(), Where: where, Environment: req.Environment, Grant: req.Grant, TTL: req.TTL, Replace: req.New && prev != nil}
	if sr.Replace {
		created := prev.Created
		sr.ReplacedAt = &created
	}
	sr, made := b.SecretRequests.add(sr)
	if made {
		b.publish(r, "secret.requested", map[string]any{"id": sr.ID, "session": sr.Session, "name": sr.Name, "location": sr.Location, "reason": sr.Reason})
	}
	writeJSON(w, sr)
	return nil
}

func (b *Box) listSecretRequests(w http.ResponseWriter, r *http.Request) error {
	if b.SecretRequests == nil {
		writeJSON(w, []SecretRequest{})
		return nil
	}
	writeJSON(w, b.SecretRequests.Pending())
	return nil
}

func (b *Box) getSecretRequest(w http.ResponseWriter, r *http.Request) error {
	if b.SecretRequests == nil {
		return httpError{http.StatusNotImplemented, "this box keeps no secrets"}
	}
	sr, ok := b.SecretRequests.Get(r.PathValue("id"))
	if !ok {
		return httpError{http.StatusNotFound, "no such secret request"}
	}
	writeJSON(w, sr)
	return nil
}

// maxSecretValue bounds a saved value: a key, a token, a small JSON
// credential.
const maxSecretValue = 32 << 10

func (b *Box) saveSecretRequest(w http.ResponseWriter, r *http.Request) error {
	if err := fromLaptop(r, "a secret is saved"); err != nil {
		return err
	}
	stores, err := b.secretStores()
	if err != nil {
		return err
	}
	var req struct {
		Value   string `json:"value"`
		Expires string `json:"expires"`
	}
	if err := decodeLimit(r, &req, maxSecretValue+4<<10); err != nil {
		return err
	}
	// Not echoed, ever: errors say what is wrong with it, not what it is.
	value := strings.TrimRight(req.Value, "\r\n")
	switch {
	case value == "":
		return badRequest("type or paste the value first")
	case len(value) > maxSecretValue:
		return badRequest("the value is longer than %d KB", maxSecretValue>>10)
	case strings.ContainsRune(value, 0):
		return badRequest("the value holds a NUL character; copy it again")
	}
	sr, ok := b.SecretRequests.Get(r.PathValue("id"))
	if !ok {
		return httpError{http.StatusNotFound, "no such secret request"}
	}
	if sr.Status != secretPending {
		return httpError{http.StatusConflict, "this request is " + strings.ReplaceAll(sr.Status, "_", " ") + " already"}
	}
	var expires *time.Time
	if req.Expires != "" && sr.Environment != "production" {
		d, ok := secretTTLs[req.Expires]
		if !ok {
			return badRequest("expires is 1h, 24h, 7d or none")
		}
		if !secretProviderByID(sr.Store).Caps.Expiry {
			return badRequest("the %s store keeps secrets until they're deleted", sr.Store)
		}
		t := time.Now().UTC().Add(d)
		expires = &t
	}
	st, err := stores.Open(sr.Store, sr.Where)
	if err != nil {
		return badRequest("%v", err)
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	ref, err := st.Save(ctx, SecretSave{Name: sr.Name, Value: value, Environment: sr.Environment, Location: sr.Location, Grant: sr.Grant})
	value, req.Value = "", ""
	if err != nil {
		return httpError{http.StatusBadGateway, err.Error()}
	}
	meta := SecretMeta{Name: sr.Name, Ref: ref, Store: sr.Store, StoreLabel: st.Label(), Where: sr.Where, Environment: sr.Environment, Created: time.Now().UTC(), Expires: expires, Session: sr.Session, Reason: sr.Reason, Location: sr.Location}
	if d, ok := st.(interface{ Detail(string) (string, string) }); ok {
		if backend, label := d.Detail(ref); label != "" {
			meta.Backend, meta.StoreLabel = backend, label
		}
	}
	if err := stores.Index().Put(meta); err != nil {
		return err
	}
	b.secrets().Forget(ref)
	b.endSecretRequest(r, sr.ID, secretSaved, ref)
	b.publish(r, "secret.saved", map[string]any{"name": sr.Name, "store": sr.Store, "where": sr.Where})
	writeJSON(w, map[string]string{"ref": ref})
	return nil
}

func (b *Box) declineSecretRequest(w http.ResponseWriter, r *http.Request) error {
	if err := fromLaptop(r, "a secret request is declined"); err != nil {
		return err
	}
	if b.SecretRequests == nil {
		return httpError{http.StatusNotImplemented, "this box keeps no secrets"}
	}
	sr, ok := b.SecretRequests.Get(r.PathValue("id"))
	if !ok {
		return httpError{http.StatusNotFound, "no such secret request"}
	}
	if sr.Status != secretPending {
		return httpError{http.StatusConflict, "this request is " + strings.ReplaceAll(sr.Status, "_", " ") + " already"}
	}
	b.endSecretRequest(r, sr.ID, secretDeclined, "")
	writeJSON(w, map[string]bool{"ok": true})
	return nil
}

// endSecretRequest settles a request, says so, and tells its session.
func (b *Box) endSecretRequest(r *http.Request, id, status, ref string) {
	sr, ok := b.SecretRequests.end(id, status, ref)
	if !ok {
		return
	}
	data := map[string]any{"id": sr.ID, "session": sr.Session, "name": sr.Name, "status": status}
	if b.Events != nil {
		e := events.Event{Type: "secret.request.ended", Box: b.Name, Data: data}
		if r != nil {
			e.Origin = origin(r)
		}
		b.Events.Publish(e)
	}
	if b.Reports != nil {
		b.Reports.Tell(Report{Key: "secret:" + sr.ID, Parent: sr.Session, Kind: "secret", At: time.Now().UTC(), Status: status, Title: sr.Name, Ref: ref, Session: ""})
	}
}

// SweepSecrets times out the requests nobody answered and deletes the
// saved secrets whose time is up.
func (b *Box) SweepSecrets(ctx context.Context) {
	if b.SecretRequests == nil {
		return
	}
	for _, id := range b.SecretRequests.expired() {
		b.endSecretRequest(nil, id, secretTimedOut, "")
	}
	if st := b.secrets().Stores; st != nil {
		for _, name := range st.Sweep(ctx) {
			if b.Events != nil {
				b.Events.Publish(events.Event{Type: "secret.deleted", Box: b.Name, Data: map[string]any{"name": name, "expired": true}})
			}
		}
	}
}

// RunSecretSweeps sweeps every minute until ctx ends.
func (b *Box) RunSecretSweeps(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		b.SweepSecrets(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// StoreInfo is one provider, as Settings offers it.
type StoreInfo struct {
	ID    string    `json:"id"`
	Label string    `json:"label"`
	Caps  StoreCaps `json:"caps"`
}

// SavedSecrets is what Settings → Secrets lists.
type SavedSecrets struct {
	Secrets  []SecretMeta     `json:"secrets"`
	Stores   []StoreInfo      `json:"stores"`
	Settings SecretSettings   `json:"settings"`
	Errors   []SecretStoreErr `json:"errors,omitempty"`
}

// SecretStoreErr is a store that couldn't be listed.
type SecretStoreErr struct {
	Store string `json:"store"`
	Where string `json:"where,omitempty"`
	Error string `json:"error"`
}

func (b *Box) secretSettings() SecretSettings {
	stores := b.secrets().Stores
	def := stores.BoxSettings()
	out := SecretSettings{Store: def.Store, GCPProject: def.GCPProject, Locations: map[string]SecretStoreChoice{}}
	if b.Locations != nil {
		if all, err := b.Locations.read(); err == nil {
			for _, l := range all {
				if l.Config != nil && l.Config.Secrets != nil {
					out.Locations[l.Name] = *l.Config.Secrets
				}
			}
		}
	}
	return out
}

// storePlaces are the stores and places Settings lists: every provider at
// each place the box or a project names for it.
func storePlaces(set SecretSettings) [][2]string {
	seen := map[[2]string]bool{}
	var out [][2]string
	add := func(id string, c SecretStoreChoice) {
		p := secretProviderByID(id)
		if p == nil {
			return
		}
		where := c.whereFor(id)
		if p.NeedsWhere && where == "" {
			return
		}
		k := [2]string{id, where}
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	boxDefault := SecretStoreChoice{Store: set.Store, GCPProject: set.GCPProject}
	for _, id := range secretProviderIDs() {
		add(id, boxDefault)
		names := make([]string, 0, len(set.Locations))
		for n := range set.Locations {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			c := set.Locations[n]
			if c.GCPProject == "" {
				c.GCPProject = set.GCPProject
			}
			add(id, c)
		}
	}
	return out
}

func (b *Box) listSavedSecrets(w http.ResponseWriter, r *http.Request) error {
	stores, err := b.secretStores()
	if err != nil {
		return err
	}
	set := b.secretSettings()
	out := SavedSecrets{Secrets: []SecretMeta{}, Settings: set}
	for _, id := range secretProviderIDs() {
		p := secretProviderByID(id)
		out.Stores = append(out.Stores, StoreInfo{ID: id, Label: p.Name, Caps: p.Caps})
	}
	index := map[string]SecretMeta{}
	for _, m := range stores.Index().All() {
		index[m.Ref] = m
	}
	listed := map[string]bool{}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	for _, pl := range storePlaces(set) {
		st, err := stores.Open(pl[0], pl[1])
		var metas []SecretMeta
		if err == nil {
			metas, err = st.List(ctx)
		}
		if err != nil {
			out.Errors = append(out.Errors, SecretStoreErr{Store: pl[0], Where: pl[1], Error: err.Error()})
			// What the box saved there still shows, from its own record.
			for _, m := range index {
				if m.Store == pl[0] && m.Where == pl[1] && !listed[m.Ref] {
					listed[m.Ref] = true
					out.Secrets = append(out.Secrets, m)
				}
			}
			continue
		}
		for _, m := range metas {
			if listed[m.Ref] {
				continue
			}
			listed[m.Ref] = true
			if x, ok := index[m.Ref]; ok {
				x.StoreLabel = firstNonEmptyStr(m.StoreLabel, x.StoreLabel)
				m = x
			}
			out.Secrets = append(out.Secrets, m)
		}
	}
	sort.Slice(out.Secrets, func(i, j int) bool {
		if out.Secrets[i].Name != out.Secrets[j].Name {
			return out.Secrets[i].Name < out.Secrets[j].Name
		}
		return out.Secrets[i].Ref < out.Secrets[j].Ref
	})
	writeJSON(w, out)
	return nil
}

func (b *Box) deleteSavedSecret(w http.ResponseWriter, r *http.Request) error {
	if err := fromLaptop(r, "a secret is deleted"); err != nil {
		return err
	}
	stores, err := b.secretStores()
	if err != nil {
		return err
	}
	var req struct {
		Ref     string `json:"ref"`
		Confirm string `json:"confirm"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	st, err := stores.ForRef(req.Ref)
	if err != nil {
		return badRequest("%v", err)
	}
	meta, known := stores.Index().Get(req.Ref)
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	if !known {
		metas, err := st.List(ctx)
		if err != nil {
			return httpError{http.StatusBadGateway, err.Error()}
		}
		for _, m := range metas {
			if m.Ref == req.Ref {
				meta, known = m, true
			}
		}
	}
	if !known {
		return httpError{http.StatusNotFound, "no such saved secret"}
	}
	if meta.Environment == "production" && req.Confirm != meta.Name {
		return badRequest("%s is a production secret: type its name to delete it", meta.Name)
	}
	if err := st.Delete(ctx, req.Ref); err != nil && !errors.Is(err, errSecretNotFound) {
		return httpError{http.StatusBadGateway, err.Error()}
	}
	if err := stores.Index().Remove(req.Ref); err != nil {
		return err
	}
	b.secrets().Forget(req.Ref)
	b.publish(r, "secret.deleted", map[string]any{"name": meta.Name, "store": meta.Store, "where": meta.Where})
	writeJSON(w, map[string]bool{"ok": true})
	return nil
}

func (b *Box) getSecretSettings(w http.ResponseWriter, r *http.Request) error {
	if _, err := b.secretStores(); err != nil {
		return err
	}
	writeJSON(w, b.secretSettings())
	return nil
}

func (b *Box) putSecretSettings(w http.ResponseWriter, r *http.Request) error {
	if err := fromLaptop(r, "where secrets are saved is set"); err != nil {
		return err
	}
	stores, err := b.secretStores()
	if err != nil {
		return err
	}
	var req SecretSettings
	if err := decode(r, &req); err != nil {
		return err
	}
	boxChoice := SecretStoreChoice{Store: firstNonEmptyStr(req.Store, "local"), GCPProject: strings.TrimSpace(req.GCPProject)}
	if err := boxChoice.validate(); err != nil {
		return badRequest("%v", err)
	}
	for name, c := range req.Locations {
		if err := c.validate(); err != nil {
			return badRequest("%s: %v", name, err)
		}
	}
	if err := stores.SetBoxSettings(boxChoice); err != nil {
		return err
	}
	for name, c := range req.Locations {
		cfg, err := b.Locations.Config(r.Context(), name)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		local := cfg.Local
		if c.Store == "" && c.GCPProject == "" {
			local.Secrets = nil
		} else {
			cc := c
			local.Secrets = &cc
		}
		if err := b.Locations.SetLocalConfig(name, local); err != nil {
			return badRequest("%s: %v", name, err)
		}
	}
	b.publish(r, "secret.settings.changed", map[string]any{})
	writeJSON(w, b.secretSettings())
	return nil
}
