// Package team reads a team setup: a GitHub org's <org>/.berth repository,
// whose team.json (schema berth.team/v1) says what an engineer's box needs
// once (the box steps, run by the team's own script, as the engineer, in a
// terminal they can see) and which repositories to clone, each set up by its
// own .berth/config.json or by a kit the team setup names. Under the hood
// it is a workspace kit; the app calls it Team setup.
//
// This package only parses, validates and compares team setups. The laptop
// reads them through the gh CLI (internal/agent) and the box runs them
// (internal/box).
package team

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/cosscom/shipyard/internal/agentcli"
)

// Schema is the only team.json schema this build reads.
const Schema = "berth.team/v1"

// File is where a team setup lives inside <org>/.berth.
const File = "team.json"

// Repo is the repository an org publishes its team setup in.
const Repo = ".berth"

// GitHubStep is the step Shipyard adds after the team's own: the box signs in
// to GitHub with its own gh, so it has a credential of its own to clone
// with, which can be revoked on its own.
const GitHubStep = "github"

// AgentsStep is the step Shipyard adds after the team's own when a team setup
// names agents: it installs those agent CLIs on the box, as the engineer,
// without sudo, and their hooks and skills (berthd agents install).
const AgentsStep = "agents"

// OnePasswordStep is the step Shipyard adds after GitHub when a team setup's
// keys read 1Password (op:// references): the box's own op is signed in, in
// the terminal, by the engineer, so berthd can read the shared keys
// without ever asking in a service's terminal.
const OnePasswordStep = "1password"

// SettingEnvPrefix starts the environment variable each box.settings entry
// reaches the box script as: BERTH_SETTING_<NAME>.
const SettingEnvPrefix = "BERTH_SETTING_"

// Setup is team.json.
type Setup struct {
	Schema      string `json:"schema"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Org         string `json:"org"`
	Description string `json:"description,omitempty"`
	// Contact is where to ask for help or access, in the team's words
	// ("#eng-onboarding on Slack").
	Contact string `json:"contact,omitempty"`
	Docs    string `json:"docs,omitempty"`
	Box     Box    `json:"box"`
	// Agents are the agent CLIs every engineer's box gets ("claude",
	// "codex", "cursor", "opencode", "grok"), installed by Shipyard as a
	// step of its own. Signing in to each stays the engineer's.
	Agents   []string  `json:"agents,omitempty"`
	Projects []Project `json:"projects"`
	Keys     KeySet    `json:"keys,omitempty"`
	// OnePassword says whether engineers may skip 1Password for the shared
	// keys: "optional" (the default) lets them type each key once instead,
	// or leave it blank; "required" means the box must sign op in.
	OnePassword string  `json:"onepassword,omitempty"`
	Updates     Updates `json:"updates"`
}

// 1Password policies (team.json's "onepassword").
const (
	OnePasswordOptional = "optional"
	OnePasswordRequired = "required"
)

// RequiresOnePassword reports whether the shared keys can only come from
// 1Password: the team says so, and there are op:// references to read.
func (s *Setup) RequiresOnePassword() bool {
	return s.OnePassword == OnePasswordRequired && s.UsesOnePassword()
}

// Box is what a box needs once, before any repository.
type Box struct {
	// OS lists the systems the script supports ("ubuntu>=22.04"); shown,
	// not enforced: the script checks for itself.
	OS []string `json:"os,omitempty"`
	// Script, a path inside .berth, takes the subcommands all, <step>,
	// check <step> (exit 0 when the step is done) and plan.
	Script string `json:"script,omitempty"`
	Steps  []Step `json:"steps,omitempty"`
	// Settings are values the team keeps in one place for its script
	// (versions, ports): each reaches the script as BERTH_SETTING_<NAME>
	// in its environment. Strings only; entries starting with "$" are
	// comments.
	Settings Settings `json:"settings,omitempty"`
}

// Settings are box.settings, by name.
type Settings map[string]string

func (st *Settings) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return fmt.Errorf("box.settings must be an object of names and strings")
	}
	*st = Settings{}
	for name, v := range raw {
		if strings.HasPrefix(name, "$") {
			continue
		}
		var one string
		if err := json.Unmarshal(v, &one); err != nil {
			return fmt.Errorf("box.settings.%s must be a string (\"%s\"), not %s", name, strings.Trim(string(v), `"`), string(v))
		}
		(*st)[name] = one
	}
	return nil
}

// Env is the settings as the box script's environment, sorted.
func (st Settings) Env() []string {
	out := make([]string, 0, len(st))
	for _, name := range sortedKeys(st) {
		out = append(out, SettingEnvPrefix+name+"="+st[name])
	}
	return out
}

// Step is one subcommand of the box script.
type Step struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
	// Sudo says the step asks for the engineer's password: sudo prompts in
	// the terminal, they type it, and Shipyard never sees or keeps it.
	Sudo bool `json:"sudo,omitempty"`
}

// Project is a repository to clone and set up.
type Project struct {
	ID   string `json:"id"`
	Repo string `json:"repo"`
	// Path is where it is cloned on the box; default ~/code/<id>.
	Path     string `json:"path,omitempty"`
	Required bool   `json:"required,omitempty"`
	// Kit sets the repository up when it has no .berth/config.json of its
	// own: a kit link pinned to a commit ("https://github.com/o/kit@7f93797")
	// or a folder inside .berth ("./projects/api").
	Kit string `json:"kit,omitempty"`
	// Init, a script inside .berth, runs once in the fresh clone.
	Init       string `json:"init,omitempty"`
	InitDetail string `json:"init_detail,omitempty"`
	// FirstTask is a task the team suggests to start with.
	FirstTask string `json:"first_task,omitempty"`
}

// Keys says where a project's keys come from. Values never live in git:
// shared keys are secret references (op://…) read on the box with the
// engineer's own 1Password, and keys each engineer has their own of are
// asked for once and kept on their box.
type Keys struct {
	// From is the repository's file that lists the keys it reads
	// (".env.example").
	From   string            `json:"from,omitempty"`
	Shared map[string]string `json:"shared,omitempty"`
	Ask    []string          `json:"ask,omitempty"`
}

// KeySet is each project's keys, by project id. Entries starting with "$"
// are comments.
type KeySet map[string]Keys

func (k *KeySet) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*k = KeySet{}
	for id, v := range raw {
		if strings.HasPrefix(id, "$") {
			continue
		}
		var one Keys
		if err := json.Unmarshal(v, &one); err != nil {
			return fmt.Errorf("keys.%s: %w", id, err)
		}
		(*k)[id] = one
	}
	return nil
}

// Updates says how a newer commit of .berth reaches engineers. It never
// runs by itself: it is shown as an update to review.
type Updates struct {
	Notify *bool `json:"notify,omitempty"`
}

// NotifyUpdates reports whether newer commits are offered (the default).
func (s *Setup) NotifyUpdates() bool { return s.Updates.Notify == nil || *s.Updates.Notify }

var (
	idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)
	// A project's id names its location on the box, which is part of each
	// worktree's URL (<worktree>.<project>.<box>.localhost): one DNS label.
	projectPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$`)
	settingPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
	stepPattern    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	repoPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$`)
	orgPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)
	keyPattern     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	refPattern     = regexp.MustCompile(`^(op|env)://[^\n\r]+$`)
	reservedSteps  = map[string]bool{"all": true, "check": true, "plan": true, GitHubStep: true, OnePasswordStep: true, AgentsStep: true}
)

// ValidOrg reports whether s can be a GitHub org or user name.
func ValidOrg(s string) bool { return orgPattern.MatchString(s) }

// ValidRepo reports whether s is "owner/name".
func ValidRepo(s string) bool { return repoPattern.MatchString(s) && !strings.HasSuffix(s, ".git") }

// Parse reads team.json and validates it. Warnings are things that do not
// stop it running, such as fields this build does not know.
func Parse(data []byte) (*Setup, []string, error) {
	var s Setup
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&s); err != nil {
		return nil, nil, fmt.Errorf("%s: %w", File, err)
	}
	warnings := unknownFields(data)
	if err := s.Validate(); err != nil {
		return nil, warnings, err
	}
	return &s, warnings, nil
}

// known lists the fields of each object in team.json, for warnings.
var known = map[string][]string{
	"":        {"schema", "id", "name", "org", "description", "contact", "docs", "box", "agents", "projects", "keys", "onepassword", "updates"},
	"box":     {"os", "script", "steps", "settings"},
	"step":    {"id", "title", "detail", "sudo"},
	"project": {"id", "repo", "path", "required", "kit", "init", "init_detail", "first_task"},
	"keys":    {"from", "shared", "ask"},
	"updates": {"notify"},
}

func unknownFields(data []byte) []string {
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		return nil
	}
	var out []string
	check := func(where, kind string, obj map[string]json.RawMessage) {
		for k := range obj {
			if strings.HasPrefix(k, "$") || contains(known[kind], k) {
				continue
			}
			out = append(out, fmt.Sprintf("%s: %q is not a field this version of Shipyard knows; it is ignored", where, k))
		}
	}
	check("team.json", "", raw)
	var box struct {
		Steps []map[string]json.RawMessage `json:"steps"`
	}
	if b, ok := raw["box"]; ok {
		var obj map[string]json.RawMessage
		if json.Unmarshal(b, &obj) == nil {
			check("box", "box", obj)
		}
		json.Unmarshal(b, &box)
		for i, st := range box.Steps {
			check(fmt.Sprintf("box.steps[%d]", i), "step", st)
		}
	}
	var projects []map[string]json.RawMessage
	if json.Unmarshal(raw["projects"], &projects) == nil {
		for i, p := range projects {
			check(fmt.Sprintf("projects[%d]", i), "project", p)
		}
	}
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw["keys"], &keys) == nil {
		for id, k := range keys {
			var obj map[string]json.RawMessage
			if !strings.HasPrefix(id, "$") && json.Unmarshal(k, &obj) == nil {
				check("keys."+id, "keys", obj)
			}
		}
	}
	var updates map[string]json.RawMessage
	if json.Unmarshal(raw["updates"], &updates) == nil {
		check("updates", "updates", updates)
	}
	sort.Strings(out)
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// InsidePath cleans a path that must stay inside .berth ("box/setup.sh",
// "./projects/api"), or says why it does not.
func InsidePath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("empty path")
	}
	if strings.ContainsRune(p, '\\') || strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("%q must be a path inside .berth", p)
	}
	c := path.Clean(p)
	if c == "." || c == ".." || strings.HasPrefix(c, "../") {
		return "", fmt.Errorf("%q must be a path inside .berth", p)
	}
	return c, nil
}

// Validate checks a team setup, naming the first problem.
func (s *Setup) Validate() error {
	if s.Schema != Schema {
		if s.Schema == "" {
			return fmt.Errorf(`team.json has no "schema"; this version of Shipyard reads %q`, Schema)
		}
		return fmt.Errorf("team.json is %q; this version of Shipyard reads %q (a newer one may read it)", s.Schema, Schema)
	}
	if !idPattern.MatchString(s.ID) {
		return fmt.Errorf("id %q must be lowercase letters, digits and dashes", s.ID)
	}
	if strings.TrimSpace(s.Name) == "" {
		return fmt.Errorf("name is empty")
	}
	if !ValidOrg(s.Org) {
		return fmt.Errorf("org %q is not a GitHub org name", s.Org)
	}
	if len(s.Box.Steps) > 0 && s.Box.Script == "" {
		return fmt.Errorf("box has steps but no script to run them")
	}
	if s.Box.Script != "" {
		if _, err := InsidePath(s.Box.Script); err != nil {
			return fmt.Errorf("box.script: %v", err)
		}
	}
	if err := s.Box.Settings.Validate(); err != nil {
		return err
	}
	seen := map[string]bool{}
	for i, st := range s.Box.Steps {
		if !stepPattern.MatchString(st.ID) {
			return fmt.Errorf("box.steps[%d]: id %q must be lowercase letters, digits and dashes, starting with a letter", i, st.ID)
		}
		if reservedSteps[st.ID] {
			return fmt.Errorf("box.steps[%d]: %q is reserved (all, check, plan, agents, github and 1password are not step names)", i, st.ID)
		}
		if seen[st.ID] {
			return fmt.Errorf("box.steps: %q is there twice", st.ID)
		}
		seen[st.ID] = true
		if strings.TrimSpace(st.Title) == "" {
			return fmt.Errorf("box.steps[%d] (%s) has no title", i, st.ID)
		}
	}
	switch s.OnePassword {
	case "", OnePasswordOptional, OnePasswordRequired:
	default:
		return fmt.Errorf(`onepassword is %q; it is "optional" (the default: engineers may type the shared keys instead) or "required"`, s.OnePassword)
	}
	if _, err := agentcli.ParseList(strings.Join(s.Agents, ",")); err != nil {
		return fmt.Errorf("agents: %v", err)
	}
	for _, a := range s.Agents {
		if a == "none" || strings.ContainsAny(a, ", ") {
			return fmt.Errorf("agents: %q is not an agent id (claude, codex, cursor, opencode, grok)", a)
		}
	}
	ids, repos := map[string]bool{}, map[string]bool{}
	for i, p := range s.Projects {
		where := fmt.Sprintf("projects[%d]", i)
		if !projectPattern.MatchString(p.ID) {
			return fmt.Errorf("%s: id %q can't be part of a URL: it names the project on the box, and each worktree's URL is <worktree>.<project>.<box>.localhost, so use lowercase letters, digits and dashes (%q, with \"path\": \"~/code/%s\" to keep the folder's name)", where, p.ID, URLSafeName(p.ID), p.ID)
		}
		if ids[p.ID] {
			return fmt.Errorf("projects: %q is there twice", p.ID)
		}
		ids[p.ID] = true
		if !ValidRepo(p.Repo) {
			return fmt.Errorf("%s (%s): repo %q must be owner/name on GitHub", where, p.ID, p.Repo)
		}
		if repos[strings.ToLower(p.Repo)] {
			return fmt.Errorf("projects: %s is there twice", p.Repo)
		}
		repos[strings.ToLower(p.Repo)] = true
		if p.Path != "" {
			if !strings.HasPrefix(p.Path, "~/") && !strings.HasPrefix(p.Path, "/") {
				return fmt.Errorf("%s (%s): path %q must start with ~/ or /", where, p.ID, p.Path)
			}
			if c := path.Clean(p.Path); c == "/" || c == "~" || strings.Contains(p.Path, "..") {
				return fmt.Errorf("%s (%s): path %q is not a folder to clone into", where, p.ID, p.Path)
			}
		}
		if p.Kit != "" {
			if _, err := ParseKitRef(p.Kit); err != nil {
				return fmt.Errorf("%s (%s): kit: %v", where, p.ID, err)
			}
		}
		if p.Init != "" {
			if _, err := InsidePath(p.Init); err != nil {
				return fmt.Errorf("%s (%s): init: %v", where, p.ID, err)
			}
		}
	}
	for id, k := range s.Keys {
		if strings.HasPrefix(id, "$") {
			continue
		}
		if !ids[id] {
			return fmt.Errorf("keys: %q is not one of the projects", id)
		}
		if k.From != "" {
			if _, err := InsidePath(k.From); err != nil {
				return fmt.Errorf("keys.%s.from: %v", id, err)
			}
		}
		for name, ref := range k.Shared {
			if !keyPattern.MatchString(name) {
				return fmt.Errorf("keys.%s.shared: %q is not an environment variable name", id, name)
			}
			if !refPattern.MatchString(ref) {
				// A value here would be a secret in git.
				return fmt.Errorf("keys.%s.shared.%s must be a secret reference (op://vault/item/field or env://NAME), never a value", id, name)
			}
		}
		for _, name := range k.Ask {
			if !keyPattern.MatchString(name) {
				return fmt.Errorf("keys.%s.ask: %q is not an environment variable name", id, name)
			}
			if _, both := k.Shared[name]; both {
				return fmt.Errorf("keys.%s: %s is both shared and asked for", id, name)
			}
		}
	}
	return nil
}

// maxSettings bounds box.settings; each is an environment variable.
const maxSettings = 64

func (st Settings) Validate() error {
	if len(st) > maxSettings {
		return fmt.Errorf("box.settings has %d entries; at most %d", len(st), maxSettings)
	}
	for _, name := range sortedKeys(st) {
		if !settingPattern.MatchString(name) {
			return fmt.Errorf("box.settings: %q is not a setting name (letters, digits and _, not starting with a digit); it becomes %s<NAME> in the script's environment", name, SettingEnvPrefix)
		}
		v := st[name]
		if len(v) > 4096 {
			return fmt.Errorf("box.settings.%s is longer than 4096 bytes", name)
		}
		for _, r := range v {
			if r < 0x20 && r != '\t' || r == 0x7f {
				return fmt.Errorf("box.settings.%s has a control character (a newline?); settings are one line", name)
			}
		}
	}
	return nil
}

// URLSafeName turns a name into one that can be part of a URL's host
// (a DNS label): lowercase letters, digits and dashes, "acme.com" →
// "acme-com". It returns "" when nothing is left.
func URLSafeName(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.TrimRight(b.String(), "-")
	if len(out) > 48 {
		out = strings.TrimRight(out[:48], "-")
	}
	return out
}

// ValidProjectID reports whether id can name a project: one URL label.
func ValidProjectID(id string) bool { return projectPattern.MatchString(id) }

// UsesOnePassword reports whether any project's shared keys are 1Password
// references, so the box needs op signed in (unless the engineer skips
// 1Password, where the team allows it, and types the keys instead).
func (s *Setup) UsesOnePassword() bool {
	for id, k := range s.Keys {
		if strings.HasPrefix(id, "$") {
			continue
		}
		for _, ref := range k.Shared {
			if strings.HasPrefix(ref, "op://") {
				return true
			}
		}
	}
	return false
}

// IsOnePasswordRef reports whether a shared key's reference is 1Password's.
func IsOnePasswordRef(ref string) bool { return strings.HasPrefix(ref, "op://") }

// ProjectPath is where p is cloned: its path, or ~/code/<id>.
func (p Project) ProjectPath() string {
	if p.Path != "" {
		return p.Path
	}
	return "~/code/" + p.ID
}

// SudoSteps counts the steps that ask for a password.
func (s *Setup) SudoSteps() int {
	n := 0
	for _, st := range s.Box.Steps {
		if st.Sudo {
			n++
		}
	}
	return n
}

// Project finds a project by id.
func (s *Setup) Project(id string) (Project, bool) {
	for _, p := range s.Projects {
		if p.ID == id {
			return p, true
		}
	}
	return Project{}, false
}

// KitRef is a project's kit: a folder inside .berth, or a link with the
// commit it is pinned to.
type KitRef struct {
	// Path is set for a kit kept in .berth.
	Path string `json:"path,omitempty"`
	// Link is the kit's link without its ref; Ref is the commit (or tag)
	// after "@".
	Link string `json:"link,omitempty"`
	Ref  string `json:"ref,omitempty"`
	// Owner, Name and Sub are set for a kit in a GitHub repository, which
	// is read through gh at Ref.
	Owner string `json:"owner,omitempty"`
	Name  string `json:"name,omitempty"`
	Sub   string `json:"sub,omitempty"`
}

var (
	githubKit = regexp.MustCompile(`^(?:https://)?github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+?)(?:\.git)?(?:/tree/([^/]+)(?:/(.+))?)?(?:@([A-Za-z0-9._/-]+))?$`)
	commitRef = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
)

// ParseKitRef reads a project's kit field.
func ParseKitRef(s string) (KitRef, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "./") || strings.HasPrefix(s, "../") || (!strings.Contains(s, "://") && !strings.HasPrefix(s, "github.com/") && !strings.HasPrefix(s, "/")) {
		p, err := InsidePath(s)
		if err != nil {
			return KitRef{}, err
		}
		return KitRef{Path: p}, nil
	}
	if m := githubKit.FindStringSubmatch(s); m != nil {
		ref := m[5]
		if ref == "" {
			ref = m[3]
		}
		if ref == "" {
			return KitRef{}, fmt.Errorf("%q is not pinned: add @<commit>, so every engineer gets the kit that was reviewed", s)
		}
		k := KitRef{Owner: m[1], Name: m[2], Sub: strings.Trim(m[4], "/"), Ref: ref, Link: "https://github.com/" + m[1] + "/" + m[2]}
		if k.Sub != "" {
			k.Link += "/tree/" + ref + "/" + k.Sub
		}
		return k, nil
	}
	if !strings.HasPrefix(s, "https://") {
		return KitRef{}, fmt.Errorf("%q is neither a folder inside .berth nor an https link", s)
	}
	link, ref := s, ""
	if i := strings.LastIndex(s, "@"); i > len("https://") {
		link, ref = s[:i], s[i+1:]
	}
	if ref == "" {
		return KitRef{}, fmt.Errorf("%q is not pinned: add @<commit>, so every engineer gets the kit that was reviewed", s)
	}
	return KitRef{Link: link, Ref: ref}, nil
}

// IsCommit reports whether the ref is a commit hash rather than a branch.
func (k KitRef) IsCommit() bool { return commitRef.MatchString(k.Ref) }

// String writes the ref back as team.json has it.
func (k KitRef) String() string {
	if k.Path != "" {
		return "./" + k.Path
	}
	if k.Owner != "" {
		s := "https://github.com/" + k.Owner + "/" + k.Name
		if k.Sub != "" {
			s += "/tree/" + k.Ref + "/" + k.Sub
			return s
		}
		return s + "@" + k.Ref
	}
	return k.Link + "@" + k.Ref
}

// EnvKeys reads the variable names an .env.example sets, in order.
func EnvKeys(data []byte) []string {
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		name, _, ok := strings.Cut(line, "=")
		name = strings.TrimSpace(name)
		if !ok || !keyPattern.MatchString(name) || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}
