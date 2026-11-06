package box

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
)

func newAttention(t *testing.T) (*AttentionStore, *clock) {
	clock := &clock{time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)}
	return &AttentionStore{Path: filepath.Join(t.TempDir(), "attention.json"), Now: clock.now}, clock
}

func listOf(t *testing.T, s *AttentionStore, f AttentionFilter) []AttentionItem {
	t.Helper()
	all, err := s.List(f)
	if err != nil {
		t.Fatal(err)
	}
	return all
}

func getOf(t *testing.T, s *AttentionStore, key string) (AttentionItem, bool) {
	t.Helper()
	it, ok, err := s.Get(key)
	if err != nil {
		t.Fatal(err)
	}
	return it, ok
}

func TestAnAgentReplacesItsOwnAskByKey(t *testing.T) {
	s, clock := newAttention(t)
	first, err := s.Post(AttentionPost{Session: "shop-claude", Kind: "decision", Title: "Which queue?", Options: []AttentionOption{{Label: "SQS"}, {Label: "Redis"}}, Recommended: "SQS"}, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if first.Key != "session:shop-claude" || first.Revision != 1 || first.Status != AttentionOpen || first.By != "claude" {
		t.Fatalf("first post = %+v", first)
	}
	// Someone snoozes it, then the agent asks again: the same item, a new
	// revision, open and no longer snoozed.
	if _, err := s.Update(first.Key, AttentionUpdate{SnoozedUntil: strp("2026-11-06T12:00:00Z")}, "app"); err != nil {
		t.Fatal(err)
	}
	clock.advance(time.Minute)
	second, err := s.Post(AttentionPost{Session: "shop-claude", Kind: "decision", Title: "Which queue, now that Redis is out?"}, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != 3 || second.Title != "Which queue, now that Redis is out?" || !second.SnoozedUntil.IsZero() || len(second.Options) != 0 || !second.Created.Equal(first.Created) || !second.Updated.After(first.Updated) {
		t.Fatalf("replaced = %+v", second)
	}
	if all := listOf(t, s, AttentionFilter{}); len(all) != 1 {
		t.Fatalf("a replaced ask is still one item: %+v", all)
	}
	// A post or an update naming a revision that has gone by is refused,
	// so a client never overwrites what it hasn't read.
	if _, err := s.Post(AttentionPost{Session: "shop-claude", Kind: "decision", Title: "stale", Revision: 2}, "claude"); statusFor(err) != http.StatusConflict {
		t.Fatalf("stale post: %v", err)
	}
	if _, err := s.Update(second.Key, AttentionUpdate{Revision: 1, Status: strp(AttentionClosed)}, "app"); statusFor(err) != http.StatusConflict {
		t.Fatalf("stale update: %v", err)
	}
	answered, err := s.Update(second.Key, AttentionUpdate{Revision: 3, Answer: strp("SQS")}, "phone")
	if err != nil {
		t.Fatal(err)
	}
	if answered.Status != AttentionAnswered || answered.Answer != "SQS" || answered.Revision != 4 || !answered.Settled.Equal(clock.t) || answered.By != "phone" {
		t.Fatalf("answered = %+v", answered)
	}
	if open := listOf(t, s, AttentionFilter{Open: true}); len(open) != 0 {
		t.Fatalf("an answered ask is settled: %+v", open)
	}
}

func TestAMarkOnAnItemTheBoxDoesntHold(t *testing.T) {
	s, _ := newAttention(t)
	key := "run/r_12/review" // a plugin's key for a run's gate, slashes and all
	m, err := s.Update(key, AttentionUpdate{SnoozedUntil: strp("2026-11-07T08:00:00+01:00")}, "app")
	if err != nil {
		t.Fatal(err)
	}
	if m.Kind != "mark" || m.Status != AttentionOpen || m.Revision != 1 || !m.SnoozedUntil.Equal(time.Date(2026, 11, 7, 7, 0, 0, 0, time.UTC)) {
		t.Fatalf("mark = %+v", m)
	}
	r, err := s.Update(key, AttentionUpdate{Status: strp(AttentionClosed)}, "app")
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != "mark" || r.Status != AttentionClosed || r.ClosedReason != "resolved" || r.Revision != 2 {
		t.Fatalf("resolved = %+v", r)
	}
	// Reopening clears what settled it; "" ends the snooze.
	o, _ := s.Update(key, AttentionUpdate{Status: strp(AttentionOpen), SnoozedUntil: strp("")}, "app")
	if o.Status != AttentionOpen || o.ClosedReason != "" || !o.Settled.IsZero() || !o.SnoozedUntil.IsZero() {
		t.Fatalf("reopened = %+v", o)
	}
	// A post may not pretend to be a mark, and words stay bounded.
	for _, p := range []AttentionPost{
		{Key: "x", Kind: "mark", Title: "t"},
		{Key: "x", Kind: "decision"},
		{Kind: "decision", Title: "no key"},
		{Key: " x", Kind: "decision", Title: "t"},
		{Key: "x", Kind: "decision", Title: "t", Recommended: "Maybe", Options: []AttentionOption{{Label: "Yes"}}},
		{Key: "x", Kind: "decision", Title: "t", Details: strings.Repeat("a", maxAttentionText+1)},
	} {
		if _, err := s.Post(p, "x"); statusFor(err) != http.StatusBadRequest {
			t.Fatalf("%+v: %v", p, err)
		}
	}
	if _, err := s.Update(key, AttentionUpdate{SnoozedUntil: strp("tomorrow")}, "app"); statusFor(err) != http.StatusBadRequest {
		t.Fatalf("a bad time: %v", err)
	}
}

func TestItemsSettleWhenTheirSessionEndsAndAgeOut(t *testing.T) {
	s, clock := newAttention(t)
	s.Post(AttentionPost{Session: "a", Kind: "decision", Title: "A?"}, "claude")
	s.Post(AttentionPost{Session: "b", Kind: "action", Title: "Run the migration"}, "claude")
	s.Update("standalone", AttentionUpdate{SnoozedUntil: strp("2026-11-30T00:00:00Z")}, "app")
	s.Update("session:b-done", AttentionUpdate{Session: "b", Status: strp(AttentionClosed)}, "app")
	// Each sweep's listing is taken a second after everything above.
	sweep := func(live map[string]bool) []AttentionItem { return s.Sweep(live, clock.t.Add(time.Second)) }

	// a ends; b still runs. One listing without a is not enough: the next
	// one settles it.
	if settled := sweep(map[string]bool{"b": true}); len(settled) != 0 {
		t.Fatalf("one listing settled %+v", settled)
	}
	settled := sweep(map[string]bool{"b": true})
	if len(settled) != 1 || settled[0].Key != "session:a" || settled[0].Status != AttentionClosed || settled[0].ClosedReason != "session_ended" || settled[0].By != "berth" || settled[0].Revision != 2 {
		t.Fatalf("settled = %+v", settled)
	}
	// Then b; an item settled already isn't settled twice.
	sweep(map[string]bool{})
	if again := sweep(map[string]bool{}); len(again) != 1 || again[0].Key != "session:b" {
		t.Fatalf("b's sweep = %+v", again)
	}
	if again := sweep(map[string]bool{}); len(again) != 0 {
		t.Fatalf("a further sweep = %+v", again)
	}
	if n := len(listOf(t, s, AttentionFilter{})); n != 4 {
		t.Fatalf("settled items are kept for a while: %d", n)
	}
	// 14 days on, the settled ones are gone. The snoozed mark stays until
	// its snooze has run out as well.
	clock.advance(AttentionKeep + time.Hour)
	sweep(nil)
	if all := listOf(t, s, AttentionFilter{}); len(all) != 1 || all[0].Key != "standalone" {
		t.Fatalf("after 14 days: %+v", all)
	}
	clock.advance(30 * 24 * time.Hour)
	sweep(nil)
	if all := listOf(t, s, AttentionFilter{}); len(all) != 0 {
		t.Fatalf("an old mark whose snooze ran out: %+v", all)
	}
}

// A sweep compares items with a listing of sessions taken a moment
// before: it settles nothing that listing couldn't have seen, and nothing
// on one listing that came back short.
func TestASweepSettlesOnlyWhatItsListingCouldHaveSeen(t *testing.T) {
	s, clock := newAttention(t)
	s.Post(AttentionPost{Session: "flaky", Kind: "decision", Title: "Still there?"}, "claude")
	listed := clock.t.Add(time.Second)
	s.Sweep(map[string]bool{}, listed) // a listing that missed flaky once
	if settled := s.Sweep(map[string]bool{"flaky": true}, listed); len(settled) != 0 {
		t.Fatalf("flaky is back: %+v", settled)
	}
	if settled := s.Sweep(map[string]bool{}, listed); len(settled) != 0 {
		t.Fatalf("missed once again, after it was back: %+v", settled)
	}

	// A session starts and posts after the listing was taken.
	s.Sweep(map[string]bool{"flaky": true}, listed)
	clock.advance(time.Minute)
	listed = clock.t
	clock.advance(time.Second)
	s.Post(AttentionPost{Session: "new", Kind: "decision", Title: "Which port?"}, "claude")
	s.Sweep(map[string]bool{"flaky": true}, listed)
	if settled := s.Sweep(map[string]bool{"flaky": true}, listed); len(settled) != 0 {
		t.Fatalf("an ask posted after the listing settled: %+v", settled)
	}
	// A listing taken after it, that misses it twice, settles it.
	s.Sweep(map[string]bool{"flaky": true}, clock.t.Add(time.Second))
	if settled := s.Sweep(map[string]bool{"flaky": true}, clock.t.Add(time.Second)); len(settled) != 1 || settled[0].Key != "session:new" {
		t.Fatalf("settled = %+v", settled)
	}
}

// The store never takes a file it couldn't read for an empty one: the
// next change would write over every item.
func TestAttentionNeverLosesItemsItCouldntRead(t *testing.T) {
	s, _ := newAttention(t)
	// Unreadable for now: the path is a folder.
	if err := os.Mkdir(s.Path, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.List(AttentionFilter{}); err == nil {
		t.Fatal("a list read nothing and said nothing")
	}
	if _, err := s.Post(AttentionPost{Key: "k", Kind: "decision", Title: "t"}, "x"); err == nil {
		t.Fatal("a post went ahead on a store that couldn't be read")
	}
	// Readable again: the same store reads it then.
	os.Remove(s.Path)
	os.WriteFile(s.Path, []byte(`[{"key":"kept","revision":4,"kind":"review","title":"PR #3","status":"open","created":"2026-11-06T08:00:00Z","updated":"2026-11-06T08:00:00Z"}]`), 0o600)
	if it, ok := getOf(t, s, "kept"); !ok || it.Revision != 4 {
		t.Fatalf("after the file came back: %+v %v", it, ok)
	}

	// A file that isn't JSON is set aside for someone to look at.
	c, _ := newAttention(t)
	os.WriteFile(c.Path, []byte("{half a file"), 0o600)
	if all := listOf(t, c, AttentionFilter{}); len(all) != 0 {
		t.Fatalf("corrupt file read as %+v", all)
	}
	aside, _ := filepath.Glob(c.Path + ".corrupt-*")
	if len(aside) != 1 {
		t.Fatalf("set aside: %v", aside)
	}
	if b, _ := os.ReadFile(aside[0]); string(b) != "{half a file" {
		t.Fatalf("set aside as %q", b)
	}
}

// Settling is all or nothing: an item closes only once the file says so,
// so nothing is announced that a restart would undo.
func TestASettleThatCantBeSavedChangesNothing(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes into a read-only folder")
	}
	s, clock := newAttention(t)
	s.Post(AttentionPost{Session: "gone", Kind: "action", Title: "Rotate the acme key"}, "claude")
	dir := filepath.Dir(s.Path)
	os.Chmod(dir, 0o500)
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if settled := s.SettleSession("gone"); len(settled) != 0 {
		t.Fatalf("settled without saving: %+v", settled)
	}
	if it, _ := getOf(t, s, "session:gone"); it.Status != AttentionOpen || it.Revision != 1 {
		t.Fatalf("after a failed save: %+v", it)
	}
	// Once the disk takes it, the next try settles it, and a restart reads
	// it closed.
	os.Chmod(dir, 0o700)
	if settled := s.SettleSession("gone"); len(settled) != 1 || settled[0].Revision != 2 {
		t.Fatalf("retry = %+v", settled)
	}
	again := &AttentionStore{Path: s.Path, Now: clock.now}
	if it, _ := getOf(t, again, "session:gone"); it.Status != AttentionClosed || it.Revision != 2 {
		t.Fatalf("after restart: %+v", it)
	}
}

func TestAttentionSurvivesARestart(t *testing.T) {
	s, clock := newAttention(t)
	s.Post(AttentionPost{Key: "review/shop#12", Kind: "review", Title: "PR #12 is green", Details: "Ready to merge.", Options: []AttentionOption{{Label: "Merge", Description: "squash"}}}, "claude")
	s.Update("session:gone", AttentionUpdate{Status: strp(AttentionClosed)}, "app")
	s.Update("session:old", AttentionUpdate{Status: strp(AttentionClosed)}, "app")

	// A new store on the same file, as berthd has after a restart.
	again := &AttentionStore{Path: s.Path, Now: clock.now}
	it, ok := getOf(t, again, "review/shop#12")
	if !ok || it.Title != "PR #12 is green" || it.Details != "Ready to merge." || it.Options[0].Description != "squash" || it.Revision != 1 {
		t.Fatalf("after restart: %+v %v", it, ok)
	}
	if n := len(listOf(t, again, AttentionFilter{})); n != 3 {
		t.Fatalf("%d items after restart", n)
	}
	// One read 15 days on leaves the settled ones behind.
	clock.advance(15 * 24 * time.Hour)
	later := &AttentionStore{Path: s.Path, Now: clock.now}
	if all := listOf(t, later, AttentionFilter{}); len(all) != 1 || all[0].Key != "review/shop#12" {
		t.Fatalf("read 15 days on: %+v", all)
	}
}

func TestAttentionKeepsToItsSize(t *testing.T) {
	s, _ := newAttention(t)
	s.Update("settled", AttentionUpdate{Status: strp(AttentionClosed)}, "app")
	for i := 1; i < maxAttentionItems; i++ {
		s.items["k"+itoa(i)] = &AttentionItem{Key: "k" + itoa(i), Kind: "decision", Status: AttentionOpen}
	}
	// Full: the settled one makes room, then there is none.
	if _, err := s.Post(AttentionPost{Key: "new", Kind: "decision", Title: "t"}, "x"); err != nil {
		t.Fatal(err)
	}
	if _, ok := getOf(t, s, "settled"); ok {
		t.Fatal("the settled item should have made room")
	}
	if _, err := s.Post(AttentionPost{Key: "one-more", Kind: "decision", Title: "t"}, "x"); statusFor(err) != http.StatusTooManyRequests {
		t.Fatalf("full: %v", err)
	}
	// Replacing an item that's there still works.
	if _, err := s.Post(AttentionPost{Key: "new", Kind: "decision", Title: "t2"}, "x"); err != nil {
		t.Fatal(err)
	}
}

func TestAttentionRoutes(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "hooks.json")
	os.WriteFile(cfg, []byte(`{"hooks":[{"on":"before:attention.update","run":"grep -q never-snooze && { echo no snoozing that; exit 1; }; exit 0"}]}`), 0o600)
	bus := &events.Bus{Sequence: true}
	bx := &Box{Name: "devbox", Events: bus, Hooks: &hooks.Runner{Path: cfg}}
	bx.Attention = &AttentionStore{Path: filepath.Join(dir, "attention.json")}
	c := localBox(t, bx)
	ctx := context.Background()
	evs, stop := bus.Subscribe()
	defer stop()
	if !contains(bx.Capabilities(), "attention") {
		t.Fatal("no attention capability")
	}

	var it AttentionItem
	if err := c.Call(ctx, "POST", "/v1/attention", AttentionPost{Key: "acme/shop/ask", Kind: "decision", Title: "Ship on Friday?", Details: "secret plans"}, &it); err != nil {
		t.Fatal(err)
	}
	e := waitEventType(t, evs, "attention.posted")
	if e.Data["key"] != "acme/shop/ask" || e.Data["revision"] != 1 || e.Data["status"] != "open" {
		t.Fatalf("posted event %+v", e)
	}
	if _, ok := e.Data["title"]; ok {
		t.Fatalf("an event never carries an item's words: %+v", e.Data)
	}
	// The key goes path-escaped, slashes and all.
	path := "/v1/attention/" + url.PathEscape("acme/shop/ask")
	var snoozed AttentionItem
	if err := c.Call(ctx, "PATCH", path, map[string]any{"revision": 1, "snoozed_until": "2026-11-07T09:00:00Z"}, &snoozed); err != nil {
		t.Fatal(err)
	}
	if snoozed.Revision != 2 || snoozed.SnoozedUntil.IsZero() {
		t.Fatalf("snoozed = %+v", snoozed)
	}
	if e := waitEventType(t, evs, "attention.updated"); e.Data["snoozed_until"] == nil {
		t.Fatalf("updated event %+v", e)
	}
	var got AttentionItem
	if err := c.Call(ctx, "GET", path, nil, &got); err != nil || got.Revision != 2 || got.Title != "Ship on Friday?" {
		t.Fatalf("get = %+v %v", got, err)
	}
	// A turn's "#" too.
	if err := c.Call(ctx, "PATCH", "/v1/attention/"+url.PathEscape("devl/shop#3"), map[string]any{"status": "closed"}, &got); err != nil || got.Key != "devl/shop#3" || got.Kind != "mark" {
		t.Fatalf("mark with #: %+v %v", got, err)
	}
	var list []AttentionItem
	if err := c.Call(ctx, "GET", "/v1/attention?open=1", nil, &list); err != nil || len(list) != 1 {
		t.Fatalf("list = %+v %v", list, err)
	}
	// Refusals: a stale revision, an unknown key to read, a gate.
	if err := c.Call(ctx, "PATCH", path, map[string]any{"revision": 1, "status": "closed"}, nil); err == nil || !strings.Contains(err.Error(), "changed since") {
		t.Fatalf("stale: %v", err)
	}
	if err := c.Call(ctx, "GET", "/v1/attention/nope", nil, nil); err == nil || !strings.Contains(err.Error(), "no attention item") {
		t.Fatalf("unknown: %v", err)
	}
	if err := c.Call(ctx, "PATCH", "/v1/attention/never-snooze", map[string]any{"snoozed_until": "2026-11-07T09:00:00Z"}, nil); err == nil || !strings.Contains(err.Error(), "no snoozing that") {
		t.Fatalf("gate: %v", err)
	}
	if _, ok := getOf(t, bx.Attention, "never-snooze"); ok {
		t.Fatal("a refused update made a mark")
	}

	// A session that is stopped settles its items at once, announced as
	// the box's own; one whose program ended settles at the next sweep.
	defer bx.WatchAttention()()
	bx.Attention.Post(AttentionPost{Session: "shop-claude", Kind: "action", Title: "Log in to Fly"}, "claude")
	bx.Attention.Post(AttentionPost{Session: "shop-codex", Kind: "action", Title: "Rotate the acme key"}, "codex")
	bus.Publish(events.Event{Type: "session.stopped", Data: map[string]any{"name": "shop-claude"}})
	if e := waitEventType(t, evs, "attention.settled"); e.Data["key"] != "session:shop-claude" || e.Data["closed_reason"] != "session_ended" || e.Origin != "berth" {
		t.Fatalf("settled event %+v", e)
	}
	if it, _ := getOf(t, bx.Attention, "session:shop-codex"); it.Status != AttentionOpen {
		t.Fatalf("another session's ask settled: %+v", it)
	}
	bx.sweepAttention([]Session{{Name: "shop-codex", Exited: true}}, time.Now())
	bx.sweepAttention([]Session{{Name: "shop-codex", Exited: true}}, time.Now())
	if e := waitEventType(t, evs, "attention.settled"); e.Data["key"] != "session:shop-codex" {
		t.Fatalf("swept event %+v", e)
	}
}
