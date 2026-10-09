import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { openEditor } from "@/components/editors/open";
import { toggleShortcuts } from "@/components/shortcuts-sheet";
import { submitConfirm } from "@/components/sidebar/confirm";
import { toastManager } from "@/components/ui/toast";
import { closePane, openBrowserAt, startSession } from "@/lib/actions";
import { isTauri } from "@/lib/api";
import { IS_LINUX } from "@/lib/platform";
import { toggleNotifications } from "@/lib/notifications";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { focusedSide, LANES } from "@/lib/compare";
import { compareShowing, setCompareLane, swapCompare } from "@/lib/compare-actions";
import { activateTab, closeGroup, currentSpace, focusGroup, hereRef, moveFocus, nextGroup, stripTab, useWorkspaces } from "@/lib/workspaces";
import { openWorktreePicker } from "@/components/workspace/worktree-picker";
import { newTerminal } from "@/components/box-picker";
import { zoom } from "@/lib/zoom";
import { docKey, save, setPickerOpen, useFiles } from "@/lib/files";
import { toggleTree } from "@/lib/file-tree";
import { findLeaf, leaves, paneWorktree } from "@/lib/layout";
import { paneKey, toggleDrawer } from "@/lib/devtools";
import { isOnboardingActive } from "@/views/onboarding/onboarding-state";
import { firstFocusable, rescueFocus } from "@/lib/focus-home";
import { deckOn, jumpToWaiting, showDeck, swapFocused, toggleZoom, useDecks } from "@/lib/deck";
import { toggleSwitcher } from "@/components/deck/deck-strip";

// The app's shortcuts (lib/shortcuts.json) come two ways: as keys, caught on
// the window before a terminal sees them, and, in the Mac app, from the menu
// bar, whose items carry the same keys so macOS cannot take them first (it
// takes ⌘. for "cancel" before the page sees it). Both end up in run.

type Dir = "left" | "right" | "up" | "down";
const arrows: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

// run does what the shortcut id does and says whether it did anything, so a
// key that does nothing here goes on to the page. arg is the tab's number
// (tab) or the direction (focus).
function run(id: string, from: "key" | "menu", arg?: number | Dir): boolean {
  // Zoom works everywhere, onboarding included.
  if (id === "zoom-in" || id === "zoom-out" || id === "zoom-reset") {
    // With a terminal focused it sizes the terminal's font (lib/zoom.ts).
    zoom(id === "zoom-in" ? 1 : id === "zoom-out" ? -1 : 0);
    return true;
  }
  // Until onboarding is done there is nowhere else to go.
  if (isOnboardingActive()) return false;
  const s = useStore.getState();
  const ws = currentSpace();
  const wsKey = useWorkspaces.getState().current;
  const tab = ws?.tabs.find((t) => t.id === ws.active);
  const inWorkspace = s.view.kind === "workspace" && !!ws;
  // The worktree you are acting in: the focused pane's.
  const at = hereRef();

  switch (id) {
    case "new-worktree":
      s.openNewWorktree(at ? { box: at.box, location: at.location } : {});
      return true;
    case "new-terminal":
      // With no worktree in focus, on a box's home (components/box-picker).
      newTerminal();
      return true;
    case "new-browser":
      if (!ws) return false;
      openBrowserAt("");
      return true;
    case "split-right":
    case "split-down":
      // A Compare tab is its two sides; ⌘D stays the terminal's there.
      if (!inWorkspace || !tab || tab.compare) return false;
      void startSession("", { kind: "split", tab: tab.id, pane: tab.focus, dir: id === "split-down" ? "col" : "row" });
      return true;
    case "split-worktree":
      if (!inWorkspace || !tab || tab.compare) return false;
      if (!usePrefs.getState().labs) {
        if (from === "menu") toastManager.add({ title: "Worktrees side by side are in Labs", description: "Turn on Labs in Settings → General to use them." });
        return from === "menu";
      }
      openWorktreePicker({ kind: "split" });
      return true;
    case "compare": {
      if (!usePrefs.getState().labs) {
        if (from === "menu") toastManager.add({ title: "Compare is in Labs", description: "Turn on Labs in Settings → General to use it." });
        return from === "menu";
      }
      if (!at) return false;
      // In a Compare tab, ⌘⌥C swaps the side without the focus for another.
      const showing = compareShowing();
      if (showing?.tab.compare) {
        const c = showing.tab.compare;
        const side = focusedSide(showing.tab);
        openWorktreePicker({ kind: "compare", from: side ? c.b : c.a, replace: { key: showing.key, tab: showing.tab.id } });
      } else openWorktreePicker({ kind: "compare" });
      return true;
    }
    case "compare-swap": {
      const showing = compareShowing();
      if (!showing) return false;
      swapCompare(showing.key, showing.tab.id);
      return true;
    }
    case "compare-lane": {
      const showing = compareShowing();
      const lane = LANES[Number(arg) - 1];
      if (!showing || !lane) return false;
      setCompareLane(showing.key, showing.tab.id, lane);
      return true;
    }
    case "open-editor":
      if (!at) return false;
      void openEditor({ box: at.box, path: at.path });
      return true;
    case "close-pane":
      // ⌘W again while "Close shell?" is open confirms it, as on macOS.
      if (submitConfirm()) return true;
      // Any other dialog: ⌘W does nothing, rather than close a pane behind it.
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return true;
      if (!inWorkspace || !tab || !wsKey) return false;
      void closePane(wsKey, tab.id, tab.focus);
      return true;
    case "zen":
      if (usePrefs.getState().labs) usePrefs.setState((p) => ({ zen: !p.zen }));
      else if (from === "menu") toastManager.add({ title: "Zen is in Labs", description: "Turn on Labs in Settings → General to use it." });
      else return false;
      return true;
    case "sidebar":
      usePrefs.setState((p) => ({ sidebarCollapsed: !p.sidebarCollapsed }));
      return true;
    case "dashboard":
      // The workspace layout: the agent that has waited longest comes in.
      if (deckOn() && jumpToWaiting()) return true;
      s.setView({ kind: "dashboard" });
      return true;
    case "notifications":
      toggleNotifications();
      return true;
    case "palette":
      if (useFiles.getState().pickerOpen) setPickerOpen(false);
      s.setPaletteOpen(!s.paletteOpen);
      return true;
    case "files":
      // ⌘P finds a file in the worktree you are acting in.
      if (s.paletteOpen) s.setPaletteOpen(false);
      setPickerOpen(!useFiles.getState().pickerOpen);
      return true;
    case "devtools": {
      // ⌘⌥I: the focused Browser pane's Console and Network drawer, else
      // the tab's first Browser pane's.
      if (!inWorkspace || !tab) return false;
      const focused = findLeaf(tab.root, tab.focus);
      const pane = focused?.content.kind === "browser" ? focused : leaves(tab.root).find((l) => l.content.kind === "browser");
      if (!pane) return false;
      toggleDrawer(paneKey(pane.id));
      // The keyboard follows: into the drawer as it opens, home as it goes.
      handOff("[data-testid=devtools-drawer] [role=tab][aria-selected=true]", "[data-testid=devtools-drawer]");
      return true;
    }
    case "file-tree":
      // ⌘⇧E: the Files panel beside the worktree's tabs.
      toggleTree();
      handOff("[data-testid=files-panel]", "[data-testid=files-panel]");
      return true;
    case "save-file": {
      // ⌘S in a File tab, wherever in it the focus is.
      const leaf = inWorkspace && tab && wsKey ? findLeaf(tab.root, tab.focus) : undefined;
      if (!leaf || leaf.content.kind !== "file" || !wsKey) return false;
      void save(docKey(paneWorktree(wsKey, leaf), leaf.content.path));
      return true;
    }
    case "tab": {
      // The workspace layout: its workspaces, in the bar's order.
      if (deckOn()) {
        const d = useDecks.getState().decks[Number(arg) - 1];
        if (d) showDeck(d.id);
        return !!d;
      }
      // Counted across the whole strip, every unfolded group's tabs.
      const t = stripTab(Number(arg));
      if (!t) return false;
      if (t.key !== wsKey) focusGroup(t.key);
      activateTab(t.key, t.tab.id);
      return true;
    }
    case "prev-group":
    case "next-group":
      return nextGroup(id === "next-group" ? 1 : -1);
    case "close-group":
      // With one group, ⌘⇧W closes the window, as it always has.
      if (wsKey && closeGroup(wsKey)) return true;
      if (!isTauri()) return false;
      void getCurrentWindow().close();
      return true;
    case "focus":
      if (!inWorkspace) return false;
      moveFocus(arg as Dir);
      return true;
    case "shortcuts":
      toggleShortcuts();
      return true;
    case "deck-switcher":
      if (!deckOn()) return false;
      toggleSwitcher();
      return true;
    case "deck-zoom":
      return deckOn() && toggleZoom();
    case "deck-swap":
      // Outside the workspace layout ⌘⌥⇧ and an arrow moves, as ⌘⌥ does.
      if (!deckOn()) return run("focus", from, arg);
      return swapFocused(arg as Dir);
  }
  return false;
}

// handOff moves the keyboard with a panel a shortcut showed or hid: to the
// panel's first control (or target) once it is there, or home when the
// panel that had the keyboard went away.
// Called just after the toggle, before React draws it, so the page still
// shows whether the panel was open.
function handOff(target: string, panel: string) {
  if (document.querySelector(panel)) {
    // Closing: home, if the keyboard was in it.
    if (document.activeElement?.closest(panel)) window.setTimeout(() => !document.querySelector(panel) && rescueFocus(0), 60);
    return;
  }
  // Opening: once the panel has drawn something to focus (a second at most).
  const until = Date.now() + 1500;
  const tick = () => {
    const el = document.querySelector<HTMLElement>(target);
    const t = el && (el.matches(panel) ? firstFocusable(el) : el);
    if (t) t.focus({ preventScroll: true });
    else if (Date.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// One press can arrive both ways (the page's keydown, then the menu bar, or
// the other way round); the second is dropped so a toggle stays toggled.
let last: { what: string; from: string; at: number } | undefined;
export function runShortcut(id: string, from: "key" | "menu", arg?: number | Dir): boolean {
  const what = arg === undefined ? id : `${id}-${arg}`;
  const now = performance.now();
  if (last && last.what === what && last.from !== from && now - last.at < 400) return true;
  const did = run(id, from, arg);
  if (did) last = { what, from, at: now };
  return did;
}

// fromKey is the shortcut a keydown is, if any.
function fromKey(e: KeyboardEvent): [string, (number | Dir)?] | undefined {
  // With ⌥ the key is the character it types (⌥D is ∂), so go by its code.
  if (e.altKey) {
    if (e.key in arrows) return [e.shiftKey ? "deck-swap" : "focus", arrows[e.key]];
    if (e.shiftKey) return undefined;
    return e.code === "KeyD" ? ["split-worktree"] : e.code === "KeyC" ? ["compare"] : e.code === "KeyS" ? ["compare-swap"] : e.code === "KeyI" ? ["devtools"] : undefined;
  }
  const key = e.key.toLowerCase();
  const shift = e.shiftKey;
  if (key === ".") return ["zen"];
  if (key === "enter" && shift) return ["deck-zoom"];
  if (key === "e" && !shift) return ["deck-switcher"];
  if (key === "\\") return ["sidebar"];
  if (key === "/" && !shift) return ["shortcuts"];
  if (key === "k") return ["palette"];
  if (key === "p" && !shift) return ["files"];
  if (key === "s" && !shift) return ["save-file"];
  if (key === "e" && shift) return ["file-tree"];
  if (key === "n") return [shift ? "notifications" : "new-worktree"];
  if (key === "j") return ["dashboard"];
  if (key === "t" && !shift) return ["new-terminal"];
  if (key === "b" && shift) return ["new-browser"];
  if (key === "o" && shift) return ["open-editor"];
  if (key === "d") return [shift ? "split-down" : "split-right"];
  if (key === "w") return [shift ? "close-group" : "close-pane"];
  // ⌘= and ⌘+ (⌘⇧= on most layouts, or the keypad's +) zoom in.
  if (key === "=" || key === "+" || e.code === "NumpadAdd") return ["zoom-in"];
  if (key === "-" || key === "_" || key === "−" || e.code === "NumpadSubtract") return ["zoom-out"];
  if (key === "0" || e.code === "Numpad0") return ["zoom-reset"];
  if (/^[1-9]$/.test(key)) return ["tab", Number(key)];
  return undefined;
}

// fromLinuxKey is fromKey with Ctrl for ⌘. A shell needs its Ctrl keys
// (Ctrl+W, Ctrl+D, Ctrl+K…), so in a terminal Ctrl and a letter are the
// shell's, and Ctrl+Shift and the letter are the app's instead, as in other
// Linux terminals: Ctrl+Shift+T is a new terminal, Ctrl+Shift+K the palette.
// Where ⌘⇧ and the letter is a shortcut of its own (⌘⇧D, ⌘⇧W, ⌘⇧N…), it
// keeps that meaning. Ctrl+Shift+C and V stay the terminal's copy and paste.
function fromLinuxKey(e: KeyboardEvent): [string, (number | Dir)?] | undefined {
  const inTerminal = e.target instanceof Element && !!e.target.closest("[data-terminal]");
  if (!inTerminal || e.altKey) return fromKey(e);
  const letter = /^Key[A-Z]$/.test(e.code) || e.key === "\\";
  if (!letter) return fromKey(e);
  if (!e.shiftKey) return undefined;
  if (e.code === "KeyC" || e.code === "KeyV") return undefined;
  const shifted = fromKey(e);
  if (shifted) return shifted;
  return fromKey(new KeyboardEvent("keydown", { key: e.key.toLowerCase(), code: e.code, ctrlKey: true }));
}

// fromMenu is the shortcut a menu bar item's id is ("tab-3" is tab 3).
function fromMenu(id: string): [string, number?] {
  const m = /^tab-(\d)$/.exec(id);
  return m ? ["tab", Number(m[1])] : [id];
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌃⇧Tab and ⌃⌥Tab step between tab groups; a terminal keeps them
      // while there is only one.
      if (e.ctrlKey && !e.metaKey && e.key === "Tab" && (e.shiftKey || e.altKey)) {
        if (!runShortcut(e.altKey ? "next-group" : "prev-group", "key")) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // ⌥1–5 pick a Compare tab's lane while one shows; elsewhere they are
      // the page's or the terminal's.
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-5]$/.test(e.code)) {
        if (!runShortcut("compare-lane", "key", Number(e.code.slice(5)))) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // In the Linux app, and in the live demo on Windows and Linux, Ctrl
      // stands in for ⌘.
      if (IS_LINUX) {
        if (!e.ctrlKey || e.metaKey) return;
      } else {
        const meta = e.metaKey || (__BERTH_DEMO__ && e.ctrlKey && !/Mac|iPhone|iPad/.test(navigator.platform));
        if (!meta || (e.metaKey && e.ctrlKey)) return;
      }
      const hit = IS_LINUX ? fromLinuxKey(e) : fromKey(e);
      if (!hit || !runShortcut(hit[0], "key", hit[1])) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    // The Mac app's menu bar: each item sends its id (src-tauri/src/lib.rs).
    let unlisten: (() => void) | undefined;
    let gone = false;
    if (isTauri())
      void listen<string>("berth://menu", (e) => {
        const [id, arg] = fromMenu(e.payload);
        runShortcut(id, "menu", arg);
      }).then((u) => (gone ? u() : (unlisten = u)));
    return () => {
      gone = true;
      unlisten?.();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, []);
}
