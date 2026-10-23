import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { create } from "zustand";

import { isTauri } from "@/lib/api";
import { learn, PLACES } from "@/lib/key-layout";
import { IS_MAC } from "@/lib/platform";

// What the keys a shortcut is matched by (lib/key-layout.ts PLACES) type
// on the keyboard layout in use, as labels ("BracketLeft" is "Å" on a
// Norwegian layout). Empty until something says: then the lists show a US
// keyboard's keys, as they always have. Three things say, whichever this
// app has:
//   - Chromium's navigator.keyboard.getLayoutMap();
//   - the Mac app, which asks macOS for the input source in use
//     (key_layout in src-tauri/src/keys.rs; WKWebView has no
//     navigator.keyboard);
//   - a key pressed in one of the places with no modifier, which is the
//     character it types there (a dead key, such as Norwegian ¨, says
//     nothing: it waits for the next key).
// The first two are asked again when the window comes to the front, when
// Chromium says the layout changed, and whenever something that shows
// shortcuts opens (useKeyLabels), so a switch of input source shows there
// even with the window in front all along.
const useLabels = create<Record<string, string>>(() => ({}));

const take = (layout: Iterable<[string, string]>) => {
  const now = useLabels.getState();
  const next = learn(now, layout);
  if (next !== now) useLabels.setState(next, true);
};

interface KeyboardLayoutMap {
  entries(): IterableIterator<[string, string]>;
}
interface Keyboard extends EventTarget {
  getLayoutMap?: () => Promise<KeyboardLayoutMap>;
}
const keyboard = () => (navigator as { keyboard?: Keyboard }).keyboard;

// ask asks both, at once; one that can't say leaves what was learned. Only
// the Mac app's shell knows a layout: the Linux one's says nothing.
export function askKeyboardLayout() {
  const kb = keyboard();
  if (kb?.getLayoutMap) kb.getLayoutMap().then((m) => take(m.entries()), () => {});
  if (isTauri() && IS_MAC) invoke<Record<string, string>>("key_layout", { codes: Object.keys(PLACES) }).then((m) => take(Object.entries(m)), () => {});
}

// useKeyLabels is the labels, for something that shows shortcuts' keys
// (lib/shortcuts.ts keysOf). While shown is true it shows them again as the
// layout is learned, and it asks the layout again each time shown turns
// true: a sheet or a menu as it opens.
export function useKeyLabels(shown = true): Record<string, string> {
  useEffect(() => {
    if (shown) askKeyboardLayout();
  }, [shown]);
  return useLabels();
}

export const keyLabels = () => useLabels.getState();

let watching = false;

// watchKeyboardLayout starts learning the layout, once for the window.
export function watchKeyboardLayout() {
  if (watching) return;
  watching = true;
  askKeyboardLayout();
  window.addEventListener("focus", askKeyboardLayout);
  keyboard()?.addEventListener?.("layoutchange", askKeyboardLayout);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code in PLACES && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing) take([[e.code, e.key]]);
    },
    { capture: true, passive: true },
  );
}
