package box

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/chacha20poly1305"

	"github.com/cosscom/shipyard/internal/statefile"
)

// The local store keeps values on the box itself, in one namespace for the
// whole box: any agent on it can use any secret saved here. Where depends
// on the box:
//
//   - macOS: the login Keychain, written through `security -i` with the
//     value on its stdin, never in its arguments.
//   - Linux with a Secret Service on the session bus (GNOME Keyring,
//     KeePassXC): libsecret's secret-tool, the value on its stdin.
//   - Otherwise an encrypted file in the box's state folder:
//     XChaCha20-Poly1305 values, the key in a file of its own. That guards
//     against a leak, a backup or a grep of the folder, not against another
//     program running as the same user, which can read the key too.
//
// Which backend kept each secret is recorded beside it, so a box that gains
// a Secret Service later still reads what it saved before.

func init() {
	registerSecretStore(&secretProvider{
		ID: "local", Scheme: "box", Name: "Local",
		Caps:        StoreCaps{Expiry: true},
		ValidateRef: validateBoxRef,
		RefName:     func(ref string) string { return strings.TrimPrefix(ref, "box://") },
		Open:        func(env StoreEnv) SecretStore { return &localStore{env: env} },
	})
}

func validateBoxRef(ref string) error {
	name, ok := strings.CutPrefix(ref, "box://")
	if !ok || !secretName.MatchString(name) {
		return fmt.Errorf("%q is not a saved secret's reference; they look like box://NAME", ref)
	}
	return nil
}

// The local backends.
const (
	backendKeychain      = "keychain"
	backendSecretService = "secret-service"
	backendFile          = "file"
)

var backendLabels = map[string]string{backendKeychain: "Keychain", backendSecretService: "Secret Service", backendFile: "Encrypted file"}

// localService is the Keychain item's service and secret-tool's attribute
// for the values the box keeps.
const localService = "dev.berth.secrets"

type localStore struct {
	env StoreEnv
}

func (l *localStore) dir() string { return filepath.Join(l.env.Dir, "secrets") }

// recordPath says which backend keeps each name.
func (l *localStore) recordPath() string { return filepath.Join(l.dir(), "local.json") }

type localRecord struct {
	Backend string    `json:"backend"`
	Created time.Time `json:"created"`
}

var localMu sync.Mutex

func (l *localStore) records() map[string]localRecord {
	m := map[string]localRecord{}
	if b, err := os.ReadFile(l.recordPath()); err == nil {
		json.Unmarshal(b, &m)
	}
	return m
}

func (l *localStore) updateRecords(f func(map[string]localRecord)) error {
	localMu.Lock()
	defer localMu.Unlock()
	if err := os.MkdirAll(l.dir(), 0o700); err != nil {
		return err
	}
	unlock, err := statefile.Lock(l.recordPath())
	if err != nil {
		return err
	}
	defer unlock()
	m := l.records()
	f(m)
	b, _ := json.MarshalIndent(m, "", "  ")
	return statefile.Write(l.recordPath(), b)
}

// backend is where a new value goes on this box now.
func (l *localStore) backend(ctx context.Context) localBackend {
	if runtime.GOOS == "darwin" || l.env.Bins["security"] != "" {
		if bin, err := l.env.bin("security"); err == nil {
			return &keychainBackend{bin: bin}
		}
	}
	if bin, err := l.env.bin("secret-tool"); err == nil && secretServiceAnswers(ctx, bin) {
		return &secretServiceBackend{bin: bin}
	}
	return &fileBackend{dir: l.dir(), keyPath: filepath.Join(l.env.Dir, "secret.key")}
}

// backendFor is the backend that keeps name, as recorded.
func (l *localStore) backendFor(kind string) (localBackend, error) {
	switch kind {
	case backendKeychain:
		bin, err := l.env.bin("security")
		if err != nil {
			return nil, errors.New("the Keychain's security command is missing")
		}
		return &keychainBackend{bin: bin}, nil
	case backendSecretService:
		bin, err := l.env.bin("secret-tool")
		if err != nil {
			return nil, errors.New("secret-tool (libsecret) is missing")
		}
		return &secretServiceBackend{bin: bin}, nil
	case backendFile:
		return &fileBackend{dir: l.dir(), keyPath: filepath.Join(l.env.Dir, "secret.key")}, nil
	}
	return nil, fmt.Errorf("unknown local backend %q", kind)
}

func (l *localStore) Label() string {
	return backendLabels[l.backend(context.Background()).kind()]
}

// Detail is the label of the backend that keeps ref.
func (l *localStore) Detail(ref string) (backend, label string) {
	r, ok := l.records()[strings.TrimPrefix(ref, "box://")]
	if !ok {
		return "", ""
	}
	return r.Backend, backendLabels[r.Backend]
}

func (l *localStore) Save(ctx context.Context, s SecretSave) (string, error) {
	if !secretName.MatchString(s.Name) {
		return "", fmt.Errorf("%q is not a secret name", s.Name)
	}
	be := l.backend(ctx)
	// A value that moves backend leaves nothing behind in the old one.
	old, had := l.records()[s.Name]
	if err := be.put(ctx, s.Name, s.Value); err != nil {
		return "", err
	}
	if had && old.Backend != be.kind() {
		if ob, err := l.backendFor(old.Backend); err == nil {
			ob.del(ctx, s.Name)
		}
	}
	err := l.updateRecords(func(m map[string]localRecord) {
		m[s.Name] = localRecord{Backend: be.kind(), Created: time.Now().UTC()}
	})
	if err != nil {
		return "", err
	}
	return "box://" + s.Name, nil
}

func (l *localStore) Resolve(ctx context.Context, ref string) (string, error) {
	if err := validateBoxRef(ref); err != nil {
		return "", err
	}
	name := strings.TrimPrefix(ref, "box://")
	r, ok := l.records()[name]
	if !ok {
		return "", fmt.Errorf("%s is not saved on this box", name)
	}
	be, err := l.backendFor(r.Backend)
	if err != nil {
		return "", err
	}
	return be.get(ctx, name)
}

func (l *localStore) List(ctx context.Context) ([]SecretMeta, error) {
	var out []SecretMeta
	for name, r := range l.records() {
		out = append(out, SecretMeta{Name: name, Ref: "box://" + name, Store: "local", StoreLabel: backendLabels[r.Backend], Backend: r.Backend, Created: r.Created})
	}
	return out, nil
}

func (l *localStore) Delete(ctx context.Context, ref string) error {
	if err := validateBoxRef(ref); err != nil {
		return err
	}
	name := strings.TrimPrefix(ref, "box://")
	r, ok := l.records()[name]
	if !ok {
		return fmt.Errorf("%s: %w", name, errSecretNotFound)
	}
	be, err := l.backendFor(r.Backend)
	if err != nil {
		return err
	}
	if err := be.del(ctx, name); err != nil && !errors.Is(err, errSecretNotFound) {
		return err
	}
	return l.updateRecords(func(m map[string]localRecord) { delete(m, name) })
}

// localBackend keeps values for the local store.
type localBackend interface {
	kind() string
	put(ctx context.Context, name, value string) error
	get(ctx context.Context, name string) (string, error)
	del(ctx context.Context, name string) error
}

const localTimeout = 15 * time.Second

// runQuiet runs a backend's program with input on stdin and no terminal,
// and gives back what it printed. Errors carry the program's message,
// which never holds a value: values only go in on stdin.
func runQuiet(ctx context.Context, bin string, stdin string, args ...string) (string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, localTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		err = fmt.Errorf("%s timed out", filepath.Base(bin))
	}
	return stdout.String(), strings.TrimSpace(stderr.String()), err
}

// keychainBackend is the login Keychain, through macOS's security command.
type keychainBackend struct{ bin string }

func (k *keychainBackend) kind() string { return backendKeychain }

func (k *keychainBackend) put(ctx context.Context, name, value string) error {
	// security's interactive mode reads its commands from stdin, so the
	// value never shows in a process list; -X takes it as hex, so no
	// quoting can break it.
	line := fmt.Sprintf("add-generic-password -U -a %s -s %s -l Shipyard:%s -X %s\n", name, localService, name, hex.EncodeToString([]byte(value)))
	_, stderr, err := runQuiet(ctx, k.bin, line, "-i")
	if err != nil {
		return fmt.Errorf("the Keychain did not save %s: %s", name, firstNonEmptyStr(stderr, err.Error()))
	}
	// Interactive mode exits 0 whatever its commands did.
	if _, stderr, err := runQuiet(ctx, k.bin, "", "find-generic-password", "-a", name, "-s", localService); err != nil {
		return fmt.Errorf("the Keychain did not save %s: %s", name, firstNonEmptyStr(stderr, "it is locked or refused"))
	}
	return nil
}

func (k *keychainBackend) get(ctx context.Context, name string) (string, error) {
	out, stderr, err := runQuiet(ctx, k.bin, "", "find-generic-password", "-a", name, "-s", localService, "-w")
	if err != nil {
		if strings.Contains(stderr, "could not be found") {
			return "", fmt.Errorf("%s is not in the Keychain", name)
		}
		return "", fmt.Errorf("the Keychain did not give %s: %s", name, firstNonEmptyStr(stderr, err.Error()))
	}
	return strings.TrimSuffix(out, "\n"), nil
}

func (k *keychainBackend) del(ctx context.Context, name string) error {
	_, stderr, err := runQuiet(ctx, k.bin, "", "delete-generic-password", "-a", name, "-s", localService)
	if err != nil {
		if strings.Contains(stderr, "could not be found") {
			return errSecretNotFound
		}
		return fmt.Errorf("the Keychain did not delete %s: %s", name, firstNonEmptyStr(stderr, err.Error()))
	}
	return nil
}

// secretServiceBackend is the session bus's Secret Service, through
// libsecret's secret-tool.
type secretServiceBackend struct{ bin string }

func (s *secretServiceBackend) kind() string { return backendSecretService }

func (s *secretServiceBackend) put(ctx context.Context, name, value string) error {
	_, stderr, err := runQuiet(ctx, s.bin, value, "store", "--label=Shipyard: "+name, "service", localService, "name", name)
	if err != nil {
		return fmt.Errorf("the Secret Service did not save %s: %s", name, firstNonEmptyStr(stderr, err.Error()))
	}
	return nil
}

func (s *secretServiceBackend) get(ctx context.Context, name string) (string, error) {
	out, stderr, err := runQuiet(ctx, s.bin, "", "lookup", "service", localService, "name", name)
	if err != nil {
		if stderr == "" {
			return "", fmt.Errorf("%s is not in the Secret Service", name)
		}
		return "", fmt.Errorf("the Secret Service did not give %s: %s", name, stderr)
	}
	return out, nil
}

func (s *secretServiceBackend) del(ctx context.Context, name string) error {
	_, stderr, err := runQuiet(ctx, s.bin, "", "clear", "service", localService, "name", name)
	if err != nil && stderr != "" {
		return fmt.Errorf("the Secret Service did not delete %s: %s", name, stderr)
	}
	return nil
}

// secretServiceAnswers says whether a Secret Service answers on the
// session bus: a lookup that finds nothing exits 1 saying nothing, while
// one with no bus or no service says why. A locked keyring that would ask
// for a password, with no one to type it, times out the same as none.
func secretServiceAnswers(ctx context.Context, bin string) bool {
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		if rt := os.Getenv("XDG_RUNTIME_DIR"); rt == "" {
			return false
		} else if _, err := os.Stat(filepath.Join(rt, "bus")); err != nil {
			return false
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "lookup", "service", localService, "probe", "berth")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		return false
	}
	var ee *exec.ExitError
	return err == nil || (errors.As(err, &ee) && ee.ExitCode() == 1 && strings.TrimSpace(stderr.String()) == "")
}

// fileBackend keeps values encrypted in one file, with the key in another.
type fileBackend struct {
	dir     string
	keyPath string
}

func (f *fileBackend) kind() string { return backendFile }

func (f *fileBackend) valuesPath() string { return filepath.Join(f.dir, "values.json") }

var fileMu sync.Mutex

// key reads the key, making it the first time.
func (f *fileBackend) key(create bool) ([]byte, error) {
	b, err := os.ReadFile(f.keyPath)
	if err == nil {
		if len(b) != chacha20poly1305.KeySize {
			return nil, fmt.Errorf("%s is not a key", f.keyPath)
		}
		return b, nil
	}
	if !os.IsNotExist(err) || !create {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(f.keyPath), 0o700); err != nil {
		return nil, err
	}
	k := make([]byte, chacha20poly1305.KeySize)
	if _, err := io.ReadFull(rand.Reader, k); err != nil {
		return nil, err
	}
	out, err := os.OpenFile(f.keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if os.IsExist(err) {
		return f.key(false)
	}
	if err != nil {
		return nil, err
	}
	if _, err := out.Write(k); err != nil {
		out.Close()
		os.Remove(f.keyPath)
		return nil, err
	}
	return k, out.Close()
}

func (f *fileBackend) values() map[string]string {
	m := map[string]string{}
	if b, err := os.ReadFile(f.valuesPath()); err == nil {
		json.Unmarshal(b, &m)
	}
	return m
}

func (f *fileBackend) write(fn func(map[string]string)) error {
	fileMu.Lock()
	defer fileMu.Unlock()
	if err := os.MkdirAll(f.dir, 0o700); err != nil {
		return err
	}
	os.Chmod(f.dir, 0o700)
	unlock, err := statefile.Lock(f.valuesPath())
	if err != nil {
		return err
	}
	defer unlock()
	m := f.values()
	fn(m)
	b, _ := json.MarshalIndent(m, "", "  ")
	return statefile.Write(f.valuesPath(), b)
}

func (f *fileBackend) put(ctx context.Context, name, value string) error {
	k, err := f.key(true)
	if err != nil {
		return fmt.Errorf("the box's secret key: %w", err)
	}
	aead, err := chacha20poly1305.NewX(k)
	if err != nil {
		return err
	}
	nonce := make([]byte, aead.NonceSize(), aead.NonceSize()+len(value)+aead.Overhead())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}
	// The name is bound in, so a value can't be passed off as another's.
	sealed := aead.Seal(nonce, nonce, []byte(value), []byte(name))
	return f.write(func(m map[string]string) { m[name] = base64.StdEncoding.EncodeToString(sealed) })
}

func (f *fileBackend) get(ctx context.Context, name string) (string, error) {
	enc, ok := f.values()[name]
	if !ok {
		return "", fmt.Errorf("%s is not in the box's encrypted file", name)
	}
	k, err := f.key(false)
	if err != nil {
		return "", fmt.Errorf("the box's secret key: %w", err)
	}
	aead, err := chacha20poly1305.NewX(k)
	if err != nil {
		return "", err
	}
	sealed, err := base64.StdEncoding.DecodeString(enc)
	if err != nil || len(sealed) < aead.NonceSize() {
		return "", fmt.Errorf("%s is damaged in the box's encrypted file", name)
	}
	v, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], []byte(name))
	if err != nil {
		return "", fmt.Errorf("%s does not decrypt with the box's key", name)
	}
	return string(v), nil
}

func (f *fileBackend) del(ctx context.Context, name string) error {
	if _, ok := f.values()[name]; !ok {
		return errSecretNotFound
	}
	return f.write(func(m map[string]string) { delete(m, name) })
}
