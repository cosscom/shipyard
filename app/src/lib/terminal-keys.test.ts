// node --experimental-strip-types --test src/lib/terminal-keys.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { type TermKey, terminalClipboardKey, terminalKeyInput } from "./terminal-keys.ts";

const key = (k: string, mods: Partial<Omit<TermKey, "key">> = {}): TermKey => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...mods,
});

test("⇧↵ is Shift and Enter on every platform; Enter alone is the renderer's", () => {
  assert.equal(terminalKeyInput(key("Enter", { shiftKey: true }), true), "\x1b[13;2u");
  assert.equal(terminalKeyInput(key("Enter", { shiftKey: true }), false), "\x1b[13;2u");
  assert.equal(terminalKeyInput(key("Enter"), true), undefined);
  assert.equal(terminalKeyInput(key("Enter", { shiftKey: true, ctrlKey: true }), true), undefined);
});

test("on a Mac, ⌘ and ⌥ edit the line as in a Mac terminal", () => {
  assert.equal(terminalKeyInput(key("ArrowLeft", { metaKey: true }), true), "\x01");
  assert.equal(terminalKeyInput(key("ArrowRight", { metaKey: true }), true), "\x05");
  assert.equal(terminalKeyInput(key("Backspace", { metaKey: true }), true), "\x15");
  assert.equal(terminalKeyInput(key("ArrowLeft", { altKey: true }), true), "\x1bb");
  assert.equal(terminalKeyInput(key("ArrowRight", { altKey: true }), true), "\x1bf");
});

test("other keys, the app's ⌘⌥ arrows and Linux's keys stay as they were", () => {
  assert.equal(terminalKeyInput(key("ArrowLeft", { metaKey: true, altKey: true }), true), undefined);
  assert.equal(terminalKeyInput(key("ArrowLeft", { metaKey: true, shiftKey: true }), true), undefined);
  assert.equal(terminalKeyInput(key("ArrowUp", { metaKey: true }), true), undefined);
  assert.equal(terminalKeyInput(key("Backspace", { altKey: true }), true), undefined);
  assert.equal(terminalKeyInput(key("ArrowLeft", { altKey: true }), false), undefined);
  assert.equal(terminalKeyInput(key("ArrowLeft", { ctrlKey: true }), false), undefined);
});

test("a key being composed (an input method) is left alone", () => {
  assert.equal(terminalKeyInput(key("Enter", { shiftKey: true, isComposing: true }), true), undefined);
});

test("on a Mac, ⌘C copies and ⌘A selects all in a terminal; ⌘V is the menu bar's", () => {
  assert.equal(terminalClipboardKey(key("c", { metaKey: true }), true), "copy");
  assert.equal(terminalClipboardKey(key("a", { metaKey: true }), true), "select-all");
  assert.equal(terminalClipboardKey(key("v", { metaKey: true }), true), undefined);
  assert.equal(terminalClipboardKey(key("c", { metaKey: true, shiftKey: true }), true), undefined);
  assert.equal(terminalClipboardKey(key("c", { ctrlKey: true }), true), undefined);
  assert.equal(terminalClipboardKey(key("c", { metaKey: true, isComposing: true }), true), undefined);
});

test("on Linux, Ctrl+Shift+C and Ctrl+Shift+V copy and paste; Ctrl+C is the shell's", () => {
  assert.equal(terminalClipboardKey(key("C", { code: "KeyC", ctrlKey: true, shiftKey: true }), false), "copy");
  assert.equal(terminalClipboardKey(key("V", { code: "KeyV", ctrlKey: true, shiftKey: true }), false), "paste");
  assert.equal(terminalClipboardKey(key("c", { code: "KeyC", ctrlKey: true }), false), undefined);
  assert.equal(terminalClipboardKey(key("a", { code: "KeyA", ctrlKey: true, shiftKey: true }), false), undefined);
  assert.equal(terminalClipboardKey(key("c", { code: "KeyC", metaKey: true }), false), undefined);
});
