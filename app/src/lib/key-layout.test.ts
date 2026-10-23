// node --experimental-strip-types --test src/lib/key-layout.test.ts (pnpm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { keyLabel, layoutKeys, learn, PLACES } from "./key-layout.ts";

// What navigator.keyboard.getLayoutMap() (or the Mac app) says the places
// type on each layout. A dead key comes as its mark, combining or not.
const US = new Map([["BracketLeft", "["], ["BracketRight", "]"], ["KeyD", "d"], ["KeyQ", "q"]]);
const NORWEGIAN = new Map([["BracketLeft", "å"], ["BracketRight", "̈"], ["KeyD", "d"]]);
const GERMAN = new Map([["BracketLeft", "ü"], ["BracketRight", "+"], ["KeyD", "d"]]);
const DVORAK = new Map([["BracketLeft", "/"], ["BracketRight", "="], ["KeyD", "e"]]);

const table = JSON.parse(readFileSync(new URL("./shortcuts.json", import.meta.url), "utf8")) as { shortcuts: { id: string; keys: string; code?: string }[] };
const shown = (layout: Map<string, string> | undefined, id: string) => {
  const s = table.shortcuts.find((x) => x.id === id)!;
  return layoutKeys(s.keys, s.code, layout ? learn({}, layout) : {});
};

test("Back and Forward read as the keys in their place on the layout in use", () => {
  assert.deepEqual([shown(US, "back"), shown(US, "forward")], ["⌘[", "⌘]"]);
  assert.deepEqual([shown(NORWEGIAN, "back"), shown(NORWEGIAN, "forward")], ["⌘Å", "⌘¨"]);
  assert.deepEqual([shown(GERMAN, "back"), shown(GERMAN, "forward")], ["⌘Ü", "⌘+"]);
});

test("with the layout unknown, the keys are a US keyboard's", () => {
  assert.deepEqual([shown(undefined, "back"), shown(undefined, "forward")], ["⌘[", "⌘]"]);
  assert.equal(shown(new Map([["BracketLeft", "Dead"], ["BracketRight", ""]]), "back"), "⌘[");
  assert.equal(shown(new Map([["BracketLeft", "Unidentified"]]), "back"), "⌘[");
});

test("a letter matched by its place reads as the layout's letter there", () => {
  assert.equal(shown(US, "split-worktree"), "⌘⌥D");
  assert.equal(shown(DVORAK, "split-worktree"), "⌘⌥E");
});

test("a shortcut matched by its character never changes", () => {
  assert.equal(shown(DVORAK, "palette"), "⌘K");
  assert.equal(shown(GERMAN, "zoom-in"), "⌘+");
});

test("every shortcut matched by its place has the US key for that place in its keys", () => {
  for (const s of table.shortcuts.filter((x) => x.code)) {
    assert.ok(s.code! in PLACES, `${s.id}: ${s.code} is one of PLACES`);
    assert.ok(s.keys.endsWith(PLACES[s.code!]), `${s.id}: "${s.keys}" ends with ${PLACES[s.code!]}`);
  }
});

test("a key's label is the one character it types, upper case", () => {
  assert.equal(keyLabel("å"), "Å");
  assert.equal(keyLabel("¨"), "¨");
  assert.equal(keyLabel("̂"), "^");
  assert.equal(keyLabel("$"), "$");
  for (const bad of [undefined, "", " ", "Dead", "Process", "\t", "ab"]) assert.equal(keyLabel(bad), undefined, JSON.stringify(bad));
});

test("learning keeps what it can't label, and the same labels are the same object", () => {
  const no = learn({}, NORWEGIAN);
  assert.deepEqual(no, { BracketLeft: "Å", BracketRight: "¨", KeyD: "D" });
  assert.equal(learn(no, NORWEGIAN), no);
  assert.deepEqual(learn(no, [["BracketLeft", "Dead"]]), no);
  assert.deepEqual(learn(no, US), { BracketLeft: "[", BracketRight: "]", KeyD: "D" });
});
