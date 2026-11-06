package box

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestThePhoneListsTheBoxsOpenAttentionItemsWithoutTheirWords(t *testing.T) {
	b, _, h := phoneBox(t)
	clock := &clock{time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)}
	b.Attention = &AttentionStore{Path: filepath.Join(t.TempDir(), "attention.json"), Now: clock.now}

	if _, err := b.Attention.Post(AttentionPost{Key: "acme/shop/ask", Kind: "decision", Title: "Ship on Friday?", Details: "secret plans", Session: "shop-fix-claude",
		Options: []AttentionOption{{Label: "Ship"}, {Label: "Wait", Description: "after the sale"}}, Recommended: "Ship"}, "mcp"); err != nil {
		t.Fatal(err)
	}
	clock.advance(time.Minute)
	until := "2026-11-07T09:00:00Z"
	if _, err := b.Attention.Update("signal:shop-review-claude", AttentionUpdate{SnoozedUntil: &until}, "app"); err != nil {
		t.Fatal(err)
	}
	clock.advance(time.Minute)
	if _, err := b.Attention.Post(AttentionPost{Key: "acme/answered", Kind: "action", Title: "Rotate the acme key"}, "mcp"); err != nil {
		t.Fatal(err)
	}
	answer := "done, rotated with secret-answer"
	if _, err := b.Attention.Update("acme/answered", AttentionUpdate{Answer: &answer}, "app"); err != nil {
		t.Fatal(err)
	}

	w := phoneReq(t, h, "GET", "/phone/v1/attention", phoneAddr, "right-token", "")
	var got []AttentionBrief
	if err := json.Unmarshal(w.Body.Bytes(), &got); w.Code != 200 || err != nil {
		t.Fatalf("attention: %d %s", w.Code, w.Body)
	}
	// What the store holds, open only, the most recently changed first.
	want, err := b.Attention.List(AttentionFilter{Open: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || len(want) != 2 || got[0].Key != "signal:shop-review-claude" || got[1].Key != "acme/shop/ask" {
		t.Fatalf("attention: %s", w.Body)
	}
	for i := range want {
		if g, w := mustJSON(got[i]), mustJSON(want[i].Brief()); string(g) != string(w) {
			t.Fatalf("item %d: %s, the store has %s", i, g, w)
		}
	}
	ask := got[1]
	if ask.Title != "Ship on Friday?" || ask.Revision != 1 || ask.Session != "shop-fix-claude" || ask.Recommended != "Ship" || len(ask.Options) != 2 || ask.Options[1].Description != "after the sale" {
		t.Fatalf("the ask: %+v", ask)
	}
	if mark := got[0]; mark.Kind != "mark" || !mark.SnoozedUntil.Equal(time.Date(2026, 11, 7, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("the mark: %+v", mark)
	}
	// An item's details and answer stay on the box.
	for _, secret := range []string{"secret plans", "secret-answer", `"details"`, `"answer"`, `"by"`} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("the phone read %q: %s", secret, w.Body)
		}
	}

	// One session's.
	w = phoneReq(t, h, "GET", "/phone/v1/attention?session=shop-fix-claude", phoneAddr, "right-token", "")
	if err := json.Unmarshal(w.Body.Bytes(), &got); w.Code != 200 || err != nil || len(got) != 1 || got[0].Key != "acme/shop/ask" {
		t.Fatalf("one session's: %d %s", w.Code, w.Body)
	}
	// None is a list, not null.
	w = phoneReq(t, h, "GET", "/phone/v1/attention?session=nobody", phoneAddr, "right-token", "")
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("none: %d %s", w.Code, w.Body)
	}

	// It needs the token, and is only read.
	if w := phoneReq(t, h, "GET", "/phone/v1/attention", phoneAddr, "", ""); w.Code != 401 {
		t.Fatalf("without the token: %d", w.Code)
	}
	if w := phoneReq(t, h, "GET", "/phone/v1/attention", phoneAddr, "wrong-token", ""); w.Code != 401 {
		t.Fatalf("a wrong token: %d", w.Code)
	}
	for _, m := range []string{"POST", "PATCH", "DELETE"} {
		for _, path := range []string{"/phone/v1/attention", "/phone/v1/attention/acme%2Fshop%2Fask"} {
			if w := phoneReq(t, h, m, path, phoneAddr, "right-token", `{"kind":"decision","title":"x","status":"closed"}`); w.Code < 400 {
				t.Errorf("%s %s answered %d", m, path, w.Code)
			}
		}
	}
	if it, _, _ := b.Attention.Get("acme/shop/ask"); it.Status != AttentionOpen || it.Revision != 1 {
		t.Fatalf("a phone changed an item: %+v", it)
	}

	var info struct{ Capabilities []string }
	json.Unmarshal(phoneReq(t, h, "GET", "/phone/v1/info", phoneAddr, "right-token", "").Body.Bytes(), &info)
	if !contains(info.Capabilities, "attention") {
		t.Fatalf("info: %v", info.Capabilities)
	}
}

func TestThePhoneSaysWhenTheBoxCantReadItsAttentionItems(t *testing.T) {
	b, _, h := phoneBox(t)
	// A folder where the file should be: the store can't read it.
	path := t.TempDir()
	b.Attention = &AttentionStore{Path: path}
	if w := phoneReq(t, h, "GET", "/phone/v1/attention", phoneAddr, "right-token", ""); w.Code != 500 || !strings.Contains(w.Body.String(), "can't read") {
		t.Fatalf("an unreadable store answered %d %s", w.Code, w.Body)
	}

	b.Attention = nil
	if w := phoneReq(t, h, "GET", "/phone/v1/attention", phoneAddr, "right-token", ""); w.Code != 501 {
		t.Fatalf("a box with no store: %d %s", w.Code, w.Body)
	}
	var info struct{ Capabilities []string }
	json.Unmarshal(phoneReq(t, h, "GET", "/phone/v1/info", phoneAddr, "right-token", "").Body.Bytes(), &info)
	if contains(info.Capabilities, "attention") {
		t.Fatalf("a box with no store offers attention: %v", info.Capabilities)
	}
}
