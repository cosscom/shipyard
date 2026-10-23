// node --experimental-strip-types --test src/lib/palette-shortcuts.test.ts (pnpm test)
// Every shortcut is reachable from ⌘K, or says why not; and the sheet's
// table and the key handler agree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FROM_TABLE, NOT_IN_PALETTE, OWN_ITEMS } from "./palette-shortcuts.ts";

const table = JSON.parse(readFileSync(new URL("./shortcuts.json", import.meta.url), "utf8")) as { shortcuts: { id: string; label: string; keys: string; code?: string; accel?: string; what?: string }[] };
const ids = table.shortcuts.map((s) => s.id);

test("every shortcut is in ⌘K or says why it isn't, once", () => {
  const listed = [...OWN_ITEMS, ...FROM_TABLE, ...Object.keys(NOT_IN_PALETTE)];
  assert.deepEqual([...listed].sort(), [...ids].sort());
  assert.equal(new Set(listed).size, listed.length);
});

test("the palette has an item for each of its own", () => {
  const src = readFileSync(new URL("../components/command-palette.tsx", import.meta.url), "utf8");
  for (const id of OWN_ITEMS) assert.ok(src.includes(`keysFor("${id}")`), `command-palette.tsx: ${id}'s item shows its keys with keysFor("${id}")`);
  assert.ok(src.includes("FROM_TABLE"), "command-palette.tsx lists FROM_TABLE");
});

test("the key handler runs every shortcut a menu item or key sends", () => {
  const src = readFileSync(new URL("../hooks/use-shortcuts.ts", import.meta.url), "utf8");
  // Handled elsewhere: by the component the keyboard is in.
  const elsewhere = new Set(["add-group", "compare-lane", "find", "send", "stop-agent", "fold", "menu", "rename"]);
  for (const id of ids) {
    if (elsewhere.has(id)) continue;
    assert.ok(src.includes(`"${id}"`), `use-shortcuts.ts handles ${id}`);
  }
  // A key matched by its place (code, which the lists show in the layout in
  // use) is matched by that code there.
  for (const s of table.shortcuts.filter((x) => x.code)) assert.ok(src.includes(`"${s.code}"`), `use-shortcuts.ts matches ${s.id} by e.code "${s.code}"`);
  // A table entry without a key in the menu bar must say what it is.
  for (const s of table.shortcuts) assert.ok(s.keys.trim(), `${s.id} has keys`);
});

test("a shortcut's description fits on its line in the sheet: one short clause", () => {
  // The sheet and Settings show describe(s), what or else label, on one
  // line, about 290px wide, less beside a Labs badge: the browser tests
  // check none is cut off. The details go in
  // docs/guides/keyboard-shortcuts.mdx.
  for (const s of table.shortcuts) for (const text of [s.label, s.what ?? ""]) assert.ok(text.length <= 40, `${s.id}: "${text}" is ${text.length} characters, more than 40`);
});
