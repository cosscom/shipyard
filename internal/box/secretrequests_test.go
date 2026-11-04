package box

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/wire"
)

// secretBed is a box with an agent session, lead, in location acme, served
// to a paired laptop (remote) and on its own socket (local, as lead).
type secretBed struct {
	bx     *Box
	remote *wire.Client
	local  *Client
	state  string
	agent  string
	clock  *time.Time
	mu     sync.Mutex
	seen   []events.Event
}

func newSecretBed(t *testing.T, bins map[string]string) *secretBed {
	t.Helper()
	sb := &secretBed{state: t.TempDir()}
	now := time.Now().UTC()
	sb.clock = &now
	ledger := &Turns{}
	c, bus := servedBox(t, func(b *Box) {
		b.Turns = ledger
		b.Reports = &Notifier{Path: filepath.Join(sb.state, "notify.json")}
		b.SecretRequests = &SecretRequests{Path: filepath.Join(sb.state, "secret-requests.json"), Now: func() time.Time { return *sb.clock }}
		b.Secrets = &Secrets{Stores: &SecretStores{Dir: sb.state, Box: "devbox", Bins: bins}}
		sb.bx = b
	})
	ledger.Attach(bus)
	sb.remote = c
	stop := bus.Observe(func(e events.Event) {
		sb.mu.Lock()
		sb.seen = append(sb.seen, e)
		sb.mu.Unlock()
	})
	t.Cleanup(stop)
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "acme", "path": repo}, nil)
	bin := t.TempDir()
	fake := filepath.Join(bin, "claude")
	os.WriteFile(fake, []byte("#!/bin/sh\nexec cat\n"), 0o755)
	sb.agent = fake
	for _, name := range []string{"lead", "shell"} {
		cmd := fake
		if name == "shell" {
			cmd = "sleep 300"
		}
		if status := call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "acme", "name": name, "command": cmd}, nil); status != 200 {
			t.Fatalf("start %s: %d", name, status)
		}
		t.Cleanup(func() { sb.bx.Sessions.Kill(context.Background(), name) })
	}
	sockDir, err := os.MkdirTemp("/tmp", "bsr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "berthd.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &wire.Server{}
	sb.bx.Mount(srv)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go srv.ServeLocal(ctx, ln)
	sb.local = NewClient(NewLocal(sock)).WithCaller("lead")
	return sb
}

func (sb *secretBed) events() string {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	b, _ := json.Marshal(sb.seen)
	return string(b)
}

func (sb *secretBed) eventTypes() []string {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	var out []string
	for _, e := range sb.seen {
		if strings.HasPrefix(e.Type, "secret.") {
			out = append(out, e.Type)
		}
	}
	return out
}

func (sb *secretBed) pendingReports(parent string) []Report {
	n := sb.bx.Reports
	n.mu.Lock()
	defer n.mu.Unlock()
	n.load()
	return append([]Report(nil), n.st.Pending[parent]...)
}

func (sb *secretBed) session(t *testing.T, name string) Session {
	t.Helper()
	var all []Session
	call(t, sb.remote, "GET", "/v1/sessions", "", nil, &all)
	for _, s := range all {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("no session %s", name)
	return Session{}
}

// grepState says which files under dir hold s.
func grepState(dir, s string) []string {
	var hits []string
	filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			if b, _ := os.ReadFile(p); strings.Contains(string(b), s) {
				hits = append(hits, p)
			}
		}
		return nil
	})
	return hits
}

func TestASecretIsAskedForOnTheBoxAndSavedFromTheLaptopOnly(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	sb := newSecretBed(t, noKeyrings)
	ctx := context.Background()
	const sentinel = "acme-sentinel-c0ffee-91"

	// Requests come from the box's own socket, from an agent session.
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests", "", SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy"}, nil); status != 403 {
		t.Fatalf("a laptop made a request: %d", status)
	}
	anon := NewClient(sb.local.Doer)
	if _, err := anon.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy"}); err == nil {
		t.Fatal("a request with no session was taken")
	}
	if _, err := sb.local.WithCaller("shell").RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy"}); err == nil {
		t.Fatal("a plain terminal made a request")
	}
	for _, bad := range []SecretRequestBody{{Name: "acme_token", Reason: "x"}, {Name: "ACME_TOKEN"}, {Name: "ACME_TOKEN", Reason: "x", TTL: "3d"}, {Name: "ACME_TOKEN", Reason: "x", Environment: "production", TTL: "1h"}, {Name: "ACME_TOKEN", Reason: "x", Grant: "ci@acme.iam.gserviceaccount.com"}} {
		if _, err := sb.local.RequestSecret(ctx, bad); err == nil {
			t.Errorf("%+v was taken", bad)
		}
	}

	sr, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "Deploy the acme \"staging\" app", TTL: "24h"})
	if err != nil {
		t.Fatal(err)
	}
	if sr.Status != "pending" || sr.ID == "" || sr.Session != "lead" || sr.Location != "acme" || sr.Store != "local" || sr.StoreLabel != "Encrypted file" || sr.TTL != "24h" || sr.Replace {
		t.Fatalf("request = %+v", sr)
	}
	// Asking again while it waits gives the same request.
	if again, _ := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "again"}); again.ID != sr.ID {
		t.Fatalf("a second ask made %s", again.ID)
	}
	// The session reads as needing someone, and still takes prompts.
	s := sb.session(t, "lead")
	if s.AgentState != "waiting" || !s.SoftWait || s.Ask == nil || s.Ask.Tool != "SecretRequest" || s.SecretRequest == nil || s.SecretRequest.ID != sr.ID || s.SecretRequest.Reason != `Deploy the acme "staging" app` {
		t.Fatalf("session = %+v ask %+v request %+v", s.AgentState, s.Ask, s.SecretRequest)
	}
	var pending []SecretRequest
	call(t, sb.remote, "GET", "/v1/secrets/requests", "", nil, &pending)
	if len(pending) != 1 || pending[0].ID != sr.ID {
		t.Fatalf("pending = %+v", pending)
	}

	// The box's own socket can neither save, decline nor delete.
	for _, path := range []string{"/v1/secrets/requests/" + sr.ID + "/save", "/v1/secrets/requests/" + sr.ID + "/decline", "/v1/secrets/delete"} {
		err := sb.local.Call(ctx, http.MethodPost, path, map[string]string{"value": sentinel, "ref": "box://ACME_TOKEN"}, nil)
		if err == nil || !strings.Contains(err.Error(), "paired laptop") {
			t.Errorf("POST %s from the box: %v", path, err)
		}
	}
	if err := sb.local.Call(ctx, http.MethodPut, "/v1/secrets/settings", SecretSettings{Store: "local"}, nil); err == nil {
		t.Error("the box's own socket set where secrets go")
	}

	// The laptop saves it.
	var saved map[string]string
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": sentinel + "\n", "expires": "24h"}, &saved); status != 200 || saved["ref"] != "box://ACME_TOKEN" {
		t.Fatalf("save: %d %v", status, saved)
	}
	if v, err := sb.bx.secrets().Resolve(ctx, "box://ACME_TOKEN", nil, true); err != nil || v != sentinel {
		t.Fatalf("resolve: %q %v", v, err)
	}
	if again := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "x"}, nil); again != 409 {
		t.Fatalf("a second save: %d", again)
	}
	got, _ := sb.local.SecretRequest(ctx, sr.ID)
	if got.Status != "saved" || got.Ref != "box://ACME_TOKEN" {
		t.Fatalf("after save: %+v", got)
	}
	if s := sb.session(t, "lead"); s.SecretRequest != nil || s.Ask != nil && s.Ask.Tool == "SecretRequest" {
		t.Fatalf("still waiting: %+v", s.SecretRequest)
	}
	reps := sb.pendingReports("lead")
	if len(reps) != 1 || reps[0].Kind != "secret" || reps[0].Status != "saved" || reps[0].Ref != "box://ACME_TOKEN" {
		t.Fatalf("reports = %+v", reps)
	}
	text := NotificationText(reps, 0)
	if !strings.Contains(text, "box://ACME_TOKEN") || !strings.Contains(text, "berthd secret exec --env ACME_TOKEN=box://ACME_TOKEN") || strings.Contains(text, sentinel) {
		t.Fatalf("notification:\n%s", text)
	}
	var list SavedSecrets
	call(t, sb.remote, "GET", "/v1/secrets", "", nil, &list)
	if len(list.Secrets) != 1 || list.Secrets[0].Name != "ACME_TOKEN" || list.Secrets[0].Session != "lead" || list.Secrets[0].Reason == "" || list.Secrets[0].StoreLabel != "Encrypted file" || list.Secrets[0].Expires == nil {
		t.Fatalf("list = %+v", list)
	}

	// Saved and unexpired: given at once, with no card.
	again, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy again"})
	if err != nil || again.Status != "saved" || !again.Reused || again.Ref != "box://ACME_TOKEN" || again.ID != "" {
		t.Fatalf("reuse: %+v %v", again, err)
	}
	if len(sb.bx.SecretRequests.Pending()) != 0 {
		t.Fatal("reuse made a pending request")
	}
	// --new asks for a replacement, saying when the old one was saved.
	repl, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "rotate", New: true})
	if err != nil || repl.Status != "pending" || !repl.Replace || repl.ReplacedAt == nil {
		t.Fatalf("--new: %+v %v", repl, err)
	}
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+repl.ID+"/decline", "app", nil, nil); status != 200 {
		t.Fatalf("decline: %d", status)
	}
	if reps := sb.pendingReports("lead"); len(reps) != 2 || reps[1].Status != "declined" || !strings.Contains(NotificationText(reps[1:], 0), "declined") {
		t.Fatalf("reports after decline = %+v", reps)
	}

	// Deleting it from the laptop.
	if status := call(t, sb.remote, "POST", "/v1/secrets/delete", "app", map[string]string{"ref": "box://ACME_TOKEN"}, nil); status != 200 {
		t.Fatalf("delete: %d", status)
	}
	if _, err := sb.bx.secrets().Resolve(ctx, "box://ACME_TOKEN", nil, true); err == nil {
		t.Fatal("a deleted secret resolved")
	}

	// The value is nowhere but the encrypted store: no event, no state
	// file, no reply.
	if strings.Contains(sb.events(), sentinel) {
		t.Fatal("an event holds the value")
	}
	if hits := grepState(sb.state, sentinel); len(hits) > 0 {
		t.Fatalf("state files hold the value: %v", hits)
	}
	want := []string{"secret.requested", "secret.request.ended", "secret.saved", "secret.requested", "secret.request.ended", "secret.deleted"}
	if got := sb.eventTypes(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("events %v, want %v", got, want)
	}
}

func TestAProductionSecretNeedsItsNameTypedToDelete(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	sb := newSecretBed(t, noKeyrings)
	ctx := context.Background()
	sr, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_PROD_KEY", Reason: "release", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	// A production secret never expires, whatever the card sent.
	call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "prod-v", "expires": "1h"}, nil)
	m, ok := sb.bx.secrets().Stores.Index().Get("box://ACME_PROD_KEY")
	if !ok || m.Expires != nil || m.Environment != "production" {
		t.Fatalf("meta %+v", m)
	}
	if status := call(t, sb.remote, "POST", "/v1/secrets/delete", "app", map[string]string{"ref": "box://ACME_PROD_KEY", "confirm": "acme_prod_key"}, nil); status != 400 {
		t.Fatalf("delete without the name: %d", status)
	}
	if status := call(t, sb.remote, "POST", "/v1/secrets/delete", "app", map[string]string{"ref": "box://ACME_PROD_KEY", "confirm": "ACME_PROD_KEY"}, nil); status != 200 {
		t.Fatalf("delete with the name: %d", status)
	}
}

func TestAnUnansweredSecretRequestTimesOutAfterAnHour(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	sb := newSecretBed(t, noKeyrings)
	ctx := context.Background()
	sr, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	*sb.clock = sb.clock.Add(59 * time.Minute)
	sb.bx.SweepSecrets(ctx)
	if got, _ := sb.local.SecretRequest(ctx, sr.ID); got.Status != "pending" {
		t.Fatalf("at 59 minutes: %s", got.Status)
	}
	*sb.clock = sb.clock.Add(2 * time.Minute)
	sb.bx.SweepSecrets(ctx)
	if got, _ := sb.local.SecretRequest(ctx, sr.ID); got.Status != "timed_out" {
		t.Fatalf("at 61 minutes: %s", got.Status)
	}
	reps := sb.pendingReports("lead")
	if len(reps) != 1 || reps[0].Status != "timed_out" || !strings.Contains(NotificationText(reps, 0), "Nobody answered") {
		t.Fatalf("reports %+v", reps)
	}
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "late"}, nil); status != 409 {
		t.Fatalf("a save after the timeout: %d", status)
	}
}

func TestTheSessionHearsBackInItsOwnTerminal(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	sb := newSecretBed(t, noKeyrings)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sb.bx.Reports.Run(ctx, sb.bx)
	sr, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "typed-sentinel-55"}, nil)
	deadline := time.Now().Add(15 * time.Second)
	for {
		screen, _ := sb.bx.Sessions.Screen(ctx, "lead", 200)
		flat := strings.ReplaceAll(screen, "\n", "")
		if strings.Contains(flat, "</berth-notification>") {
			if !strings.Contains(flat, `kind="secret"`) || !strings.Contains(flat, `ref="box://ACME_TOKEN"`) || strings.Contains(flat, "typed-sentinel-55") {
				t.Fatalf("the notification:\n%s", screen)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("lead was never told:\n%s", screen)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// acmeVault is a third provider, made in this file alone: requests,
// resolution, listing and delete reach it with nothing else changed.
type acmeVault struct {
	mu     sync.Mutex
	values map[string]string
}

var theAcmeVault = &acmeVault{values: map[string]string{}}

type acmeVaultStore struct{ where string }

func (acmeVaultStore) Label() string { return "Acme Vault" }

func (a acmeVaultStore) Save(ctx context.Context, s SecretSave) (string, error) {
	theAcmeVault.mu.Lock()
	defer theAcmeVault.mu.Unlock()
	theAcmeVault.values[a.where+"/"+s.Name] = s.Value
	return "acmevault://" + a.where + "/" + s.Name, nil
}

func (a acmeVaultStore) Resolve(ctx context.Context, ref string) (string, error) {
	theAcmeVault.mu.Lock()
	defer theAcmeVault.mu.Unlock()
	v, ok := theAcmeVault.values[strings.TrimPrefix(ref, "acmevault://")]
	if !ok {
		return "", errSecretNotFound
	}
	return v, nil
}

func (a acmeVaultStore) List(ctx context.Context) ([]SecretMeta, error) {
	theAcmeVault.mu.Lock()
	defer theAcmeVault.mu.Unlock()
	var out []SecretMeta
	for k := range theAcmeVault.values {
		team, name, _ := strings.Cut(k, "/")
		if team == a.where {
			out = append(out, SecretMeta{Name: name, Ref: "acmevault://" + k, Store: "acmevault", StoreLabel: "Acme Vault", Where: team})
		}
	}
	return out, nil
}

func (a acmeVaultStore) Delete(ctx context.Context, ref string) error {
	theAcmeVault.mu.Lock()
	defer theAcmeVault.mu.Unlock()
	delete(theAcmeVault.values, strings.TrimPrefix(ref, "acmevault://"))
	return nil
}

func registerAcmeVault(t *testing.T) {
	registerSecretStore(&secretProvider{
		ID: "acmevault", Scheme: "acmevault", Name: "Acme Vault",
		ValidateRef: func(ref string) error {
			if !strings.HasPrefix(ref, "acmevault://") {
				return errors.New("not an acme vault reference")
			}
			return nil
		},
		WhereOf: func(ref string) string { team, _, _ := strings.Cut(strings.TrimPrefix(ref, "acmevault://"), "/"); return team },
		Open:    func(env StoreEnv) SecretStore { return acmeVaultStore{where: firstNonEmptyStr(env.Where, "acme")} },
	})
	t.Cleanup(func() {
		secretProvidersMu.Lock()
		delete(secretProviders, "acmevault")
		secretProvidersMu.Unlock()
	})
}

func TestAThirdProviderPlugsInFromItsOwnFile(t *testing.T) {
	registerAcmeVault(t)
	sb := newSecretBed(t, noKeyrings)
	ctx := context.Background()
	if !IsSecretRef("acmevault://acme/ACME_TOKEN") {
		t.Fatal("its references aren't references")
	}
	// The project's choice sends requests there.
	if status := call(t, sb.remote, "PUT", "/v1/secrets/settings", "app", SecretSettings{Store: "local", Locations: map[string]SecretStoreChoice{"acme": {Store: "acmevault"}}}, nil); status != 200 {
		t.Fatalf("settings: %d", status)
	}
	sr, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy"})
	if err != nil || sr.Store != "acmevault" || sr.StoreLabel != "Acme Vault" {
		t.Fatalf("request %+v %v", sr, err)
	}
	var saved map[string]string
	call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "vault-v"}, &saved)
	if saved["ref"] != "acmevault://acme/ACME_TOKEN" {
		t.Fatalf("saved %v", saved)
	}
	if v, err := sb.bx.secrets().Resolve(ctx, saved["ref"], nil, true); err != nil || v != "vault-v" {
		t.Fatalf("resolve %q %v", v, err)
	}
	var list SavedSecrets
	call(t, sb.remote, "GET", "/v1/secrets", "", nil, &list)
	found := false
	for _, m := range list.Secrets {
		found = found || (m.Ref == saved["ref"] && m.Session == "lead")
	}
	hasStore := false
	for _, s := range list.Stores {
		hasStore = hasStore || s.ID == "acmevault"
	}
	if !found || !hasStore || list.Settings.Locations["acme"].Store != "acmevault" {
		t.Fatalf("list %+v", list)
	}
	// The request's own --store wins over the project's.
	local, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "OTHER_TOKEN", Reason: "x", Store: "local"})
	if err != nil || local.Store != "local" {
		t.Fatalf("--store local: %+v %v", local, err)
	}
	if status := call(t, sb.remote, "POST", "/v1/secrets/delete", "app", map[string]string{"ref": saved["ref"]}, nil); status != 200 {
		t.Fatalf("delete %d", status)
	}
	if _, err := sb.bx.secrets().Resolve(ctx, saved["ref"], nil, true); err == nil {
		t.Fatal("still there")
	}
	// The project's override sits in the box's own config for it, never
	// the repository's file.
	cfg, _ := sb.bx.Locations.Config(ctx, "acme")
	if cfg.Local.Secrets == nil || cfg.Local.Secrets.Store != "acmevault" || (cfg.Repo != nil && cfg.Repo.Secrets != nil) {
		t.Fatalf("config %+v", cfg.Local.Secrets)
	}
}

func TestASaveInProgressCantBeDeclinedOrTimedOut(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	sb := newSecretBed(t, noKeyrings)
	ctx := context.Background()
	sr, err := sb.local.RequestSecret(ctx, SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	// A save has claimed it and is writing the value.
	if _, err := sb.bx.SecretRequests.claim(sr.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := sb.bx.SecretRequests.claim(sr.ID); err == nil {
		t.Fatal("a second save claimed it too")
	}
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/decline", "app", nil, nil); status != 409 {
		t.Fatalf("a decline during the save: %d", status)
	}
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "other"}, nil); status != 409 {
		t.Fatalf("a second save during the first: %d", status)
	}
	*sb.clock = sb.clock.Add(2 * time.Hour)
	sb.bx.SweepSecrets(ctx)
	if got, _ := sb.local.SecretRequest(ctx, sr.ID); got.Status != "pending" {
		t.Fatalf("the sweep settled a request being saved: %s", got.Status)
	}
	// The save failed and let it go: now the person can decline.
	sb.bx.SecretRequests.release(sr.ID)
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/decline", "app", nil, nil); status != 200 {
		t.Fatalf("a decline after: %d", status)
	}
	if len(sb.pendingReports("lead")) != 1 {
		t.Fatalf("reports %+v", sb.pendingReports("lead"))
	}
}

func TestOnlyTheAppSetsWhereAProjectsSecretsGo(t *testing.T) {
	sb := newSecretBed(t, noKeyrings)
	ctx := context.Background()
	if status := call(t, sb.remote, "PUT", "/v1/secrets/settings", "app", SecretSettings{Store: "local", Locations: map[string]SecretStoreChoice{"acme": {Store: "gcp", GCPProject: "acme-staging"}}}, nil); status != 200 {
		t.Fatalf("settings: %d", status)
	}
	choice := func() *SecretStoreChoice {
		cfg, _ := sb.bx.Locations.Config(ctx, "acme")
		return cfg.Local.Secrets
	}
	// The box's own socket can't move them through the project's config.
	err := sb.local.Call(ctx, http.MethodPut, "/v1/locations/acme/config", map[string]any{"local": RepoConfig{Secrets: &SecretStoreChoice{Store: "gcp", GCPProject: "evil-project"}}}, nil)
	if err == nil || choice().GCPProject != "acme-staging" {
		t.Fatalf("an agent moved the project's secrets: %v %+v", err, choice())
	}
	// A config written without it, from either side, keeps it.
	if err := sb.local.Call(ctx, http.MethodPut, "/v1/locations/acme/config", map[string]any{"local": RepoConfig{Ports: 2}}, nil); err != nil {
		t.Fatal(err)
	}
	if status := call(t, sb.remote, "PUT", "/v1/locations/acme/config", "app", map[string]any{"local": RepoConfig{Ports: 3}}, nil); status != 200 {
		t.Fatalf("config from the app: %d", status)
	}
	if c := choice(); c == nil || c.Store != "gcp" || c.GCPProject != "acme-staging" {
		t.Fatalf("writing the config dropped it: %+v", c)
	}
	// Settings clears it.
	call(t, sb.remote, "PUT", "/v1/secrets/settings", "app", SecretSettings{Store: "local", Locations: map[string]SecretStoreChoice{"acme": {}}}, nil)
	if c := choice(); c != nil {
		t.Fatalf("clearing left %+v", c)
	}
}

func TestAnExpiredSecretIsGoneFromMemoryToo(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	ctx := context.Background()
	now := time.Now()
	stores := testStores(t, noKeyrings)
	stores.Now = func() time.Time { return now }
	st, _ := stores.Open("local", "")
	ref, _ := st.Save(ctx, SecretSave{Name: "ACME_TOKEN", Value: "short-lived"})
	exp := now.Add(time.Hour)
	stores.Index().Put(SecretMeta{Name: "ACME_TOKEN", Ref: ref, Store: "local", Created: now, Expires: &exp})
	s := &Secrets{Stores: stores}
	if v, err := s.Resolve(ctx, ref, nil, false); err != nil || v != "short-lived" {
		t.Fatalf("before: %q %v", v, err)
	}
	now = now.Add(61 * time.Minute)
	if _, err := s.Resolve(ctx, ref, nil, false); err == nil {
		t.Fatal("the cache handed out an expired secret")
	}
}

// inWorktree is a client for an agent in worktree name of project acme, as
// most agents are: its session is at acme/name.
func (sb *secretBed) inWorktree(t *testing.T, name string) *Client {
	t.Helper()
	if status := call(t, sb.remote, "POST", "/v1/locations/acme/worktrees", "", map[string]string{"name": name}, nil); status != 200 {
		t.Fatalf("worktree: %d", status)
	}
	session := name + "-agent"
	if status := call(t, sb.remote, "POST", "/v1/sessions", "", map[string]string{"location": "acme/" + name, "name": session, "command": sb.agent}, nil); status != 200 {
		t.Fatalf("session: %d", status)
	}
	t.Cleanup(func() { sb.bx.Sessions.Kill(context.Background(), session) })
	return sb.local.WithCaller(session)
}

func TestAProjectsOwnStoreCountsForAgentsInItsWorktrees(t *testing.T) {
	registerAcmeVault(t)
	sb := newSecretBed(t, noKeyrings)
	call(t, sb.remote, "PUT", "/v1/secrets/settings", "app", SecretSettings{Store: "local", Locations: map[string]SecretStoreChoice{"acme": {Store: "acmevault"}}}, nil)
	sr, err := sb.inWorktree(t, "fix").RequestSecret(context.Background(), SecretRequestBody{Name: "ACME_TOKEN", Reason: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	if sr.Store != "acmevault" || sr.Location != "acme" {
		t.Fatalf("an agent in a worktree got store %q, project %q", sr.Store, sr.Location)
	}
}

func TestANameTemplateSaysWhatTheStoreCallsASecret(t *testing.T) {
	for _, c := range []struct{ template, want string }{
		{"", "FRONT_API_KEY"},
		{"{NAME}", "FRONT_API_KEY"},
		{"{NAME}_{SERVICE}_{ENV}", "FRONT_API_KEY_SHOP_BULK_EDITOR_PRODUCTION"},
		{"{name}-{service}-{env}", "front-api-key-shop-bulk-editor-production"},
		{"acme_{NAME}", "acme_FRONT_API_KEY"},
	} {
		if got := secretID(c.template, "FRONT_API_KEY", "shop-bulk-editor", "production"); got != c.want {
			t.Errorf("%q gave %q, want %q", c.template, got, c.want)
		}
	}
	for _, bad := range []string{"{SERVICE}", "{NAME}_{OTHER}", "{NAME}/x", "{NAME} x"} {
		if (SecretStoreChoice{NameTemplate: bad}).validate() == nil {
			t.Errorf("template %q was taken", bad)
		}
	}
	if (SecretStoreChoice{Service: "a b"}).validate() == nil {
		t.Error("a service with a space was taken")
	}
}

func TestSecretsGoWhereThePersonPicksUnderTheTemplatesName(t *testing.T) {
	bins, dir := fakeBins(t, "gcloud")
	bins["security"], bins["secret-tool"] = noKeyrings["security"], noKeyrings["secret-tool"]
	sb := newSecretBed(t, bins)
	ctx := context.Background()
	settings := SecretSettings{Store: "gcp", GCPProject: "acme-staging", GCPPrivateProject: "acme-private", NameTemplate: "{NAME}_{SERVICE}_{ENV}"}
	if status := call(t, sb.remote, "PUT", "/v1/secrets/settings", "app", settings, nil); status != 200 {
		t.Fatalf("settings: %d", status)
	}
	agent := sb.inWorktree(t, "fix")

	// The agent asks for the plain name; the store calls it by the template.
	sr, err := agent.RequestSecret(ctx, SecretRequestBody{Name: "FRONT_KEY", Reason: "deploy", Environment: "staging"})
	if err != nil {
		t.Fatal(err)
	}
	if sr.Name != "FRONT_KEY" || sr.SecretID != "FRONT_KEY_ACME_STAGING" || sr.Where != "acme-staging" || sr.PrivateWhere != "acme-private" || strings.Join(sr.WhereOptions, ",") != "acme-staging,acme-private" {
		t.Fatalf("request %+v", sr)
	}
	// A place the box doesn't save to is refused, and nothing is saved.
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "v", "where": "acme-elsewhere"}, nil); status != 400 {
		t.Fatalf("an unknown project: %d", status)
	}
	if len(readFakeGCP(dir)) != 0 {
		t.Fatalf("it saved: %+v", readFakeGCP(dir))
	}
	var saved map[string]string
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "v1"}, &saved); status != 200 || saved["ref"] != "gcp://projects/acme-staging/secrets/FRONT_KEY_ACME_STAGING" {
		t.Fatalf("save: %d %v", status, saved)
	}
	if _, ok := readFakeGCP(dir)["FRONT_KEY_ACME_STAGING"]; !ok {
		t.Fatalf("store %+v", readFakeGCP(dir))
	}
	// The same name is the same secret; another environment is another one.
	again, err := agent.RequestSecret(ctx, SecretRequestBody{Name: "FRONT_KEY", Reason: "again", Environment: "staging"})
	if err != nil || !again.Reused || again.Ref != saved["ref"] {
		t.Fatalf("reuse: %+v %v", again, err)
	}
	prod, err := agent.RequestSecret(ctx, SecretRequestBody{Name: "FRONT_KEY", Reason: "release", Environment: "production"})
	if err != nil || prod.Reused || prod.SecretID != "FRONT_KEY_ACME_PRODUCTION" {
		t.Fatalf("production: %+v %v", prod, err)
	}
	// With no environment, one the template needs reads as staging, and
	// the card says so.
	plain, err := agent.RequestSecret(ctx, SecretRequestBody{Name: "PLAIN_KEY", Reason: "x"})
	if err != nil || plain.Environment != "staging" || plain.SecretID != "PLAIN_KEY_ACME_STAGING" {
		t.Fatalf("no environment: %+v %v", plain, err)
	}

	// Picked on the card: the private project, and the agent's reference.
	private, err := agent.RequestSecret(ctx, SecretRequestBody{Name: "MY_KEY", Reason: "mine", Environment: "staging"})
	if err != nil {
		t.Fatal(err)
	}
	if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+private.ID+"/save", "app", map[string]string{"value": "v2", "where": "acme-private"}, &saved); status != 200 || saved["ref"] != "gcp://projects/acme-private/secrets/MY_KEY_ACME_STAGING" {
		t.Fatalf("private save: %d %v", status, saved)
	}
	if log := argvLog(t, dir); !strings.Contains(log, "secrets versions add MY_KEY_ACME_STAGING --data-file=- --project=acme-private") {
		t.Fatalf("gcloud ran:\n%s", log)
	}
	// Asked for again, it is found there, with no second card.
	mine, err := agent.RequestSecret(ctx, SecretRequestBody{Name: "MY_KEY", Reason: "mine again", Environment: "staging"})
	if err != nil || !mine.Reused || mine.Ref != saved["ref"] || mine.Where != "acme-private" {
		t.Fatalf("private reuse: %+v %v", mine, err)
	}
	// A replacement goes where the old one is.
	repl, err := agent.RequestSecret(ctx, SecretRequestBody{Name: "MY_KEY", Reason: "rotate", Environment: "staging", New: true})
	if err != nil || repl.Where != "acme-private" || repl.WhereOptions[0] != "acme-private" {
		t.Fatalf("replacement: %+v %v", repl, err)
	}
	// Settings lists the private project's secrets too, by the asked name.
	var list SavedSecrets
	call(t, sb.remote, "GET", "/v1/secrets", "", nil, &list)
	found := false
	for _, m := range list.Secrets {
		found = found || (m.Name == "MY_KEY" && m.ID == "MY_KEY_ACME_STAGING" && m.Where == "acme-private")
	}
	if !found || list.Settings.GCPPrivateProject != "acme-private" || list.Settings.NameTemplate != "{NAME}_{SERVICE}_{ENV}" {
		t.Fatalf("list %+v", list)
	}
	// A project's service name is its own.
	call(t, sb.remote, "PUT", "/v1/secrets/settings", "app", SecretSettings{Store: "gcp", GCPProject: "acme-staging", NameTemplate: "{NAME}_{SERVICE}_{ENV}", Locations: map[string]SecretStoreChoice{"acme": {Service: "shop-api"}}}, nil)
	named, err := agent.RequestSecret(ctx, SecretRequestBody{Name: "OTHER_KEY", Reason: "x", Environment: "production"})
	if err != nil || named.SecretID != "OTHER_KEY_SHOP_API_PRODUCTION" {
		t.Fatalf("service: %+v %v", named, err)
	}
	// The box's socket can't move the template either.
	if err := sb.local.Call(ctx, http.MethodPut, "/v1/locations/acme/config", map[string]any{"local": RepoConfig{Secrets: &SecretStoreChoice{NameTemplate: "{NAME}_X"}}}, nil); err == nil {
		t.Fatal("an agent changed the project's name template")
	}
}

func TestASecretSentElsewhereIsOnlyItsProjectsAndEnvironments(t *testing.T) {
	bins, _ := fakeBins(t, "gcloud")
	bins["security"], bins["secret-tool"] = noKeyrings["security"], noKeyrings["secret-tool"]
	sb := newSecretBed(t, bins)
	ctx := context.Background()
	call(t, sb.remote, "POST", "/v1/locations", "", map[string]string{"name": "other", "path": gitRepo(t)}, nil)
	call(t, sb.remote, "PUT", "/v1/secrets/settings", "app", SecretSettings{Store: "gcp", GCPProject: "acme-staging", GCPPrivateProject: "acme-private", Locations: map[string]SecretStoreChoice{"other": {Store: "gcp", GCPProject: "acme-other"}}}, nil)
	if status := call(t, sb.remote, "POST", "/v1/sessions", "", map[string]string{"location": "other", "name": "theirs", "command": sb.agent}, nil); status != 200 {
		t.Fatalf("session: %d", status)
	}
	t.Cleanup(func() { sb.bx.Sessions.Kill(context.Background(), "theirs") })
	theirs := sb.local.WithCaller("theirs")
	ask := func(c *Client, b SecretRequestBody) SecretRequest {
		t.Helper()
		b.Name, b.Reason = "API_KEY", "x"
		sr, err := c.RequestSecret(ctx, b)
		if err != nil {
			t.Fatal(err)
		}
		return sr
	}
	save := func(sr SecretRequest, where string) string {
		t.Helper()
		var saved map[string]string
		if status := call(t, sb.remote, "POST", "/v1/secrets/requests/"+sr.ID+"/save", "app", map[string]string{"value": "v", "where": where}, &saved); status != 200 {
			t.Fatalf("save to %s: %d", where, status)
		}
		return saved["ref"]
	}

	// This project sends its staging key to the private project.
	mine := save(ask(sb.local, SecretRequestBody{Environment: "staging"}), "acme-private")
	if mine != "gcp://projects/acme-private/secrets/API_KEY" {
		t.Fatalf("ref %s", mine)
	}
	// Another project asking for that name gets a card, not this one's key.
	if got := ask(theirs, SecretRequestBody{Environment: "staging"}); got.Reused || got.Status != "pending" || got.Where != "acme-other" {
		t.Fatalf("another project: %+v", got)
	}
	// So does production, here.
	if got := ask(sb.local, SecretRequestBody{Environment: "production"}); got.Reused || got.Where != "acme-staging" {
		t.Fatalf("another environment: %+v", got)
	}
	// This project in staging finds it, and a replacement goes there.
	if got := ask(sb.local, SecretRequestBody{Environment: "staging"}); !got.Reused || got.Ref != mine {
		t.Fatalf("reuse: %+v", got)
	}

	// The same holds for any project the card offers, not just the private
	// one: here, the other project's. The requests above stop waiting first.
	for _, r := range sb.bx.SecretRequests.Pending() {
		sb.bx.endSecretRequest(nil, r.ID, secretDeclined, "", false)
	}
	third := ask(sb.local, SecretRequestBody{Environment: "production"})
	if strings.Join(third.WhereOptions, ",") != "acme-staging,acme-private,acme-other" {
		t.Fatalf("options %v", third.WhereOptions)
	}
	ref := save(third, "acme-other")
	if got := ask(sb.local, SecretRequestBody{Environment: "production"}); !got.Reused || got.Ref != ref {
		t.Fatalf("reuse after a third project: %+v", got)
	}
	if got := ask(sb.local, SecretRequestBody{Environment: "production", New: true}); !got.Replace || got.Where != "acme-other" {
		t.Fatalf("rotation after a third project: %+v", got)
	}
}
