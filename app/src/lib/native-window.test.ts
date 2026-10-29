// node --experimental-strip-types --test src/lib/native-window.test.ts (pnpm test)
// The Mac app's window (src-tauri/tauri.macos.conf.json) is the one in
// tauri.conf.json made see-through with the sidebar material behind it
// (lib/vibrancy.ts). Tauri merges a platform's config as a JSON merge patch,
// which replaces the windows list whole, so the Mac one repeats every
// setting: a change to one must reach the other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../src-tauri/${name}`, import.meta.url), "utf8"));

test("the Mac window is the app's window, see-through with the sidebar material", () => {
  const base = read("tauri.conf.json");
  const mac = read("tauri.macos.conf.json");
  assert.equal(mac.app.windows.length, base.app.windows.length);
  const { transparent, windowEffects, ...rest } = mac.app.windows[0];
  assert.deepEqual(rest, base.app.windows[0]);
  assert.equal(transparent, true);
  assert.deepEqual(windowEffects, { effects: ["sidebar"], state: "followsWindowActiveState" });
  // A see-through window on macOS needs the private API, on for every
  // platform so the Tauri CLI leaves Cargo.toml's feature alone.
  assert.equal(base.app.macOSPrivateApi, true);
  assert.equal(base.app.windows[0].transparent, undefined, "Linux and Windows keep an opaque window");
});
