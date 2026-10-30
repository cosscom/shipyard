package box

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// The GCP store keeps values in Google Cloud Secret Manager, in a project
// the box's settings name, with the credentials the box's gcloud already
// has. berthd never changes a project's IAM: a missing permission fails on
// the card, naming it. It only ever writes to secrets it labelled itself
// (shipyard=true): one by that name without the label is refused, not
// given a new version.
//
//	secretmanager.secrets.create, .get, .list    save and list
//	secretmanager.versions.add, .access          save and read
//	secretmanager.secrets.delete                 delete
//	secretmanager.secrets.setIamPolicy           --grant only

func init() {
	registerSecretStore(&secretProvider{
		ID: "gcp", Scheme: "gcp", Name: "GCP Secret Manager",
		Caps:        StoreCaps{Expiry: true, Labels: true, Grant: true},
		NeedsWhere:  true,
		ValidateRef: validateGCPRef,
		WhereOf: func(ref string) string {
			if m := gcpRef.FindStringSubmatch(ref); m != nil {
				return m[1]
			}
			return ""
		},
		Open: func(env StoreEnv) SecretStore { return &gcpStore{env: env} },
	})
}

var (
	gcpProjectID = regexp.MustCompile(`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`)
	gcpRef       = regexp.MustCompile(`^gcp://projects/([a-z][a-z0-9-]{4,28}[a-z0-9])/secrets/([A-Za-z0-9_-]{1,255})(?:/versions/(latest|[0-9]+))?$`)
	gcpDenied    = regexp.MustCompile(`Permission '([a-zA-Z.]+)' denied`)
	gcpLabelBad  = regexp.MustCompile(`[^a-z0-9_-]+`)
	saEmail      = regexp.MustCompile(`^[a-z0-9-]{1,63}@[a-z0-9-]+\.iam\.gserviceaccount\.com$`)
)

func validateGCPRef(ref string) error {
	if !gcpRef.MatchString(ref) {
		return fmt.Errorf("%q is not a Secret Manager reference; they look like gcp://projects/PROJECT/secrets/NAME", ref)
	}
	return nil
}

// ValidateServiceAccount says whether s is a service account's email.
func ValidateServiceAccount(s string) error {
	if !saEmail.MatchString(s) {
		return fmt.Errorf("%q is not a service account; they look like name@project.iam.gserviceaccount.com", s)
	}
	return nil
}

type gcpStore struct {
	env StoreEnv
}

func (g *gcpStore) Label() string { return "GCP Secret Manager" }

func (g *gcpStore) ref(id string) string {
	return "gcp://projects/" + g.env.Where + "/secrets/" + id
}

// gcloud runs one gcloud command against the store's project, never
// asking, with stdin for a value. denied is the permission that command
// needs, named when gcloud's own message doesn't.
func (g *gcpStore) gcloud(ctx context.Context, denied, stdin string, args ...string) (string, error) {
	bin, err := g.env.bin("gcloud")
	if err != nil {
		return "", errors.New("gcloud is not installed on this box: Secret Manager is read and written with it")
	}
	args = append(args, "--project="+g.env.Where, "--quiet")
	out, stderr, err := runQuiet(ctx, bin, stdin, args...)
	if err == nil {
		return out, nil
	}
	return "", gcloudError(stderr, err, denied, g.env.Where)
}

// gcloudError says what went wrong, naming a missing permission.
func gcloudError(stderr string, err error, denied, project string) error {
	switch {
	case strings.Contains(stderr, "NOT_FOUND"):
		return errSecretNotFound
	case gcpDenied.MatchString(stderr):
		return fmt.Errorf("missing permission %s on project %s", gcpDenied.FindStringSubmatch(stderr)[1], project)
	case strings.Contains(stderr, "PERMISSION_DENIED") && denied != "":
		return fmt.Errorf("missing permission %s on project %s", denied, project)
	case strings.Contains(stderr, "gcloud auth login") || strings.Contains(stderr, "credentials"):
		return errors.New("gcloud isn't signed in on this box: run gcloud auth login there")
	}
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	msg := strings.TrimPrefix(strings.TrimSpace(lines[len(lines)-1]), "ERROR: ")
	if msg == "" {
		msg = err.Error()
	}
	return fmt.Errorf("gcloud: %s", msg)
}

type gcpSecret struct {
	Name       string            `json:"name"`
	Labels     map[string]string `json:"labels"`
	CreateTime time.Time         `json:"createTime"`
}

func (s gcpSecret) ours() bool { return s.Labels["shipyard"] == "true" }

func (g *gcpStore) describe(ctx context.Context, id string) (gcpSecret, error) {
	out, err := g.gcloud(ctx, "secretmanager.secrets.get", "", "secrets", "describe", id, "--format=json")
	if err != nil {
		return gcpSecret{}, err
	}
	var s gcpSecret
	if err := json.Unmarshal([]byte(out), &s); err != nil {
		return gcpSecret{}, fmt.Errorf("gcloud described %s in a way berthd can't read", id)
	}
	return s, nil
}

// gcpLabel is a value as a label holds it: lowercase letters, digits, _
// and -, at most 63.
func gcpLabel(v string) string {
	v = strings.Trim(gcpLabelBad.ReplaceAllString(strings.ToLower(v), "-"), "-")
	if len(v) > 63 {
		v = v[:63]
	}
	return v
}

func (g *gcpStore) Save(ctx context.Context, s SecretSave) (string, error) {
	if !secretName.MatchString(s.Name) {
		return "", fmt.Errorf("%q is not a secret name", s.Name)
	}
	if s.Grant != "" {
		if err := ValidateServiceAccount(s.Grant); err != nil {
			return "", err
		}
	}
	existing, err := g.describe(ctx, s.Name)
	switch {
	case errors.Is(err, errSecretNotFound):
		env := firstNonEmptyStr(s.Environment, "staging")
		labels := []string{"shipyard=true", "shipyard-environment=" + gcpLabel(env)}
		if l := gcpLabel(s.Location); l != "" {
			labels = append(labels, "shipyard-location="+l)
		}
		if l := gcpLabel(g.env.Box); l != "" {
			labels = append(labels, "shipyard-box="+l)
		}
		if _, err := g.gcloud(ctx, "secretmanager.secrets.create", "", "secrets", "create", s.Name, "--replication-policy=automatic", "--labels="+strings.Join(labels, ",")); err != nil {
			return "", err
		}
	case err != nil:
		return "", err
	case !existing.ours():
		return "", fmt.Errorf("project %s already has a secret called %s that Shipyard didn't make (it has no shipyard label), so it was left alone: pick another name, or label it shipyard=true to let Shipyard add versions", g.env.Where, s.Name)
	}
	if _, err := g.gcloud(ctx, "secretmanager.versions.add", s.Value, "secrets", "versions", "add", s.Name, "--data-file=-"); err != nil {
		return "", err
	}
	if s.Grant != "" {
		if _, err := g.gcloud(ctx, "secretmanager.secrets.setIamPolicy", "", "secrets", "add-iam-policy-binding", s.Name, "--member=serviceAccount:"+s.Grant, "--role=roles/secretmanager.secretAccessor"); err != nil {
			return "", fmt.Errorf("saved %s, but could not grant %s: %w", s.Name, s.Grant, err)
		}
	}
	return g.ref(s.Name), nil
}

func (g *gcpStore) Resolve(ctx context.Context, ref string) (string, error) {
	m := gcpRef.FindStringSubmatch(ref)
	if m == nil {
		return "", validateGCPRef(ref)
	}
	version := firstNonEmptyStr(m[3], "latest")
	out, err := g.gcloud(ctx, "secretmanager.versions.access", "", "secrets", "versions", "access", version, "--secret="+m[2])
	if errors.Is(err, errSecretNotFound) {
		return "", fmt.Errorf("%s has no such version in project %s", m[2], m[1])
	}
	return out, err
}

func (g *gcpStore) List(ctx context.Context) ([]SecretMeta, error) {
	out, err := g.gcloud(ctx, "secretmanager.secrets.list", "", "secrets", "list", "--filter=labels.shipyard=true", "--format=json")
	if err != nil {
		return nil, err
	}
	var all []gcpSecret
	if err := json.Unmarshal([]byte(out), &all); err != nil {
		return nil, errors.New("gcloud listed secrets in a way berthd can't read")
	}
	var metas []SecretMeta
	for _, s := range all {
		if !s.ours() {
			continue
		}
		id := s.Name[strings.LastIndex(s.Name, "/")+1:]
		metas = append(metas, SecretMeta{Name: id, Ref: g.ref(id), Store: "gcp", StoreLabel: g.Label(), Where: g.env.Where, Environment: s.Labels["shipyard-environment"], Location: s.Labels["shipyard-location"], Created: s.CreateTime})
	}
	return metas, nil
}

func (g *gcpStore) Delete(ctx context.Context, ref string) error {
	m := gcpRef.FindStringSubmatch(ref)
	if m == nil {
		return validateGCPRef(ref)
	}
	s, err := g.describe(ctx, m[2])
	if err != nil {
		return err
	}
	if !s.ours() {
		return fmt.Errorf("%s in project %s isn't one Shipyard made (no shipyard label): delete it in the console", m[2], m[1])
	}
	_, err = g.gcloud(ctx, "secretmanager.secrets.delete", "", "secrets", "delete", m[2])
	return err
}
