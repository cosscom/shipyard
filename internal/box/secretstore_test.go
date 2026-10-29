package box

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The stores' programs are faked by this test binary itself: TestMain runs
// fakeProgram when BERTH_TEST_FAKE names one, keeping its state in
// BERTH_TEST_FAKE_DIR and logging every argv it was given, so a test can
// check no value ever reached one.

// fakeBins points a store's programs at this binary, as fake, with dir for
// their state.
func fakeBins(t *testing.T, fake string) (map[string]string, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("BERTH_TEST_FAKE", fake)
	t.Setenv("BERTH_TEST_FAKE_DIR", dir)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{fake: exe}, dir
}

func fakeProgram() int {
	dir := os.Getenv("BERTH_TEST_FAKE_DIR")
	args := os.Args[1:]
	if f, err := os.OpenFile(filepath.Join(dir, "argv.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		fmt.Fprintln(f, strings.Join(args, " "))
		f.Close()
	}
	switch os.Getenv("BERTH_TEST_FAKE") {
	case "security":
		return fakeSecurity(dir, args)
	case "secret-tool":
		return fakeSecretTool(dir, args)
	case "gcloud":
		return fakeGcloud(dir, args)
	}
	return 2
}

func flagValue(args []string, name string) string {
	for i, a := range args {
		if a == name && i+1 < len(args) {
			return args[i+1]
		}
		if v, ok := strings.CutPrefix(a, name+"="); ok {
			return v
		}
	}
	return ""
}

func fakeSecurity(dir string, args []string) int {
	item := func(name string) string { return filepath.Join(dir, "kc-"+name) }
	switch args[0] {
	case "-i":
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			f := strings.Fields(sc.Text())
			if len(f) == 0 || f[0] != "add-generic-password" {
				continue
			}
			v, err := hex.DecodeString(flagValue(f, "-X"))
			if err != nil {
				fmt.Fprintln(os.Stderr, "bad hex")
				continue
			}
			os.WriteFile(item(flagValue(f, "-a")), v, 0o600)
		}
		return 0
	case "find-generic-password":
		v, err := os.ReadFile(item(flagValue(args, "-a")))
		if err != nil {
			fmt.Fprintln(os.Stderr, "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.")
			return 44
		}
		for _, a := range args {
			if a == "-w" {
				fmt.Println(string(v))
			}
		}
		return 0
	case "delete-generic-password":
		if err := os.Remove(item(flagValue(args, "-a"))); err != nil {
			fmt.Fprintln(os.Stderr, "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.")
			return 44
		}
		return 0
	}
	return 2
}

func fakeSecretTool(dir string, args []string) int {
	if os.Getenv("BERTH_TEST_FAKE_MODE") == "nobus" {
		fmt.Fprintln(os.Stderr, "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY")
		return 1
	}
	name := flagValue(args, "name")
	item := filepath.Join(dir, "ss-"+name)
	switch args[0] {
	case "lookup":
		v, err := os.ReadFile(item)
		if err != nil || name == "" {
			return 1
		}
		os.Stdout.Write(v)
		return 0
	case "store":
		v, _ := io.ReadAll(os.Stdin)
		os.WriteFile(item, v, 0o600)
		return 0
	case "clear":
		os.Remove(item)
		return 0
	}
	return 2
}

// The fake Secret Manager: secrets by ID, each with labels, versions and
// IAM bindings.
type fakeGCPSecret struct {
	Labels   map[string]string `json:"labels"`
	Versions []string          `json:"versions"`
	Bindings []string          `json:"bindings"`
}

func readFakeGCP(dir string) map[string]*fakeGCPSecret {
	m := map[string]*fakeGCPSecret{}
	if b, err := os.ReadFile(filepath.Join(dir, "gcloud.json")); err == nil {
		json.Unmarshal(b, &m)
	}
	return m
}

func writeFakeGCP(dir string, m map[string]*fakeGCPSecret) {
	b, _ := json.Marshal(m)
	os.WriteFile(filepath.Join(dir, "gcloud.json"), b, 0o600)
}

func fakeGcloud(dir string, args []string) int {
	if len(args) < 2 || args[0] != "secrets" {
		return 2
	}
	project := flagValue(args, "--project")
	cmd := args[1]
	if cmd == "versions" {
		cmd += " " + args[2]
	}
	perm := map[string]string{"describe": "secretmanager.secrets.get", "create": "secretmanager.secrets.create", "versions add": "secretmanager.versions.add", "versions access": "secretmanager.versions.access", "list": "secretmanager.secrets.list", "delete": "secretmanager.secrets.delete", "add-iam-policy-binding": "secretmanager.secrets.setIamPolicy"}[cmd]
	for _, p := range strings.Split(os.Getenv("BERTH_TEST_FAKE_DENY"), ",") {
		if p != "" && p == perm {
			fmt.Fprintf(os.Stderr, "ERROR: (gcloud.secrets.%s) PERMISSION_DENIED: Permission '%s' denied for resource 'projects/%s' (or it may not exist).\n", strings.ReplaceAll(cmd, " ", "."), perm, project)
			return 1
		}
	}
	m := readFakeGCP(dir)
	notFound := func(id string) int {
		fmt.Fprintf(os.Stderr, "ERROR: (gcloud.secrets.%s) NOT_FOUND: Secret [projects/123456/secrets/%s] not found or has no versions.\n", strings.ReplaceAll(cmd, " ", "."), id)
		return 1
	}
	switch cmd {
	case "describe":
		s, ok := m[args[2]]
		if !ok {
			return notFound(args[2])
		}
		json.NewEncoder(os.Stdout).Encode(map[string]any{"name": "projects/123456/secrets/" + args[2], "labels": s.Labels, "createTime": "2026-10-29T10:00:00Z"})
	case "create":
		if _, ok := m[args[2]]; ok {
			fmt.Fprintln(os.Stderr, "ERROR: (gcloud.secrets.create) ALREADY_EXISTS")
			return 1
		}
		labels := map[string]string{}
		for _, kv := range strings.Split(flagValue(args, "--labels"), ",") {
			k, v, _ := strings.Cut(kv, "=")
			labels[k] = v
		}
		m[args[2]] = &fakeGCPSecret{Labels: labels}
	case "versions add":
		s, ok := m[args[3]]
		if !ok {
			return notFound(args[3])
		}
		v, _ := io.ReadAll(os.Stdin)
		s.Versions = append(s.Versions, string(v))
	case "versions access":
		s, ok := m[flagValue(args, "--secret")]
		if !ok || len(s.Versions) == 0 {
			return notFound(flagValue(args, "--secret"))
		}
		os.Stdout.WriteString(s.Versions[len(s.Versions)-1])
	case "list":
		var out []map[string]any
		for id, s := range m {
			if s.Labels["shipyard"] == "true" {
				out = append(out, map[string]any{"name": "projects/123456/secrets/" + id, "labels": s.Labels, "createTime": "2026-10-29T10:00:00Z"})
			}
		}
		json.NewEncoder(os.Stdout).Encode(out)
	case "delete":
		if _, ok := m[args[2]]; !ok {
			return notFound(args[2])
		}
		delete(m, args[2])
	case "add-iam-policy-binding":
		s, ok := m[args[2]]
		if !ok {
			return notFound(args[2])
		}
		s.Bindings = append(s.Bindings, flagValue(args, "--member")+" "+flagValue(args, "--role"))
	default:
		return 2
	}
	writeFakeGCP(dir, m)
	return 0
}

func argvLog(t *testing.T, dir string) string {
	t.Helper()
	b, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	return string(b)
}

// noKeyrings keeps a test off the machine's own Keychain and Secret
// Service: the local store falls back to its encrypted file.
var noKeyrings = map[string]string{"security": "/nonexistent/security", "secret-tool": "/nonexistent/secret-tool"}

func testStores(t *testing.T, bins map[string]string) *SecretStores {
	t.Helper()
	return &SecretStores{Dir: t.TempDir(), Box: "devbox", Bins: bins}
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return st.Mode().Perm()
}

func TestTheEncryptedFileRoundTripsAndKeepsItsKeyApart(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	stores := testStores(t, noKeyrings)
	ctx := context.Background()
	st, err := stores.Open("local", "")
	if err != nil {
		t.Fatal(err)
	}
	if st.Label() != "Encrypted file" {
		t.Fatalf("a box with no Keychain or Secret Service saves to %q", st.Label())
	}
	const value = "acme-sentinel-7f3a\tv2 é"
	ref, err := st.Save(ctx, SecretSave{Name: "ACME_TOKEN", Value: value})
	if err != nil || ref != "box://ACME_TOKEN" {
		t.Fatalf("save: %q %v", ref, err)
	}
	if got, err := stores.Resolve(ctx, ref); err != nil || got != value {
		t.Fatalf("resolve: %q %v", got, err)
	}
	dir := filepath.Join(stores.Dir, "secrets")
	key := filepath.Join(stores.Dir, "secret.key")
	if mode(t, dir) != 0o700 || mode(t, filepath.Join(dir, "values.json")) != 0o600 || mode(t, key) != 0o600 {
		t.Fatalf("modes: dir %o, values %o, key %o", mode(t, dir), mode(t, filepath.Join(dir, "values.json")), mode(t, key))
	}
	if filepath.Dir(key) == dir {
		t.Fatal("the key sits with the values")
	}
	// Nothing in the state folder holds the value in the clear.
	filepath.Walk(stores.Dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			if b, _ := os.ReadFile(p); strings.Contains(string(b), "acme-sentinel") {
				t.Errorf("%s holds the value", p)
			}
		}
		return nil
	})
	// A value can't be moved to another name: the name is bound in.
	fb := &fileBackend{dir: dir, keyPath: key}
	vals := fb.values()
	fb.write(func(m map[string]string) { m["OTHER"] = vals["ACME_TOKEN"] })
	if _, err := fb.get(ctx, "OTHER"); err == nil {
		t.Fatal("a value copied to another name decrypted")
	}
	// Replacing it keeps one value; deleting it leaves none.
	st.Save(ctx, SecretSave{Name: "ACME_TOKEN", Value: "second"})
	if got, _ := stores.Resolve(ctx, ref); got != "second" {
		t.Fatalf("after replacing: %q", got)
	}
	if err := st.Delete(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := stores.Resolve(ctx, ref); err == nil {
		t.Fatal("a deleted secret resolved")
	}
}

func TestTheKeychainGetsTheValueOnStdinNeverAsAnArgument(t *testing.T) {
	bins, dir := fakeBins(t, "security")
	stores := testStores(t, bins)
	ctx := context.Background()
	st, _ := stores.Open("local", "")
	if st.Label() != "Keychain" {
		t.Fatalf("label %q", st.Label())
	}
	const value = "kc-sentinel-'\"$(rm -rf)` value"
	ref, err := st.Save(ctx, SecretSave{Name: "ACME_TOKEN", Value: value})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := stores.Resolve(ctx, ref); err != nil || got != value {
		t.Fatalf("resolve: %q %v", got, err)
	}
	log := argvLog(t, dir)
	if strings.Contains(log, "kc-sentinel") || strings.Contains(log, hex.EncodeToString([]byte(value))) {
		t.Fatalf("the value reached security's arguments:\n%s", log)
	}
	if !strings.Contains(log, "-i\n") {
		t.Fatalf("security was not run interactively:\n%s", log)
	}
	if b, l := st.(*localStore).Detail(ref); b != backendKeychain || l != "Keychain" {
		t.Fatalf("detail %q %q", b, l)
	}
	if err := st.Delete(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "kc-ACME_TOKEN")); !os.IsNotExist(err) {
		t.Fatal("the Keychain item is still there")
	}
}

func TestASecretServiceIsUsedOnlyWhenOneAnswers(t *testing.T) {
	ctx := context.Background()
	bins, dir := fakeBins(t, "secret-tool")
	bins["security"] = noKeyrings["security"]
	// A bus that answers.
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus")
	stores := testStores(t, bins)
	st, _ := stores.Open("local", "")
	if st.Label() != "Secret Service" {
		t.Fatalf("with a Secret Service: %q", st.Label())
	}
	ref, _ := st.Save(ctx, SecretSave{Name: "ACME_TOKEN", Value: "ss-sentinel"})
	if got, _ := stores.Resolve(ctx, ref); got != "ss-sentinel" {
		t.Fatalf("resolve %q", got)
	}
	if strings.Contains(argvLog(t, dir), "ss-sentinel") {
		t.Fatal("the value reached secret-tool's arguments")
	}
	// A bus with no service: the encrypted file.
	t.Setenv("BERTH_TEST_FAKE_MODE", "nobus")
	if l := testStores(t, bins); true {
		st, _ := l.Open("local", "")
		if st.Label() != "Encrypted file" {
			t.Fatalf("with no service on the bus: %q", st.Label())
		}
	}
	// No bus at all: the encrypted file, without asking.
	t.Setenv("BERTH_TEST_FAKE_MODE", "")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	st2, _ := testStores(t, bins).Open("local", "")
	if st2.Label() != "Encrypted file" {
		t.Fatalf("with no bus: %q", st2.Label())
	}
	// What the Secret Service saved still reads from it after it is gone
	// from the bus: the record says where.
	if got, err := stores.Resolve(ctx, ref); err != nil || got != "ss-sentinel" {
		t.Fatalf("resolve after: %q %v", got, err)
	}
}

func TestExpiredSecretsReadAsGoneAndAreSwept(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	ctx := context.Background()
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	stores := testStores(t, noKeyrings)
	stores.Now = func() time.Time { return now }
	st, _ := stores.Open("local", "")
	for _, n := range []string{"SHORT", "LONG"} {
		ref, err := st.Save(ctx, SecretSave{Name: n, Value: n + "-v"})
		if err != nil {
			t.Fatal(err)
		}
		m := SecretMeta{Name: n, Ref: ref, Store: "local", Created: now}
		if n == "SHORT" {
			exp := now.Add(time.Hour)
			m.Expires = &exp
		}
		stores.Index().Put(m)
	}
	now = now.Add(61 * time.Minute)
	if _, err := stores.Resolve(ctx, "box://SHORT"); err == nil || !errors.Is(err, errSecretExpired) {
		t.Fatalf("an expired secret resolved: %v", err)
	}
	if gone := stores.Sweep(ctx); len(gone) != 1 || gone[0] != "SHORT" {
		t.Fatalf("swept %v", gone)
	}
	if _, ok := stores.Index().Get("box://SHORT"); ok {
		t.Fatal("the sweep left it in the index")
	}
	if _, ok := st.(*localStore).records()["SHORT"]; ok {
		t.Fatal("the sweep left it in the store")
	}
	if v, err := stores.Resolve(ctx, "box://LONG"); err != nil || v != "LONG-v" {
		t.Fatalf("a secret with no expiry: %q %v", v, err)
	}
}

func TestReferencesToSavedSecrets(t *testing.T) {
	for ref, ok := range map[string]bool{
		"box://ACME_TOKEN":                               true,
		"box://acme":                                     false,
		"box://":                                         false,
		"box://A/B":                                      false,
		"gcp://projects/acme-staging/secrets/ACME_TOKEN": true,
		"gcp://projects/acme-staging/secrets/ACME_TOKEN/versions/3":      true,
		"gcp://projects/acme-staging/secrets/ACME_TOKEN/versions/latest": true,
		"gcp://projects/Acme/secrets/X":                                  false,
		"gcp://acme/X":                                                   false,
	} {
		if !IsSecretRef(ref) {
			t.Errorf("%s is not seen as a reference", ref)
		}
		if err := ValidateSecretRef(ref); (err == nil) != ok {
			t.Errorf("%s: %v", ref, err)
		}
	}
	if IsSecretRef("vault://x") {
		t.Error("an unknown scheme is a reference")
	}
	// A config can name them like any other reference.
	if err := (RepoConfig{Env: map[string]string{"T": "box://ACME_TOKEN"}}).validate(); err != nil {
		t.Fatal(err)
	}
	if err := (RepoConfig{Env: map[string]string{"T": "box://lower"}}).validate(); err == nil {
		t.Fatal("a bad box:// reference passed")
	}
}

func TestTheStoreComesFromTheRequestThenTheProjectThenTheBox(t *testing.T) {
	boxDefault := SecretStoreChoice{Store: "gcp", GCPProject: "acme-box"}
	project := SecretStoreChoice{Store: "local"}
	for _, c := range []struct {
		request             string
		project, box        SecretStoreChoice
		wantID, wantProject string
	}{
		{"", SecretStoreChoice{}, SecretStoreChoice{}, "local", ""},
		{"", SecretStoreChoice{}, boxDefault, "gcp", "acme-box"},
		{"", project, boxDefault, "local", ""},
		{"gcp", project, boxDefault, "gcp", "acme-box"},
		{"gcp", SecretStoreChoice{GCPProject: "acme-proj"}, boxDefault, "gcp", "acme-proj"},
		{"local", SecretStoreChoice{Store: "gcp", GCPProject: "acme-proj"}, boxDefault, "local", ""},
	} {
		id, where := Choose(c.request, c.project, c.box)
		if id != c.wantID || where != c.wantProject {
			t.Errorf("Choose(%q, %+v, %+v) = %s %s, want %s %s", c.request, c.project, c.box, id, where, c.wantID, c.wantProject)
		}
	}
}

func TestTheGCPStoreLabelsWhatItMakesAndTouchesNothingElse(t *testing.T) {
	bins, dir := fakeBins(t, "gcloud")
	stores := testStores(t, bins)
	ctx := context.Background()
	st, err := stores.Open("gcp", "acme-staging")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stores.Open("gcp", ""); err == nil {
		t.Fatal("gcp opened with no project")
	}
	ref, err := st.Save(ctx, SecretSave{Name: "ACME_TOKEN", Value: "gcp-sentinel-1", Environment: "staging", Location: "Acme Shop", Grant: "deployer@acme-staging.iam.gserviceaccount.com"})
	if err != nil {
		t.Fatal(err)
	}
	if ref != "gcp://projects/acme-staging/secrets/ACME_TOKEN" {
		t.Fatalf("ref %q", ref)
	}
	s := readFakeGCP(dir)["ACME_TOKEN"]
	want := map[string]string{"shipyard": "true", "shipyard-environment": "staging", "shipyard-location": "acme-shop", "shipyard-box": "devbox"}
	for k, v := range want {
		if s.Labels[k] != v {
			t.Errorf("label %s = %q, want %q (%v)", k, s.Labels[k], v, s.Labels)
		}
	}
	if len(s.Versions) != 1 || len(s.Bindings) != 1 || s.Bindings[0] != "serviceAccount:deployer@acme-staging.iam.gserviceaccount.com roles/secretmanager.secretAccessor" {
		t.Fatalf("secret = %+v", s)
	}
	log := argvLog(t, dir)
	if strings.Contains(log, "gcp-sentinel") {
		t.Fatal("the value reached gcloud's arguments")
	}
	// The binding is on that one secret: no project-level IAM command ran.
	if strings.Contains(log, "projects add-iam-policy-binding") || !strings.Contains(log, "secrets add-iam-policy-binding ACME_TOKEN") {
		t.Fatalf("gcloud ran:\n%s", log)
	}
	if v, err := stores.Resolve(ctx, ref); err != nil || v != "gcp-sentinel-1" {
		t.Fatalf("resolve %q %v", v, err)
	}
	// A labelled one gets a new version.
	if _, err := st.Save(ctx, SecretSave{Name: "ACME_TOKEN", Value: "gcp-sentinel-2"}); err != nil {
		t.Fatal(err)
	}
	if s := readFakeGCP(dir)["ACME_TOKEN"]; len(s.Versions) != 2 {
		t.Fatalf("versions %v", s.Versions)
	}
	if v, _ := stores.Resolve(ctx, ref); v != "gcp-sentinel-2" {
		t.Fatalf("latest %q", v)
	}
	// One Shipyard didn't make is refused, and left as it was.
	m := readFakeGCP(dir)
	m["THEIRS"] = &fakeGCPSecret{Labels: map[string]string{"team": "billing"}, Versions: []string{"keep"}}
	writeFakeGCP(dir, m)
	if _, err := st.Save(ctx, SecretSave{Name: "THEIRS", Value: "x"}); err == nil || !strings.Contains(err.Error(), "didn't make") {
		t.Fatalf("an unlabelled secret: %v", err)
	}
	if err := st.Delete(ctx, "gcp://projects/acme-staging/secrets/THEIRS"); err == nil {
		t.Fatal("an unlabelled secret was deleted")
	}
	if s := readFakeGCP(dir)["THEIRS"]; len(s.Versions) != 1 {
		t.Fatalf("an unlabelled secret changed: %+v", s)
	}
	// Listing finds only the labelled ones.
	metas, err := st.List(ctx)
	if err != nil || len(metas) != 1 || metas[0].Ref != ref || metas[0].Where != "acme-staging" || metas[0].Environment != "staging" {
		t.Fatalf("list %+v %v", metas, err)
	}
	if err := st.Delete(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if _, ok := readFakeGCP(dir)["ACME_TOKEN"]; ok {
		t.Fatal("not deleted")
	}
}

func TestTheGCPStoreNamesTheMissingPermission(t *testing.T) {
	bins, _ := fakeBins(t, "gcloud")
	stores := testStores(t, bins)
	ctx := context.Background()
	st, _ := stores.Open("gcp", "acme-staging")
	for perm, save := range map[string]SecretSave{
		"secretmanager.secrets.create":       {Name: "A_KEY", Value: "v"},
		"secretmanager.versions.add":         {Name: "B_KEY", Value: "v"},
		"secretmanager.secrets.setIamPolicy": {Name: "C_KEY", Value: "v", Grant: "ci@acme-staging.iam.gserviceaccount.com"},
	} {
		t.Setenv("BERTH_TEST_FAKE_DENY", perm)
		_, err := st.Save(ctx, save)
		if err == nil || !strings.Contains(err.Error(), "missing permission "+perm+" on project acme-staging") {
			t.Errorf("denied %s: %v", perm, err)
		}
	}
	t.Setenv("BERTH_TEST_FAKE_DENY", "secretmanager.secrets.list")
	if _, err := st.List(ctx); err == nil || !strings.Contains(err.Error(), "secretmanager.secrets.list") {
		t.Errorf("list: %v", err)
	}
}
