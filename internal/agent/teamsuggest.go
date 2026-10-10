package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/statefile"
	"github.com/cosscom/shipyard/internal/team"
)

// Team suggestions: someone who added acme/web to Shipyard by hand is told
// that acme publishes a team setup, quietly, to review when they like.
//
// The laptop collects the GitHub owners of the projects on its paired boxes
// (each project's origin remote; other hosts are left out) and asks GitHub,
// with this computer's own gh, whether <owner>/.berth holds a team.json it
// can read: one request per owner, which also says whether the owner is an
// org or a person. An owner is asked again at most once a day, a person's
// account at most once a week, and a new owner as soon as a project of
// theirs appears. Owners whose setup was accepted, or which the person
// turned down, are never asked. Nothing is asked offline, and a failure is
// silent and tried again later. Only when a setup lists the person's own
// repositories are those repositories' kits read, once per commit of
// team.json, to say what the setup brings them. Nothing is sent anywhere
// but GitHub, and nothing is set up until the person reviews it on the Team
// setup page.

const (
	suggestOrgEvery  = 24 * time.Hour
	suggestUserEvery = 7 * 24 * time.Hour
	// The first round waits for the boxes to answer; a new project (or a
	// box coming back) brings the next one forward, after a moment.
	suggestFirst  = time.Minute
	suggestSettle = 5 * time.Second
	suggestEvery  = 30 * time.Minute
	// After a failure (offline, signed out, rate limited), no owner is
	// asked until a wait that starts here and doubles.
	suggestRetryBase = 15 * time.Minute
	suggestRetryMax  = 6 * time.Hour
	// At most this many owners are asked per round, and kits read per
	// setup.
	suggestPerRound = 25
	suggestKitReads = 8
)

// EventTeamSuggestions says the team suggestions changed: the app reads
// the status again.
const EventTeamSuggestions = "team.suggestions"

// TeamSuggestion is an org that publishes a team setup the person hasn't
// accepted, with their projects from that org.
type TeamSuggestion struct {
	Org string `json:"org"`
	// Name is the setup's own name ("Acme").
	Name string `json:"name"`
	// Repo is where it lives: "<org>/.berth".
	Repo     string               `json:"repo"`
	Projects []TeamSuggestProject `json:"projects"`
}

// TeamSuggestProject is one of the person's projects from a suggested org.
type TeamSuggestProject struct {
	Box      string `json:"box"`
	Location string `json:"location"`
	Repo     string `json:"repo"`
	// Listed says team.json names the repository; SetsUp is what its setup
	// brings, in a few words ("per-worktree databases", "services",
	// "Log in as…", "review links").
	Listed bool     `json:"listed"`
	SetsUp []string `json:"sets_up"`
	// Kit says team.json gives the repository a kit, which can be taken on
	// its own (teamkit.go); KitApplied that the project follows it already.
	Kit        bool `json:"kit"`
	KitApplied bool `json:"kit_applied,omitempty"`
}

// suggestOwner is what the last request said about an owner.
type suggestOwner struct {
	Login   string    `json:"login"`
	Checked time.Time `json:"checked"`
	// Personal is a person's account rather than an org.
	Personal bool   `json:"personal,omitempty"`
	Found    bool   `json:"found,omitempty"`
	Name     string `json:"name,omitempty"`
	// OID is team.json's blob: kits are read again only when it changes.
	OID string `json:"oid,omitempty"`
	// Repos are the repositories team.json lists, by lower-case owner/name.
	Repos map[string]suggestRepo `json:"repos,omitempty"`
}

type suggestRepo struct {
	// Kit is what the setup's kit brings a clone without a
	// .berth/config.json of its own; Team is what team.json adds itself.
	Kit     []string `json:"kit,omitempty"`
	Team    []string `json:"team,omitempty"`
	KitRead bool     `json:"kit_read,omitempty"`
	HasKit  bool     `json:"has_kit,omitempty"`
}

// suggestFile is kept at <state>/team/suggest.json.
type suggestFile struct {
	Owners    map[string]*suggestOwner `json:"owners"`
	Dismissed map[string]time.Time     `json:"dismissed"`
}

// suggestLoc is a project on a box whose origin is on GitHub.
type suggestLoc struct {
	Box  string
	Name string
	Repo string
	// OwnConfig: the clone has its own .berth/config.json, which wins over
	// a team setup's kit.
	OwnConfig bool
	// KitTeam is the org whose team kit the project follows, if any.
	KitTeam string
}

type teamSuggest struct {
	mu      sync.Mutex
	loaded  bool
	file    suggestFile
	locs    map[string][]suggestLoc
	fails   int
	retryAt time.Time
	list    []TeamSuggestion
	// Tests replace these: the projects on the boxes, and whether this
	// computer is on a network at all.
	locate func(ctx context.Context) map[string][]suggestLoc
	online func() bool
}

func (a *Agent) now() time.Time {
	if a.cfg.Now != nil {
		return a.cfg.Now()
	}
	return time.Now()
}

func (a *Agent) suggestPath() string { return filepath.Join(a.teamDir(), "suggest.json") }

func (a *Agent) suggestLoadLocked() {
	s := &a.suggest
	if !s.loaded {
		s.loaded = true
		if b, err := os.ReadFile(a.suggestPath()); err == nil {
			json.Unmarshal(b, &s.file)
		}
	}
	if s.file.Owners == nil {
		s.file.Owners = map[string]*suggestOwner{}
	}
	if s.file.Dismissed == nil {
		s.file.Dismissed = map[string]time.Time{}
	}
}

func (a *Agent) suggestSaveLocked() {
	b, err := json.MarshalIndent(a.suggest.file, "", "  ")
	if err != nil {
		return
	}
	p := a.suggestPath()
	if os.MkdirAll(filepath.Dir(p), 0o700) == nil {
		statefile.Write(p, append(b, '\n'))
	}
}

// TeamSuggestions is the current list, for the status and the app.
func (a *Agent) TeamSuggestions() []TeamSuggestion {
	a.suggest.mu.Lock()
	defer a.suggest.mu.Unlock()
	out := make([]TeamSuggestion, len(a.suggest.list))
	copy(out, a.suggest.list)
	return out
}

// watchTeamSuggestions runs a round now and then, and soon after a project
// is added or a box comes back. A round asks GitHub only about owners that
// are due.
func (a *Agent) watchTeamSuggestions(ctx context.Context) {
	poke := make(chan struct{}, 1)
	stop := a.bus.Observe(func(e Event) {
		if e.Type == "location.added" || e.Type == EventBoxConnected {
			select {
			case poke <- struct{}{}:
			default:
			}
		}
	})
	defer stop()
	timer := time.NewTimer(suggestFirst)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-poke:
			timer.Reset(suggestSettle)
			continue
		case <-timer.C:
		}
		a.suggestRound(ctx)
		timer.Reset(suggestEvery)
	}
}

// suggestRound reads the boxes' projects, asks GitHub about the owners
// that are due, and works the suggestions out again.
func (a *Agent) suggestRound(ctx context.Context) {
	s := &a.suggest
	locate := s.locate
	if locate == nil {
		locate = a.suggestLocations
	}
	locs := locate(ctx)
	skip := a.acceptedOrgs()
	now := a.now()

	s.mu.Lock()
	a.suggestLoadLocked()
	s.locs = locs
	due := a.dueOwnersLocked(now, skip)
	mine := map[string]map[string]bool{}
	for _, list := range s.locs {
		for _, l := range list {
			o := ownerOf(l.Repo)
			if mine[o] == nil {
				mine[o] = map[string]bool{}
			}
			mine[o][strings.ToLower(l.Repo)] = true
		}
	}
	prev := map[string]*suggestOwner{}
	for _, o := range due {
		prev[o] = s.file.Owners[o]
	}
	waiting := now.Before(s.retryAt)
	s.mu.Unlock()

	if len(due) > 0 && !waiting && a.suggestOnline() {
		if g, err := newGH(); err == nil {
			for _, owner := range due {
				res, err := checkTeamOwner(ctx, g, owner, prev[owner], mine[owner], now)
				s.mu.Lock()
				if err != nil {
					// Offline, signed out or rate limited: the same for
					// every owner, so the round ends, and no one hears of it.
					s.fails++
					s.retryAt = now.Add(backoff(s.fails, suggestRetryBase, suggestRetryMax))
					s.mu.Unlock()
					break
				}
				s.fails, s.retryAt = 0, time.Time{}
				s.file.Owners[owner] = res
				s.mu.Unlock()
			}
			s.mu.Lock()
			a.suggestSaveLocked()
			s.mu.Unlock()
		}
	}
	a.rebuildSuggestions(skip)
}

func (a *Agent) suggestOnline() bool {
	if a.suggest.online != nil {
		return a.suggest.online()
	}
	return hasNetwork()
}

// hasNetwork says whether this computer has a network a request could
// leave by: an interface that is up, not loopback and not a tunnel (a VPN's
// stays up offline), with an address beyond its link.
func hasNetwork() bool {
	ifs, err := net.Interfaces()
	if err != nil {
		return true
	}
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, ad := range addrs {
			if n, ok := ad.(*net.IPNet); ok && n.IP.IsGlobalUnicast() {
				return true
			}
		}
	}
	return false
}

// acceptedOrgs are the owners whose team setup this laptop accepted, in
// lower case: never suggested, never asked about.
func (a *Agent) acceptedOrgs() map[string]bool {
	out := map[string]bool{}
	for _, t := range a.allAccepted() {
		out[strings.ToLower(t.Org)] = true
	}
	return out
}

func ownerOf(repo string) string {
	o, _, _ := strings.Cut(repo, "/")
	return strings.ToLower(o)
}

// dueOwnersLocked lists the owners to ask now: never asked, or asked more
// than a day ago (a week for a person's account), leaving out those
// accepted or dismissed.
func (a *Agent) dueOwnersLocked(now time.Time, skip map[string]bool) []string {
	s := &a.suggest
	seen := map[string]bool{}
	var due []string
	for _, list := range s.locs {
		for _, l := range list {
			o := ownerOf(l.Repo)
			if seen[o] || skip[o] || !team.ValidOrg(o) {
				continue
			}
			seen[o] = true
			if _, no := s.file.Dismissed[o]; no {
				continue
			}
			prev := s.file.Owners[o]
			every := suggestOrgEvery
			if prev != nil && prev.Personal {
				every = suggestUserEvery
			}
			if prev == nil || now.Sub(prev.Checked) >= every {
				due = append(due, o)
			}
		}
	}
	sort.Strings(due)
	if len(due) > suggestPerRound {
		due = due[:suggestPerRound]
	}
	return due
}

// suggestQuery asks, in one request, what kind of account owner is and for
// <owner>/.berth's team.json, when this account can read it.
const suggestQuery = `query($owner: String!) { repositoryOwner(login: $owner) { __typename login repository(name: ".berth") { object(expression: "HEAD:team.json") { ... on Blob { oid text } } } } }`

// checkTeamOwner asks GitHub about one owner. A missing owner, repository
// or team.json is an answer, not an error; so is a team.json that doesn't
// parse or names another org, which is not suggested.
func checkTeamOwner(ctx context.Context, g ghCLI, owner string, prev *suggestOwner, mine map[string]bool, now time.Time) (*suggestOwner, error) {
	var res struct {
		RepositoryOwner *struct {
			Typename   string `json:"__typename"`
			Login      string `json:"login"`
			Repository *struct {
				Object *struct {
					OID  string  `json:"oid"`
					Text *string `json:"text"`
				} `json:"object"`
			} `json:"repository"`
		} `json:"repositoryOwner"`
	}
	if err := g.graphql(ctx, suggestQuery, map[string]string{"owner": owner}, &res); err != nil {
		return nil, err
	}
	o := &suggestOwner{Login: owner, Checked: now}
	ro := res.RepositoryOwner
	if ro == nil {
		// No such account (renamed, say): no more often than a person's.
		o.Personal = true
		return o, nil
	}
	o.Login, o.Personal = ro.Login, ro.Typename == "User"
	if ro.Repository == nil || ro.Repository.Object == nil || ro.Repository.Object.Text == nil {
		return o, nil
	}
	setup, _, err := team.Parse([]byte(*ro.Repository.Object.Text))
	if err != nil || !strings.EqualFold(setup.Org, ro.Login) {
		return o, nil
	}
	o.Found, o.Name, o.OID = true, setup.Name, ro.Repository.Object.OID
	o.Repos = describeSetup(ctx, g, ro.Login, setup, o.OID, prev, mine)
	return o, nil
}

// describeSetup says what the setup brings each repository it lists. The
// kits of the person's own repositories are read, once per commit of
// team.json; nothing is read for the rest.
func describeSetup(ctx context.Context, g ghCLI, owner string, s *team.Setup, oid string, prev *suggestOwner, mine map[string]bool) map[string]suggestRepo {
	out := map[string]suggestRepo{}
	reads := 0
	for _, p := range s.Projects {
		key := strings.ToLower(p.Repo)
		r := suggestRepo{Team: teamWords(s, p), KitRead: p.Kit == "", HasKit: p.Kit != ""}
		if was, ok := prev.reposAt(oid)[key]; ok && was.KitRead {
			r.Kit, r.KitRead = was.Kit, true
		}
		if !r.KitRead && mine[key] && reads < suggestKitReads {
			reads++
			r.Kit, r.KitRead = kitWords(ctx, g, owner, p.Kit), true
		}
		out[key] = r
	}
	return out
}

// reposAt is what was said of each repository when team.json was at oid.
func (o *suggestOwner) reposAt(oid string) map[string]suggestRepo {
	if o == nil || o.OID != oid {
		return nil
	}
	return o.Repos
}

// kitWords reads a team setup's kit (from .berth itself, or a GitHub
// repository at its pinned commit) and says what it brings.
func kitWords(ctx context.Context, g ghCLI, owner, ref string) []string {
	kr, err := team.ParseKitRef(ref)
	if err != nil {
		return nil
	}
	var raw []byte
	switch {
	case kr.Path != "":
		raw, _, err = g.file(ctx, owner+"/"+team.Repo, path.Join(kr.Path, kitManifest), "")
	case kr.Owner != "":
		raw, _, err = g.file(ctx, kr.Owner+"/"+kr.Name, path.Join(kr.Sub, kitManifest), kr.Ref)
	default:
		return nil
	}
	if err != nil {
		return nil
	}
	var k box.Kit
	if json.Unmarshal(raw, &k) != nil {
		return nil
	}
	return configWords(k.Config)
}

var (
	dbEnv   = regexp.MustCompile(`(?i)(^|_)(DATABASE|DB|POSTGRES|PG|MYSQL|MONGO)(_|$)`)
	dbSetup = regexp.MustCompile(`(?i)\b(db|database|migrate|createdb|postgres|prisma)\b`)
)

// configWords says what a project config brings each worktree, generically.
func configWords(c box.RepoConfig) []string {
	var w []string
	db := dbSetup.MatchString(c.Setup)
	for k := range c.Env {
		db = db || dbEnv.MatchString(k)
	}
	switch {
	case db:
		w = append(w, "per-worktree databases")
	case c.Setup != "":
		w = append(w, "per-worktree setup")
	}
	if len(c.Services) > 0 {
		w = append(w, "services")
	}
	if c.Login != nil {
		w = append(w, "Log in as…")
	}
	if c.ReviewButton != nil && *c.ReviewButton {
		w = append(w, "review links")
	}
	return w
}

// teamWords is what team.json itself adds to a project.
func teamWords(s *team.Setup, p team.Project) []string {
	var w []string
	if p.ReviewButton {
		w = append(w, "review links")
	}
	if k, ok := s.Keys[p.ID]; ok && (len(k.Shared) > 0 || len(k.Ask) > 0) {
		w = append(w, "its keys")
	}
	if p.Init != "" {
		w = append(w, "a first-time setup")
	}
	return w
}

// rebuildSuggestions works the list out again from what is known, without
// asking anyone, and says so when it changed.
func (a *Agent) rebuildSuggestions(skip map[string]bool) {
	if skip == nil {
		skip = a.acceptedOrgs()
	}
	s := &a.suggest
	s.mu.Lock()
	a.suggestLoadLocked()
	list := a.buildSuggestionsLocked(skip)
	changed := !reflect.DeepEqual(list, s.list)
	s.list = list
	s.mu.Unlock()
	if changed {
		orgs := make([]string, len(list))
		for i, t := range list {
			orgs[i] = t.Org
		}
		a.publish(Event{Type: EventTeamSuggestions, Data: map[string]any{"orgs": orgs}})
	}
}

func (a *Agent) buildSuggestionsLocked(skip map[string]bool) []TeamSuggestion {
	s := &a.suggest
	boxes := make([]string, 0, len(s.locs))
	for b := range s.locs {
		boxes = append(boxes, b)
	}
	sort.Strings(boxes)
	by := map[string]*TeamSuggestion{}
	for _, b := range boxes {
		list := append([]suggestLoc{}, s.locs[b]...)
		sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
		for _, l := range list {
			o := ownerOf(l.Repo)
			if skip[o] {
				continue
			}
			if _, no := s.file.Dismissed[o]; no {
				continue
			}
			info := s.file.Owners[o]
			if info == nil || !info.Found {
				continue
			}
			ts := by[o]
			if ts == nil {
				login := info.Login
				if login == "" {
					login = o
				}
				ts = &TeamSuggestion{Org: login, Name: info.Name, Repo: login + "/" + team.Repo, Projects: []TeamSuggestProject{}}
				by[o] = ts
			}
			r, listed := info.Repos[strings.ToLower(l.Repo)]
			words := []string{}
			if !l.OwnConfig {
				words = append(words, r.Kit...)
			}
			for _, w := range r.Team {
				if !containsStr(words, w) {
					words = append(words, w)
				}
			}
			ts.Projects = append(ts.Projects, TeamSuggestProject{Box: b, Location: l.Name, Repo: l.Repo, Listed: listed, SetsUp: words, Kit: r.HasKit, KitApplied: r.HasKit && strings.EqualFold(l.KitTeam, o)})
		}
	}
	out := []TeamSuggestion{}
	for _, ts := range by {
		out = append(out, *ts)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Org) < strings.ToLower(out[j].Org) })
	return out
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// suggestLocations reads each online box's projects; a box that doesn't
// answer keeps the ones it had, and a box no longer paired drops out.
func (a *Agent) suggestLocations(ctx context.Context) map[string][]suggestLoc {
	type one struct {
		name   string
		online bool
	}
	a.mu.Lock()
	var boxes []one
	for name, st := range a.clients {
		boxes = append(boxes, one{name, st.status.State == StateOnline})
	}
	a.mu.Unlock()
	a.suggest.mu.Lock()
	prev := a.suggest.locs
	a.suggest.mu.Unlock()
	// Every box at once: one that is slow or away holds up no other.
	fresh := make([][]suggestLoc, len(boxes))
	fanOut(len(boxes), func(i int) {
		b := boxes[i]
		if !b.online {
			return
		}
		c, ok := a.client(b.name)
		if !ok {
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		var locs []box.Location
		if box.NewClient(c).Call(cctx, http.MethodGet, "/v1/locations", nil, &locs) == nil {
			fresh[i] = suggestLocs(b.name, locs)
		}
	})
	out := map[string][]suggestLoc{}
	for i, b := range boxes {
		if fresh[i] != nil {
			out[b.name] = fresh[i]
		} else if p, ok := prev[b.name]; ok {
			out[b.name] = p
		}
	}
	return out
}

func suggestLocs(boxName string, locs []box.Location) []suggestLoc {
	out := []suggestLoc{}
	for _, l := range locs {
		slug := box.GitHubSlug(l.Remote)
		if !l.Repo || slug == "" {
			continue
		}
		out = append(out, suggestLoc{Box: boxName, Name: l.Name, Repo: slug, OwnConfig: l.RepoTrust != "" && l.RepoTrust != "none", KitTeam: l.KitTeam})
	}
	return out
}

// dismissSuggestion turns an org's suggestion down for good (or, undo,
// takes that back).
func (a *Agent) dismissSuggestion(org string, undo bool) {
	o := strings.ToLower(org)
	a.suggest.mu.Lock()
	a.suggestLoadLocked()
	if undo {
		delete(a.suggest.file.Dismissed, o)
	} else {
		a.suggest.file.Dismissed[o] = a.now().UTC()
	}
	a.suggestSaveLocked()
	a.suggest.mu.Unlock()
	a.rebuildSuggestions(nil)
}

func (a *Agent) teamSuggestRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/team-suggestions", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.TeamSuggestions())
	})
	dismiss := func(undo bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			org := r.PathValue("org")
			if !team.ValidOrg(org) {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("%q is not a GitHub org", org))
				return
			}
			a.dismissSuggestion(org, undo)
			writeJSON(w, http.StatusOK, a.TeamSuggestions())
		}
	}
	mux.HandleFunc("POST /v1/team-suggestions/{org}/dismiss", dismiss(false))
	mux.HandleFunc("DELETE /v1/team-suggestions/{org}/dismiss", dismiss(true))
}

// graphql runs one GraphQL query through gh, with string variables, and
// decodes its data into out. gh exits non-zero when GitHub answers with
// errors, after printing the data: a repository that isn't there (or this
// account can't read) is one of those, NOT_FOUND, and is no error here.
func (g ghCLI) graphql(ctx context.Context, query string, vars map[string]string, out any) error {
	args := []string{"api", "graphql", "-f", "query=" + query}
	names := make([]string, 0, len(vars))
	for k := range vars {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		args = append(args, "-f", k+"="+vars[k])
	}
	stdout, stderr, runErr := g.run(ctx, args...)
	var resp struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	if json.Unmarshal(stdout, &resp) != nil || len(resp.Data) == 0 || string(resp.Data) == "null" {
		msg := firstLine(string(stderr))
		if msg == "" && runErr != nil {
			msg = runErr.Error()
		}
		if msg == "" {
			msg = "no answer"
		}
		return errors.New("gh api graphql: " + strings.TrimPrefix(msg, "gh: "))
	}
	for _, e := range resp.Errors {
		if e.Type != "NOT_FOUND" {
			return errors.New("gh api graphql: " + e.Message)
		}
	}
	return json.Unmarshal(resp.Data, out)
}
