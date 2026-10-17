// Keys a terminal sends differently from what its renderer would, so they
// do in a terminal here what they do in a Mac terminal (Ghostty's macOS
// defaults, iTerm2's natural text editing).
//
// - ⇧↵ is CSI 13;2u, Shift and Enter. Through berth's tmux (extended-keys,
//   internal/box/sessions.go) a program that asked for modified keys gets
//   Shift+Enter (a newline in Claude Code); a shell gets a plain Enter.
//   Both renderers send a plain Enter for it themselves. Every platform.
// - ⌥← and ⌥→ move a word (ESC b, ESC f), where the renderers send
//   CSI 1;3D and CSI 1;3C, which a shell's line editor doesn't take.
// - ⌘← and ⌘→ go to the line's start and end (Ctrl+A, Ctrl+E), and ⌘⌫
//   deletes back to its start (Ctrl+U). Mac only: on Linux, Ctrl stands in
//   for ⌘ and its keys stay the shell's.

export type TermKey = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing"> & Partial<Pick<KeyboardEvent, "code">>;

const SHIFT_ENTER = "\x1b[13;2u";

const MAC_CMD: Record<string, string> = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" };
const MAC_OPTION: Record<string, string> = { ArrowLeft: "\x1bb", ArrowRight: "\x1bf" };

// terminalKeyInput is what a keydown sends instead of the renderer's own
// bytes, or undefined to leave it to the renderer.
export function terminalKeyInput(e: TermKey, mac: boolean): string | undefined {
  if (e.isComposing) return undefined;
  const only = (shift: boolean, alt: boolean, ctrl: boolean, meta: boolean) =>
    e.shiftKey === shift && e.altKey === alt && e.ctrlKey === ctrl && e.metaKey === meta;
  if (e.key === "Enter" && only(true, false, false, false)) return SHIFT_ENTER;
  if (!mac) return undefined;
  if (only(false, false, false, true)) return MAC_CMD[e.key];
  if (only(false, true, false, false)) return MAC_OPTION[e.key];
  return undefined;
}

export type ClipboardKey = "copy" | "paste" | "select-all";

// terminalClipboardKey is the copy, paste or select-all a keydown is in a
// terminal, or undefined to leave the key alone.
//
// - On a Mac, ⌘C copies the terminal's selection and ⌘A selects all its
//   text. The selection is drawn by the terminal, not the page's, so the
//   menu bar's Copy found nothing to copy and macOS played its alert
//   sound. ⌘V stays the menu bar's Paste, which the terminal takes as the
//   page's paste.
// - On Linux, Ctrl+Shift+C and Ctrl+Shift+V copy and paste, as in other
//   Linux terminals; Ctrl+C and Ctrl+V are the shell's.
export function terminalClipboardKey(e: TermKey, mac: boolean): ClipboardKey | undefined {
  if (e.isComposing) return undefined;
  if (mac) {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return undefined;
    const k = e.key.toLowerCase();
    return k === "c" ? "copy" : k === "a" ? "select-all" : undefined;
  }
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return undefined;
  return e.code === "KeyC" ? "copy" : e.code === "KeyV" ? "paste" : undefined;
}
