package box

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/cosscom/shipyard/internal/statefile"
)

// Attention items are what needs a person, kept on the box so every app
// and computer paired with it reads the same list: an ask an agent posts
// (a decision, an action, something to review), and a person's marks on
// items a plugin builds from the box's own signals (a waiting agent, a run's
// gate), such as a snooze or "resolved". Plugin storage is per computer, so
// without this a snooze on one laptop is news to the other.
//
// An item is named by its key. Posting to a key replaces what is there and
// counts its revision on, so an agent replaces its own ask instead of adding
// another; an agent's post without a key is keyed by its session. An item
// settles when it is answered or closed, or by itself when its session ends,
// and a settled item is forgotten 14 days later.
//
// "Attention" is a working name: the box's inbox already means prompts held
// for an agent (inbox.go).

// AttentionItem is one item.
type AttentionItem struct {
	Key string `json:"key"`
	// Revision counts every change from 1, so a client can tell an item
	// changed, and refuse to overwrite a change it hasn't seen.
	Revision int `json:"revision"`
	// Kind is what it is ("decision", "action", "review", "blocked", …, the
	// poster's own word), or "mark" for a person's mark on an item built
	// from signals.
	Kind        string            `json:"kind"`
	Title       string            `json:"title,omitempty"`
	Details     string            `json:"details,omitempty"`
	Options     []AttentionOption `json:"options,omitempty"`
	Recommended string            `json:"recommended,omitempty"`
	// Status is open, answered or closed; the last two are settled.
	Status       string    `json:"status"`
	Answer       string    `json:"answer,omitempty"`
	ClosedReason string    `json:"closed_reason,omitempty"`
	SnoozedUntil time.Time `json:"snoozed_until,omitzero"`
	// Session, when set, is the session it is about: it settles when that
	// session ends.
	Session string `json:"session,omitempty"`
	// By is the origin of the last change ("app", "phone", an agent's tool,
	// "berth" for the box itself).
	By      string    `json:"by,omitempty"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
	Settled time.Time `json:"settled,omitzero"`
}

// AttentionBrief is an item as the phone API and `berthd mcp` read it: what
// it is and where it stands, without its details, answer or closing words,
// which stay on the box's own API like an event leaves them out.
type AttentionBrief struct {
	Key          string            `json:"key"`
	Revision     int               `json:"revision"`
	Kind         string            `json:"kind"`
	Title        string            `json:"title,omitempty"`
	Options      []AttentionOption `json:"options,omitempty"`
	Recommended  string            `json:"recommended,omitempty"`
	Status       string            `json:"status"`
	SnoozedUntil time.Time         `json:"snoozed_until,omitzero"`
	Session      string            `json:"session,omitempty"`
	Created      time.Time         `json:"created"`
	Updated      time.Time         `json:"updated"`
}

// Brief is the item without its words.
func (it AttentionItem) Brief() AttentionBrief {
	return AttentionBrief{
		Key: it.Key, Revision: it.Revision, Kind: it.Kind, Title: it.Title, Options: slices.Clone(it.Options), Recommended: it.Recommended,
		Status: it.Status, SnoozedUntil: it.SnoozedUntil, Session: it.Session, Created: it.Created, Updated: it.Updated,
	}
}

// AttentionBriefs is items without their words.
func AttentionBriefs(items []AttentionItem) []AttentionBrief {
	out := make([]AttentionBrief, 0, len(items))
	for _, it := range items {
		out = append(out, it.Brief())
	}
	return out
}

// AttentionOption is one of the answers an ask offers.
type AttentionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// AttentionPost is a new ask, or one that replaces the ask at its key.
type AttentionPost struct {
	Key         string            `json:"key,omitempty"`
	Kind        string            `json:"kind"`
	Title       string            `json:"title"`
	Details     string            `json:"details,omitempty"`
	Options     []AttentionOption `json:"options,omitempty"`
	Recommended string            `json:"recommended,omitempty"`
	Session     string            `json:"session,omitempty"`
	// Revision, when set, is the revision the poster last read: the post is
	// refused if the item has changed since (0 replaces whatever is there).
	Revision int `json:"revision,omitempty"`
}

// AttentionUpdate changes an item; what it leaves out stays as it is. An
// update to a key with no item makes a mark there.
type AttentionUpdate struct {
	Revision     int     `json:"revision,omitempty"`
	Status       *string `json:"status,omitempty"`
	Answer       *string `json:"answer,omitempty"`
	ClosedReason *string `json:"closed_reason,omitempty"`
	// SnoozedUntil is an RFC 3339 time; "" ends a snooze.
	SnoozedUntil *string `json:"snoozed_until,omitempty"`
	// Session is the session a new mark is about. It is ignored on an item
	// that exists.
	Session string `json:"session,omitempty"`
}

const (
	AttentionOpen     = "open"
	AttentionAnswered = "answered"
	AttentionClosed   = "closed"

	// attentionMark is the kind of a mark on an item the box doesn't hold.
	attentionMark = "mark"
	// attentionSessionEnded is the closed_reason of an item whose session
	// ended while it was open.
	attentionSessionEnded = "session_ended"
)

// AttentionKeep is how long a settled item is kept.
const AttentionKeep = 14 * 24 * time.Hour

const (
	maxAttentionItems   = 1000
	maxAttentionKey     = 300
	maxAttentionTitle   = 300
	maxAttentionText    = 16 << 10
	maxAttentionOptions = 12
	maxAttentionLabel   = 200
	maxAttentionOptDesc = 1000
	maxAttentionSession = 200
)

var (
	errAttentionRevision = httpError{http.StatusConflict, "the item changed since that revision; read it again"}
	errAttentionFull     = httpError{http.StatusTooManyRequests, fmt.Sprintf("the box already holds %d open attention items; settle some first", maxAttentionItems)}
	attentionWord        = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
)

// AttentionStore keeps the box's items in one state file.
type AttentionStore struct {
	Path string
	// Now is the clock; nil is time.Now.
	Now func() time.Time

	mu     sync.Mutex
	items  map[string]*AttentionItem
	loaded bool
	// missing names the sessions of open items that the last sweep didn't
	// find. A session is taken to have ended only when two sweeps in a row
	// miss it, so one listing that came back short settles nothing.
	missing map[string]bool
}

func (s *AttentionStore) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

// load reads the file once. It holds s.mu. A file it can't read now fails
// the call, and the next call tries again: starting empty would have the
// next change write over every item. A file that isn't JSON is set aside
// as attention.json.corrupt-<time>, for someone to look at, and the store
// starts empty. An item kept past its time is left behind as it is read.
func (s *AttentionStore) load() error {
	if s.loaded {
		return nil
	}
	items := map[string]*AttentionItem{}
	b, err := os.ReadFile(s.Path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return fmt.Errorf("the box can't read its attention items: %w", err)
	default:
		var all []AttentionItem
		if err := json.Unmarshal(b, &all); err != nil {
			aside := fmt.Sprintf("%s.corrupt-%d", s.Path, s.now().Unix())
			if err := os.Rename(s.Path, aside); err != nil {
				return fmt.Errorf("the box's attention items aren't JSON, and couldn't be set aside: %w", err)
			}
			break
		}
		now := s.now()
		for i := range all {
			it := all[i]
			if it.Key == "" || expired(it, now) {
				continue
			}
			items[it.Key] = &it
		}
	}
	s.items, s.loaded = items, true
	return nil
}

func (s *AttentionStore) save() error {
	all := make([]AttentionItem, 0, len(s.items))
	for _, it := range s.items {
		all = append(all, *it)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Key < all[j].Key })
	b, err := json.Marshal(all)
	if err != nil {
		return err
	}
	return statefile.Write(s.Path, b)
}

// expired says an item is over and can be forgotten: settled more than
// AttentionKeep ago, or an open mark nobody has touched in that long whose
// snooze, if any, has run out.
func expired(it AttentionItem, now time.Time) bool {
	cut := now.Add(-AttentionKeep)
	if it.Status != AttentionOpen {
		return !it.Settled.IsZero() && it.Settled.Before(cut)
	}
	return it.Kind == attentionMark && it.Session == "" && it.Updated.Before(cut) && !it.SnoozedUntil.After(now)
}

// AttentionFilter narrows List.
type AttentionFilter struct {
	Session string
	// Open leaves settled items out.
	Open bool
}

// List returns the items, the most recently changed first.
func (s *AttentionStore) List(f AttentionFilter) ([]AttentionItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return nil, err
	}
	out := []AttentionItem{}
	for _, it := range s.items {
		if f.Session != "" && it.Session != f.Session || f.Open && it.Status != AttentionOpen {
			continue
		}
		out = append(out, cloneAttention(*it))
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Updated.Equal(out[j].Updated) {
			return out[i].Updated.After(out[j].Updated)
		}
		return out[i].Key < out[j].Key
	})
	return out, nil
}

// Get returns one item; ok is false when there is none at key.
func (s *AttentionStore) Get(key string) (it AttentionItem, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return AttentionItem{}, false, err
	}
	p, ok := s.items[key]
	if !ok {
		return AttentionItem{}, false, nil
	}
	return cloneAttention(*p), true, nil
}

// SessionKey is the key of a session's own ask.
func SessionKey(session string) string { return "session:" + session }

// KeyOrSession is the post's key: the one it names, or its session's.
func (p AttentionPost) KeyOrSession() string {
	if p.Key == "" && p.Session != "" {
		return SessionKey(p.Session)
	}
	return p.Key
}

// slot finds the item at key for a change, refusing one made from a
// revision that has gone by, and makes room when there is no item yet. It
// holds s.mu.
func (s *AttentionStore) slot(key string, revision int) (*AttentionItem, error) {
	was := s.items[key]
	if revision != 0 && (was == nil || was.Revision != revision) {
		return nil, errAttentionRevision
	}
	if was == nil {
		return nil, s.makeRoom()
	}
	return was, nil
}

// commit puts it at its key and saves, putting back what was there (nil:
// nothing) when the save fails. It holds s.mu.
func (s *AttentionStore) commit(it, was *AttentionItem) error {
	s.items[it.Key] = it
	if err := s.save(); err != nil {
		if was != nil {
			s.items[it.Key] = was
		} else {
			delete(s.items, it.Key)
		}
		return err
	}
	return nil
}

// Post puts an ask at its key, replacing the one there: it opens again with
// a new revision, and its answer and snooze are gone.
func (s *AttentionStore) Post(p AttentionPost, by string) (AttentionItem, error) {
	p.Key = p.KeyOrSession()
	if err := checkAttentionPost(p); err != nil {
		return AttentionItem{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return AttentionItem{}, err
	}
	now := s.now()
	was, err := s.slot(p.Key, p.Revision)
	if err != nil {
		return AttentionItem{}, err
	}
	it := &AttentionItem{
		Key: p.Key, Revision: 1, Kind: p.Kind, Title: p.Title, Details: p.Details, Options: p.Options,
		Recommended: p.Recommended, Status: AttentionOpen, Session: p.Session, By: by, Created: now, Updated: now,
	}
	if was != nil {
		it.Revision, it.Created = was.Revision+1, was.Created
	}
	if err := s.commit(it, was); err != nil {
		return AttentionItem{}, err
	}
	return cloneAttention(*it), nil
}

// Update changes the item at key, or makes a mark there when there is
// none.
func (s *AttentionStore) Update(key string, u AttentionUpdate, by string) (AttentionItem, error) {
	if err := checkAttentionKey(key); err != nil {
		return AttentionItem{}, err
	}
	var until time.Time
	if u.SnoozedUntil != nil && *u.SnoozedUntil != "" {
		t, err := time.Parse(time.RFC3339, *u.SnoozedUntil)
		if err != nil {
			return AttentionItem{}, badRequest("snoozed_until must be an RFC 3339 time, or \"\" to end the snooze")
		}
		until = t.UTC()
	}
	if u.Status != nil && *u.Status != AttentionOpen && *u.Status != AttentionAnswered && *u.Status != AttentionClosed {
		return AttentionItem{}, badRequest("status must be open, answered or closed")
	}
	if u.Answer != nil && len(*u.Answer) > maxAttentionText {
		return AttentionItem{}, badRequest("an answer may be %d KB", maxAttentionText>>10)
	}
	if u.ClosedReason != nil && *u.ClosedReason != "" && !attentionWord.MatchString(*u.ClosedReason) {
		return AttentionItem{}, badRequest("closed_reason is a short word: lowercase letters, digits, - and _")
	}
	if err := checkAttentionSession(u.Session); err != nil {
		return AttentionItem{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return AttentionItem{}, err
	}
	now := s.now()
	was, err := s.slot(key, u.Revision)
	if err != nil {
		return AttentionItem{}, err
	}
	next := AttentionItem{Key: key, Kind: attentionMark, Status: AttentionOpen, Session: u.Session, Created: now}
	if was != nil {
		next = cloneAttention(*was)
	}
	if u.Answer != nil {
		next.Answer = *u.Answer
	}
	if u.ClosedReason != nil {
		next.ClosedReason = *u.ClosedReason
	}
	status := next.Status
	switch {
	case u.Status != nil:
		status = *u.Status
	case u.Answer != nil && *u.Answer != "":
		status = AttentionAnswered
	case u.ClosedReason != nil && *u.ClosedReason != "":
		status = AttentionClosed
	}
	if status != next.Status {
		next.Settled = now
	}
	next.Status = status
	switch status {
	case AttentionOpen:
		next.Answer, next.ClosedReason, next.Settled = "", "", time.Time{}
	case AttentionAnswered:
		next.ClosedReason = ""
	case AttentionClosed:
		if next.ClosedReason == "" {
			next.ClosedReason = "resolved"
		}
	}
	if u.SnoozedUntil != nil {
		next.SnoozedUntil = until
	}
	next.Revision++
	next.By, next.Updated = by, now
	if err := s.commit(&next, was); err != nil {
		return AttentionItem{}, err
	}
	return cloneAttention(next), nil
}

// makeRoom keeps the store to maxAttentionItems before a new key: the
// longest-settled items go first, and with none settled the new one is
// refused. It holds s.mu.
func (s *AttentionStore) makeRoom() error {
	if len(s.items) < maxAttentionItems {
		return nil
	}
	var oldest *AttentionItem
	for _, it := range s.items {
		if it.Status != AttentionOpen && (oldest == nil || it.Settled.Before(oldest.Settled)) {
			oldest = it
		}
	}
	if oldest == nil {
		return errAttentionFull
	}
	delete(s.items, oldest.Key)
	return nil
}

// Sweep settles the open items whose session has ended, given live, the
// sessions a listing taken at the time at found, and forgets items past
// their time. It returns the items it settled. It is the backstop for a
// session that ends without saying so (its program exits); SettleSession
// is the prompt way for one that was stopped.
//
// A session counts as ended when this sweep and the last both missed it,
// each with a listing taken after the item last changed: one posted after
// a listing may be about a session it never saw.
func (s *AttentionStore) Sweep(live map[string]bool, at time.Time) []AttentionItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	missing := map[string]bool{}
	settled := s.settle(func(it *AttentionItem) bool {
		// A listing from before the item's last change says nothing of it.
		if live[it.Session] || !it.Updated.Before(at) {
			return false
		}
		missing[it.Session] = true
		return s.missing[it.Session]
	}, true)
	s.missing = missing
	return settled
}

// SettleSession settles the open items about a session that was stopped.
func (s *AttentionStore) SettleSession(name string) []AttentionItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settle(func(it *AttentionItem) bool { return it.Session == name }, false)
}

// settle closes the open items with a session that ended says has ended,
// and with forget drops items past their time. It is all or nothing: the
// items change only once the file holds the change, so nothing is
// announced that a restart would undo, and a failed write is tried again
// by the next sweep. It holds s.mu.
func (s *AttentionStore) settle(ended func(*AttentionItem) bool, forget bool) []AttentionItem {
	if s.load() != nil {
		return nil
	}
	now := s.now()
	next := make(map[string]*AttentionItem, len(s.items))
	var settled []AttentionItem
	changed := false
	for key, it := range s.items {
		if it.Status == AttentionOpen && it.Session != "" && ended(it) {
			c := cloneAttention(*it)
			c.Status, c.ClosedReason, c.Settled = AttentionClosed, attentionSessionEnded, now
			c.Revision++
			c.By, c.Updated = "berth", now
			settled = append(settled, cloneAttention(c))
			it, changed = &c, true
		}
		if forget && expired(*it, now) {
			changed = true
			continue
		}
		next[key] = it
	}
	if !changed {
		return nil
	}
	was := s.items
	s.items = next
	if err := s.save(); err != nil {
		s.items = was
		return nil
	}
	sort.Slice(settled, func(i, j int) bool { return settled[i].Key < settled[j].Key })
	return settled
}

func cloneAttention(it AttentionItem) AttentionItem {
	it.Options = slices.Clone(it.Options)
	return it
}

func checkAttentionSession(name string) error {
	if len(name) > maxAttentionSession {
		return badRequest("that isn't a session name")
	}
	return nil
}

func checkAttentionKey(key string) error {
	if key == "" || len(key) > maxAttentionKey || strings.TrimSpace(key) != key || strings.IndexFunc(key, unicode.IsControl) >= 0 || !utf8.ValidString(key) {
		return badRequest("a key is 1 to %d characters, with no control characters or surrounding spaces", maxAttentionKey)
	}
	return nil
}

func checkAttentionPost(p AttentionPost) error {
	if p.Key == "" {
		return badRequest("a post needs a key or a session")
	}
	if err := checkAttentionKey(p.Key); err != nil {
		return err
	}
	if !attentionWord.MatchString(p.Kind) || p.Kind == attentionMark {
		return badRequest("kind is a short word (decision, action, review, blocked, …): lowercase letters, digits, - and _; mark is the box's own")
	}
	if strings.TrimSpace(p.Title) == "" || utf8.RuneCountInString(p.Title) > maxAttentionTitle {
		return badRequest("a post needs a title of at most %d characters", maxAttentionTitle)
	}
	if len(p.Details) > maxAttentionText {
		return badRequest("details may be %d KB", maxAttentionText>>10)
	}
	if err := checkAttentionSession(p.Session); err != nil {
		return err
	}
	if len(p.Options) > maxAttentionOptions {
		return badRequest("an ask offers at most %d options", maxAttentionOptions)
	}
	seen := map[string]bool{}
	for _, o := range p.Options {
		if strings.TrimSpace(o.Label) == "" || utf8.RuneCountInString(o.Label) > maxAttentionLabel || utf8.RuneCountInString(o.Description) > maxAttentionOptDesc {
			return badRequest("each option needs a label of at most %d characters, and a description of at most %d", maxAttentionLabel, maxAttentionOptDesc)
		}
		if seen[o.Label] {
			return badRequest("two options are labelled %q", o.Label)
		}
		seen[o.Label] = true
	}
	if p.Recommended != "" && !seen[p.Recommended] {
		return badRequest("recommended must be one of the options' labels")
	}
	return nil
}
