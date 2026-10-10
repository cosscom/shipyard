import type { TerminalColors } from "@/lib/api";
import { modKey } from "./platform.ts";
import type { PredictMode, Screen } from "./predict.ts";
import { findUrls, HyperlinkTracker, linksAround, openable, type Rows } from "./term-links.ts";
import { HIDDEN_FLUSH_MS, OutputGate } from "./term-output.ts";

// One small interface over the terminal emulator, so the renderer can be
// swapped: ghostty-web (Ghostty's VT parser in WASM, drawn on a canvas) by
// default, xterm.js as the fallback. Both are loaded on demand.

export type Renderer = "ghostty" | "xterm";

export interface TerminalPrefs {
  renderer: Renderer;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  // Predictive local echo (lib/predict): adaptive shows typing before the
  // box echoes it on a slow link only.
  predict: PredictMode;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  renderer: "ghostty",
  fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.1,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  predict: "adaptive",
};

// Where the terminal draws its cells, for an overlay on top of them
// (lib/predict-overlay): the element holding the grid, a cell's size and
// where its text's baseline is, in CSS pixels.
export interface ScreenGeometry {
  el: HTMLElement;
  cellWidth: number;
  cellHeight: number;
  baseline: number;
}

export interface TermHandle {
  readonly cols: number;
  readonly rows: number;
  write(data: string | Uint8Array): void;
  reset(): void;
  fit(): void;
  focus(): void;
  setTheme(colors: TerminalColors): void;
  onData(fn: (data: string) => void): void;
  onResize(fn: (size: { cols: number; rows: number }) => void): void;
  hasSelection(): boolean;
  // The selected text ("" with none).
  selection(): string;
  // Types text as a paste: bracketed when the program asked for that, as
  // Claude Code does, so it sees a pasted image's path as an image.
  paste(text: string): void;
  // Adds links found in each line's text, such as file paths. find gets a
  // line and returns ranges in it (end exclusive).
  registerLinkFinder(find: LinkFinder): void;
  // fn hears where the pointer rests on a link that ⌘-click (Ctrl-click
  // off a Mac) would open, while that key isn't held, in client
  // coordinates; null once it isn't. ghostty-web only: xterm.js opens its
  // links with a plain click.
  onLinkHint(fn: (at: { x: number; y: number } | null) => void): void;
  // Whether the terminal is on screen. Hidden, it draws nothing and takes
  // its output in batches (lib/term-output); shown again, it catches up and
  // redraws at once. A terminal starts shown.
  setVisible(visible: boolean): void;
  // The active screen as the emulator has it now, for predictive echo; null
  // while scrolled back into the history, or before it can be read.
  screen(): Screen | null;
  geometry(): ScreenGeometry | null;
  // fn runs once output written has been parsed into the screen, and after
  // each frame the terminal draws.
  onParsed(fn: () => void): void;
  onDrawn(fn: () => void): void;
  dispose(): void;
}

// What each renderer gives the handle below: the same, less visibility.
type RawHandle = Omit<TermHandle, "setVisible"> & { show?(visible: boolean): void };

export interface FoundLink {
  start: number;
  end: number;
  activate(event: MouseEvent): void;
}

export type LinkFinder = (line: string) => FoundLink[];

const theme = (c: TerminalColors) => ({ ...c, cursorAccent: c.background });

let ghosttyReady: Promise<typeof import("ghostty-web")> | undefined;

// ghostty-web is loaded once; each terminal then loads its own WASM
// instance (see createGhostty), so its shared one (init()) is never made.
function loadGhostty() {
  ghosttyReady ??= import("ghostty-web");
  return ghosttyReady;
}

// RendererOutcome is what the first terminal of a run started with: ghostty,
// or xterm.js because ghostty-web failed (reason and details say why) or
// because Settings asked for it. lib/terminal-health.ts tells the person
// about a fallback once and records it for berth doctor.
export interface RendererOutcome {
  renderer: Renderer;
  chosen: Renderer;
  reason?: string;
  details?: string;
}

const outcomeListeners = new Set<(o: RendererOutcome) => void>();
let lastOutcome: RendererOutcome | undefined;

export function onRendererOutcome(fn: (o: RendererOutcome) => void): () => void {
  outcomeListeners.add(fn);
  if (lastOutcome) fn(lastOutcome);
  return () => outcomeListeners.delete(fn);
}

export const rendererOutcome = () => lastOutcome;

function report(o: RendererOutcome) {
  // A fallback is news every time it changes; a working ghostty once a run.
  if (lastOutcome && lastOutcome.renderer === o.renderer && lastOutcome.reason === o.reason) return;
  lastOutcome = o;
  for (const fn of outcomeListeners) fn(o);
}

// fallbackDetails is what "Copy details" copies: the error and where it
// happened, enough to tell a CSP refusal from a missing WebAssembly feature.
export function fallbackDetails(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const lines = [
    `ghostty-web failed to start: ${e.name}: ${e.message}`,
    `origin: ${location.origin}`,
    `user agent: ${navigator.userAgent}`,
    `WebAssembly: ${typeof WebAssembly === "object" ? "yes" : "no"}`,
    `time: ${new Date().toISOString()}`,
  ];
  if (e.stack) lines.push("", e.stack);
  const cause = (e as { cause?: unknown }).cause;
  if (cause) lines.push("", `cause: ${String(cause)}`);
  return lines.join("\n");
}

export async function createTerminal(host: HTMLElement, colors: TerminalColors, prefs: TerminalPrefs): Promise<TermHandle> {
  await document.fonts.load(`${prefs.fontSize}px ${prefs.fontFamily}`).catch(() => {});
  if (prefs.renderer === "xterm") {
    report({ renderer: "xterm", chosen: "xterm" });
    return gated(await createXterm(host, colors, prefs), XTERM_HIDDEN_FLUSH);
  }
  try {
    const t = await createGhostty(host, colors, prefs);
    report({ renderer: "ghostty", chosen: "ghostty" });
    return gated(t);
  } catch (err) {
    console.error("ghostty-web failed to start; using xterm.js", err);
    report({ renderer: "xterm", chosen: "ghostty", reason: err instanceof Error ? err.message : String(err), details: fallbackDetails(err) });
    return gated(await createXterm(host, colors, prefs), XTERM_HIDDEN_FLUSH);
  }
}

// xterm.js, hidden, takes nothing until it shows (or 512 KB waits): every
// write to a hidden xterm.js re-measured each glyph of the rows it redrew
// (its DOM renderer's width cache keeps nothing measured in a hidden
// element, display: none), a forced layout per character, which kept the
// main thread busy with only a few noisy terminals in background tabs.
const XTERM_HIDDEN_FLUSH = Infinity;

// In mock mode, and with ?perf, the emulator is left on its element for the
// app's tests and perf/terminals.mjs and perf/live.mjs, which read the
// screen back (buffer.active, the same shape in both renderers) to check
// that a hidden terminal catches up and to time a key's echo.
function forTests(host: HTMLElement, t: object) {
  const q = new URLSearchParams(location.search);
  if (q.has("mock") || q.has("perf")) (host as HTMLElement & { __berthTerm?: object }).__berthTerm = t;
}

// gated puts an OutputGate in front of a renderer's writes: shown, output
// goes straight in; hidden, it waits and goes in batches, and the renderer
// is told to stop drawing.
function gated(t: RawHandle, hiddenFlushMs = HIDDEN_FLUSH_MS): TermHandle {
  const gate = new OutputGate((d) => t.write(d), undefined, hiddenFlushMs);
  let shown = true;
  let open = true;
  // A hidden window (minimised, covered, another Space) counts as hidden.
  const sync = () => {
    const v = shown && !document.hidden;
    if (v === open) return;
    open = v;
    // Caught up before the first frame it shows.
    gate.setOpen(v);
    t.show?.(v);
  };
  document.addEventListener("visibilitychange", sync);
  return {
    get cols() {
      return t.cols;
    },
    get rows() {
      return t.rows;
    },
    write: (d) => gate.write(d),
    reset: () => {
      gate.reset();
      t.reset();
    },
    fit: () => t.fit(),
    focus: () => t.focus(),
    setTheme: (c) => t.setTheme(c),
    onData: (fn) => t.onData(fn),
    onResize: (fn) => t.onResize(fn),
    hasSelection: () => t.hasSelection(),
    selection: () => t.selection(),
    paste: (text) => t.paste(text),
    registerLinkFinder: (find) => t.registerLinkFinder(find),
    onLinkHint: (fn) => t.onLinkHint(fn),
    screen: () => t.screen(),
    geometry: () => t.geometry(),
    onParsed: (fn) => t.onParsed(fn),
    onDrawn: (fn) => t.onDrawn(fn),
    setVisible(v) {
      shown = v;
      sync();
    },
    dispose: () => {
      document.removeEventListener("visibilitychange", sync);
      gate.reset();
      t.dispose();
    },
  };
}

// The parts of ghostty-web 0.4's Terminal that drawOnDemand drives.
interface GhosttyLoop {
  animationFrameId?: number;
  wasmTerm?: { getCursor(): { y: number } };
  viewportY: number;
  scrollbarOpacity: number;
  lastCursorY: number;
  cursorMoveEmitter?: { fire(): void };
  isDisposed: boolean;
  renderer?: {
    render(buffer: unknown, full?: boolean, viewportY?: number, term?: unknown, scrollbarOpacity?: number): void;
    stopCursorBlink?(): void;
    cursorBlink?: boolean;
    cursorVisible?: boolean;
  };
}

const BLINK_MS = 530;
// How long frames keep coming after something happens (output, a key, the
// mouse, a scroll): enough for ghostty-web's own animations to finish.
const BUSY_MS = 600;
// Output alone (a build, a log tail) is drawn at most this often: ghostty-web
// redraws every cell of a scrolled screen with fillText, which at the
// display's rate kept a core half busy for one noisy terminal. Typing, the
// mouse and the wheel still draw on the next frame, and so does output for
// a moment after them (the echo of a key, a program's answer).
const OUTPUT_FRAME_MS = 50;
const INPUT_MS = 500;

// drawOnDemand replaces ghostty-web 0.4's render loop, which drew every
// terminal on every animation frame for as long as it existed: hidden
// terminals in background tabs included, and each frame redrew the cursor's
// row whether or not anything had changed (its blink). A dozen terminals
// kept the main thread and the GPU busy with nothing on screen moving.
//
// Here a terminal draws only while it shows, and only for a moment after
// something that can change what it shows: output, input in it (keys, the
// mouse, the wheel, focus), a scroll, a resize, a selection. The cursor
// blinks by its own timer, one frame per blink, and only while the terminal
// has the keyboard; elsewhere it stays lit. Shown again, it redraws whole.
function drawOnDemand(t: object, host: HTMLElement, blink: boolean) {
  const g = t as GhosttyLoop & { onScroll?(fn: () => void): void; onSelectionChange?(fn: () => void): void; onResize?(fn: () => void): void };
  const r = g.renderer;
  if (!r || typeof r.render !== "function" || !g.wasmTerm) return undefined;
  if (g.animationFrameId) cancelAnimationFrame(g.animationFrameId);
  g.animationFrameId = undefined;
  r.stopCursorBlink?.();

  let shown = true;
  let frame = 0;
  let busyUntil = 0;
  let held = false;
  let blinker = 0;
  let full = false;
  let inputAt = -Infinity;
  let drawn = -Infinity;
  const afterDraw: (() => void)[] = [];
  const draw = (now: number) => {
    frame = 0;
    if (g.isDisposed || !shown || !g.wasmTerm) return;
    if (!full && now - inputAt > INPUT_MS && now - drawn < OUTPUT_FRAME_MS) {
      frame = requestAnimationFrame(draw);
      return;
    }
    drawn = now;
    r.render(g.wasmTerm, full, g.viewportY, g, g.scrollbarOpacity);
    full = false;
    for (const fn of afterDraw) fn();
    const y = g.wasmTerm.getCursor().y;
    if (y !== g.lastCursorY) {
      g.lastCursorY = y;
      g.cursorMoveEmitter?.fire();
    }
    if (held || performance.now() < busyUntil) frame = requestAnimationFrame(draw);
  };
  // kick asks for frames for busy ms; output (soon) may wait for its turn.
  const kick = (busy = BUSY_MS, soon = false) => {
    const now = performance.now();
    busyUntil = Math.max(busyUntil, now + busy);
    if (!soon) inputAt = now;
    if (!frame && shown && !g.isDisposed) frame = requestAnimationFrame(draw);
  };
  const focused = () => host.contains(document.activeElement) && document.hasFocus();
  const syncBlink = () => {
    const on = blink && shown && !document.hidden && focused();
    if (on && !blinker) {
      blinker = window.setInterval(() => {
        r.cursorVisible = !r.cursorVisible;
        kick(0);
      }, BLINK_MS);
    } else if (!on && blinker) {
      window.clearInterval(blinker);
      blinker = 0;
      if (!r.cursorVisible) {
        r.cursorVisible = true;
        kick(0);
      }
    }
  };
  const onInput = () => kick();
  const onDown = () => {
    held = true;
    kick();
  };
  const onUp = () => {
    held = false;
    kick();
  };
  const onFocus = () => {
    syncBlink();
    kick();
  };
  const opts = { capture: true, passive: true } as const;
  for (const e of ["keydown", "wheel", "mousemove", "mouseleave", "click", "dblclick"]) host.addEventListener(e, onInput, opts);
  host.addEventListener("mousedown", onDown, opts);
  window.addEventListener("mouseup", onUp, opts);
  host.addEventListener("focusin", onFocus);
  host.addEventListener("focusout", onFocus);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onFocus);
  g.onScroll?.(() => kick());
  g.onSelectionChange?.(() => kick());
  g.onResize?.(() => kick());
  kick();

  return {
    kick,
    onDrawn: (fn: () => void) => void afterDraw.push(fn),
    show(v: boolean) {
      shown = v;
      if (v) {
        full = true;
        kick();
      } else if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      syncBlink();
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (blinker) window.clearInterval(blinker);
      blinker = 0;
      for (const e of ["keydown", "wheel", "mousemove", "mouseleave", "click", "dblclick"]) host.removeEventListener(e, onInput, opts);
      host.removeEventListener("mousedown", onDown, opts);
      window.removeEventListener("mouseup", onUp, opts);
      host.removeEventListener("focusin", onFocus);
      host.removeEventListener("focusout", onFocus);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onFocus);
    },
  };
}

// The parts of ghostty-web's renderer keepLastColumn reaches into.
interface GhosttyRenderer {
  render(buffer: unknown, full?: boolean, viewportY?: number, term?: unknown, scrollbarOpacity?: number): void;
  renderScrollbar(viewportY: number, scrollback: number, rows: number, opacity?: number): void;
}

// keepLastColumn works around ghostty-web 0.4 painting its scrollbar over the
// terminal's last columns. Its scrollbar is an overlay inside the canvas, and
// drawing it first fills a 14px strip at the right edge with the background.
// Terminal.resize renders without passing the scrollbar's opacity, so after
// every fit (a pane split, a window resize) that strip was blanked even with
// no scrollbar showing, and stayed blank on every row that did not change:
// the last column or two of the text went missing. The same happened after
// the scrollbar faded out. Here the strip is only painted while the
// scrollbar shows, and the whole screen is redrawn once it is gone.
function keepLastColumn(t: object) {
  const r = (t as { renderer?: Partial<GhosttyRenderer> }).renderer;
  if (typeof r?.render !== "function" || typeof r.renderScrollbar !== "function") return;
  const render = r.render.bind(r);
  const renderScrollbar = r.renderScrollbar.bind(r);
  let barDrawn = false;
  r.renderScrollbar = (viewportY, scrollback, rows, opacity = 1) => {
    if (opacity <= 0 || scrollback === 0) return;
    barDrawn = true;
    renderScrollbar(viewportY, scrollback, rows, opacity);
  };
  r.render = (buffer, full = false, viewportY = 0, term, opacity) => {
    const shown = opacity ?? (term as { scrollbarOpacity?: number } | undefined)?.scrollbarOpacity ?? 0;
    // The bar was drawn over the text and is now gone: put the text back.
    if (barDrawn && shown <= 0) {
      barDrawn = false;
      full = true;
    }
    render(buffer, full, viewportY, term, shown);
  };
}

// ghostty-web 0.4 reads a row to draw it with getLine(row), which copies the
// whole screen out of WASM and parses every cell of it to return that one
// row: a full redraw (every row, as when scrolling a full-screen program)
// parsed the screen once per row, rows x rows x cols cells, over half of a
// frame's time. Nothing writes to the screen while a frame draws, so here
// the screen is read once per frame.
function oneReadPerFrame(t: object) {
  const r = (t as { renderer?: { render?: (buffer: unknown, ...rest: unknown[]) => void } }).renderer;
  if (typeof r?.render !== "function") return;
  const render = r.render.bind(r);
  r.render = (buffer, ...rest) => {
    const b = buffer as { getViewport?: () => unknown } | undefined;
    const read = b?.getViewport;
    if (!b || typeof read !== "function" || Object.hasOwn(b, "getViewport")) return render(buffer, ...rest);
    let screen: unknown;
    b.getViewport = () => (screen ??= read.call(b));
    try {
      render(buffer, ...rest);
    } finally {
      delete b.getViewport;
    }
  };
}

// catchListeners records the listeners added to the document and the window
// until stop(); release() removes them.
function catchListeners() {
  const caught: [EventTarget, string, EventListenerOrEventListenerObject, boolean | EventListenerOptions | undefined][] = [];
  const targets: EventTarget[] = [document, window];
  const adds = targets.map((target) => {
    const own = Object.getOwnPropertyDescriptor(target, "addEventListener");
    const add = target.addEventListener;
    target.addEventListener = function (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
      if (fn) caught.push([target, type, fn, opts]);
      return add.call(this, type, fn, opts);
    };
    return () => {
      if (own) Object.defineProperty(target, "addEventListener", own);
      else delete (target as { addEventListener?: unknown }).addEventListener;
    };
  });
  return {
    stop: () => adds.forEach((undo) => undo()),
    release: () => {
      for (const [target, type, fn, opts] of caught.splice(0)) target.removeEventListener(type, fn, opts);
    },
  };
}

// Each terminal gets a WASM instance of its own, and reset() clears it in
// place. ghostty-web 0.4 shares one instance (one WASM heap) between every
// terminal, and its reset() frees the terminal and makes a new one. Ghostty
// assumes new page memory is zeroed, which holds for the OS's pages but not
// for WASM memory freed by another terminal (or by reset) and handed out
// again. A terminal made in reused memory looked fine until it grew wider:
// widening a page only bumps its width, so the cells past the old width
// showed whatever the previous owner left there (replacement characters,
// CJK and Arabic glyphs) when a split partner closed or the window grew.
// A fresh instance starts with zeroed memory, and RIS (ESC c) plus erasing
// the scrollback resets without freeing anything. Loading one takes ~5ms.
async function createGhostty(host: HTMLElement, colors: TerminalColors, prefs: TerminalPrefs): Promise<RawHandle> {
  const g = await loadGhostty();
  const ghostty = await g.Ghostty.load();
  const t = new g.Terminal({
    ghostty,
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    cursorStyle: prefs.cursorStyle,
    cursorBlink: prefs.cursorBlink,
    scrollback: prefs.scrollback,
    theme: theme(colors),
  });
  const fit = new g.FitAddon();
  t.loadAddon(fit);
  // ghostty-web focuses itself on open, once at once and again a tick later
  // (a setTimeout), so putting focus back afterwards lost to the second one:
  // a split an agent opened beside you took the keyboard while the pane you
  // were in still looked focused. Its focus is switched off while it opens.
  // Whoever has the keyboard keeps it; the pane focuses its terminal itself
  // when it should (TerminalView).
  t.focus = () => {};
  // What open() hangs on the document and the window, to take off again on
  // dispose: ghostty-web 0.4 leaves some there (its selection's mousedown
  // and mouseup), and with them the whole terminal, WASM memory included,
  // for every terminal ever closed.
  const hung = catchListeners();
  try {
    t.open(host);
  } finally {
    hung.stop();
    delete (t as { focus?: unknown }).focus;
  }
  keepLastColumn(t);
  oneReadPerFrame(t);
  const frames = drawOnDemand(t, host, prefs.cursorBlink);
  const { openUrl } = await import("@/lib/open-url");
  const links = ghosttyLinks(t, host, openUrl);
  forTests(host, t);
  // Output still on its way when the terminal is replaced (a new font size,
  // ⌘+) is dropped: ghostty-web throws on a write after dispose.
  let disposed = false;
  const parsed: (() => void)[] = [];
  const gs = t as unknown as GhosttyScreen;
  return {
    get cols() {
      return t.cols;
    },
    get rows() {
      return t.rows;
    },
    write: (d) => {
      if (disposed) return;
      t.write(d);
      frames?.kick(BUSY_MS, true);
      for (const fn of parsed) fn();
    },
    // Full reset, then erase the scrollback: see createGhostty.
    reset: () => {
      if (disposed) return;
      t.write("\x1bc\x1b[3J");
      frames?.kick();
    },
    fit: () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet.
      }
      frames?.kick();
    },
    focus: () => t.focus(),
    setTheme: (c) => {
      t.options.theme = theme(c);
      frames?.kick();
    },
    onData: (fn) => void t.onData(fn),
    onResize: (fn) => void t.onResize(fn),
    hasSelection: () => t.hasSelection(),
    selection: () => t.getSelection(),
    paste: (text) => {
      t.paste(text);
      frames?.kick();
    },
    show: (v) => frames?.show(v),
    screen: () => (disposed ? null : ghosttyScreen(gs)),
    geometry: () => {
      const canvas = gs.renderer?.getCanvas?.();
      const m = gs.renderer?.getMetrics?.();
      if (!canvas || !m || !canvas.isConnected) return null;
      return { el: canvas, cellWidth: m.width, cellHeight: m.height, baseline: m.baseline };
    },
    onParsed: (fn) => void parsed.push(fn),
    // Without the frame loop (a ghostty-web that changed inside), a frame
    // is assumed a moment after output.
    onDrawn: (fn) => (frames ? frames.onDrawn(fn) : void parsed.push(() => requestAnimationFrame(() => requestAnimationFrame(fn)))),
    registerLinkFinder: (find) => links.addFinder(find),
    onLinkHint: (fn) => links.onHint(fn),
    dispose: () => {
      disposed = true;
      links.dispose();
      frames?.dispose();
      t.dispose();
      hung.release();
    },
  };
}

// The parts of ghostty-web 0.4 its links go through: the link detector,
// which asks each provider for a row's links when the pointer is over it
// and runs the one under a click (activate) on any click, and the rows'
// cells.
interface GhosttyLink {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate(e: MouseEvent): void;
  hover?(hovered: boolean): void;
}
interface GhosttyLinkProvider {
  provideLinks(y: number, callback: (links: GhosttyLink[] | undefined) => void): void;
}
interface GhosttyCell {
  getChars(): string;
  getHyperlinkId(): number;
}
interface GhosttyRow {
  length: number;
  // That this row goes on from the one above, which the terminal
  // soft-wrapped onto it (as in xterm.js; ghostty-web 0.4's own docs say
  // "wraps to the next line", but it reads the row's continuation). Rows
  // of the screen only: one in the history always says false.
  isWrapped?: boolean;
  getCell(x: number): GhosttyCell | undefined;
}
interface GhosttyLinks {
  write(data: string | Uint8Array, callback?: () => void): void;
  linkDetector?: { providers?: GhosttyLinkProvider[]; invalidateCache?(): void };
  buffer: { active: { getLine(y: number): GhosttyRow | undefined } };
  renderer?: { getCanvas?(): HTMLCanvasElement };
  registerLinkProvider(p: GhosttyLinkProvider): void;
}

// rowText is a row's text with one character per cell, so that a match's
// place in it is a column: an empty cell (erased, the right half of a wide
// character) reads as a space, where translateToString leaves it out.
function rowText(row: GhosttyRow): string {
  let s = "";
  for (let x = 0; x < row.length; x++) {
    const c = row.getCell(x)?.getChars() ?? "";
    // One UTF-16 unit per cell; an astral character (an emoji) is a space.
    s += c.length === 1 ? c : " ";
  }
  return s;
}

// ghosttyLinks makes a terminal's links open with ⌘-click (Ctrl-click off
// a Mac), as in Terminal, iTerm2 and Ghostty, and says so.
//
// ghostty-web 0.4 found web addresses and OSC 8 hyperlinks itself and
// opened them with window.open on ⌘-click, but it underlined a link and
// showed the pointing hand on a plain hover, where a plain click does
// nothing: links looked clickable and weren't. Its OSC 8 links never
// opened at all (it can't read their address back from its WASM, so they
// had none). Here its providers are replaced: addresses are found per cell,
// OSC 8 addresses are read from the output (lib/term-links), and both open
// through openUrl, the system browser in the app. The hand shows only while
// ⌘ is held; without it, resting on a link shows how to open it (onHint).
function ghosttyLinks(term: object, host: HTMLElement, openUrl: (url: string) => Promise<void>) {
  const t = term as GhosttyLinks;
  const tracker = new HyperlinkTracker();
  const providers = t.linkDetector?.providers;
  const canvas = t.renderer?.getCanvas?.();
  const hints = new Set<(at: { x: number; y: number } | null) => void>();
  let hovered: { key: string; link: GhosttyLink } | undefined;
  let held = false;
  let at: { x: number; y: number } | null = null;
  let hintKey = "";
  let hintTimer = 0;

  const say = (to: { x: number; y: number } | null) => {
    for (const fn of hints) fn(to);
  };
  const sync = () => {
    if (canvas && providers) canvas.style.cursor = hovered && held ? "pointer" : "text";
    const key = hovered && !held && at ? hovered.key : "";
    if (key === hintKey) return;
    hintKey = key;
    window.clearTimeout(hintTimer);
    say(null);
    // As long as a tooltip waits (components/tip), so sweeping across the
    // screen doesn't flash one at every link.
    if (key) hintTimer = window.setTimeout(() => hintKey === key && at && say(at), 300);
  };
  // A link hovers and leaves through ghostty-web (hover); the same link
  // found again after output (a new object) is the same link here.
  const watched = (link: GhosttyLink): GhosttyLink => {
    const key = `${link.range.start.y}:${link.range.start.x}:${link.range.end.y}:${link.range.end.x}:${link.text}`;
    return {
      ...link,
      // ghostty-web leaves the old link before it enters the new one: the
      // pair settles before anything changes on screen.
      hover(on) {
        if (on) hovered = { key, link };
        else if (hovered?.link === link) hovered = undefined;
        queueMicrotask(sync);
      },
    };
  };
  // The rows a provider reads, each read once per question. An address
  // that runs on over several rows (a sign-in link hundreds of characters
  // long) is found whole, from any of its rows (lib/term-links joinRows).
  const reader = () => {
    const lines = new Map<number, GhosttyRow | undefined>();
    const texts = new Map<number, string | undefined>();
    const line = (y: number) => {
      if (!lines.has(y)) lines.set(y, y < 0 ? undefined : t.buffer.active.getLine(y));
      return lines.get(y);
    };
    const rows: Rows & { line(y: number): GhosttyRow | undefined } = {
      line,
      text(y) {
        if (!texts.has(y)) {
          const row = line(y);
          texts.set(y, row && rowText(row));
        }
        return texts.get(y);
      },
      wrapped: (y) => line(y + 1)?.isWrapped === true,
    };
    return rows;
  };
  const provider = (find: (rows: ReturnType<typeof reader>, y: number) => GhosttyLink[]): GhosttyLinkProvider => ({
    provideLinks(y, callback) {
      const rows = reader();
      const links = rows.line(y) ? find(rows, y).map(watched) : [];
      callback(links.length ? links : undefined);
    },
  });
  const open = (uri: string) => (e: MouseEvent) => {
    if (modKey(e) && openable(uri)) void openUrl(uri);
  };
  const urls = provider((rows, y) => linksAround(rows, y, findUrls).map(({ match, span }) => ({ text: match.url, range: span, activate: open(match.url) })));
  // Each run of cells in one OSC 8 hyperlink, by the address its text had.
  // A run that fills a row to its end and goes on at the start of the next
  // row in the same hyperlink is one link over both.
  const osc8 = provider((rows, y) => {
    const row = rows.line(y)!;
    const id = (r: GhosttyRow | undefined, x: number) => r?.getCell(x)?.getHyperlinkId() ?? 0;
    const out: GhosttyLink[] = [];
    for (let x = 0; x < row.length; ) {
      const h = id(row, x);
      let end = x + 1;
      while (end < row.length && id(row, end) === h) end++;
      if (h) {
        const start = { x, y };
        const own = rows.text(y)!.slice(x, end);
        let text = own;
        for (let n = 0; start.x === 0 && n < 32; n++) {
          const prev = rows.line(start.y - 1);
          if (!prev?.length || id(prev, prev.length - 1) !== h) break;
          let from = prev.length - 1;
          while (from > 0 && id(prev, from - 1) === h) from--;
          text = rows.text(start.y - 1)!.slice(from) + text;
          start.y--;
          start.x = from;
        }
        const last = { x: end - 1, y };
        for (let n = 0; last.x === row.length - 1 && n < 32; n++) {
          const next = rows.line(last.y + 1);
          if (!next?.length || id(next, 0) !== h) break;
          let to = 1;
          while (to < next.length && id(next, to) === h) to++;
          text += rows.text(last.y + 1)!.slice(0, to);
          last.y++;
          last.x = to - 1;
        }
        // tmux sends the hyperlink again on each row it redraws, so the
        // text it was sent with can be just this row's piece.
        const uri = tracker.uriFor(text) ?? tracker.uriFor(own);
        if (uri && openable(uri)) out.push({ text: uri, range: { start, end: last }, activate: open(uri) });
      }
      x = end;
    }
    return out;
  });
  // ghostty-web caches each row's links, keyed by the hyperlink a link
  // starts in when it does: providers later in the list win there, so an
  // OSC 8 link's own address beats an address its text shows.
  if (providers) {
    providers.splice(0, providers.length, urls, osc8);
    t.linkDetector?.invalidateCache?.();
    // Everything the terminal is given, read for OSC 8 on the way in.
    const write = t.write.bind(t);
    t.write = (data, callback) => {
      tracker.feed(data);
      write(data, callback);
    };
  }

  const onMove = (e: MouseEvent) => {
    at = { x: e.clientX, y: e.clientY };
    held = modKey(e);
    sync();
  };
  const onLeave = () => {
    at = null;
    sync();
  };
  const onKey = (e: KeyboardEvent) => {
    if (held === modKey(e)) return;
    held = modKey(e);
    sync();
  };
  const onBlur = () => {
    held = false;
    sync();
  };
  const opts = { capture: true, passive: true } as const;
  host.addEventListener("mousemove", onMove, opts);
  host.addEventListener("mouseleave", onLeave, opts);
  window.addEventListener("keydown", onKey, opts);
  window.addEventListener("keyup", onKey, opts);
  window.addEventListener("blur", onBlur);
  sync();

  return {
    // A finder's links (file paths) go before the OSC 8 ones.
    addFinder(find: LinkFinder) {
      const p = provider((rows, y) =>
        linksAround(rows, y, (line) => find(line.trimEnd())).map(({ match, text, span }) => ({ text, range: span, activate: (e: MouseEvent) => match.activate(e) })),
      );
      if (!providers) return t.registerLinkProvider(p);
      providers.splice(providers.indexOf(osc8), 0, p);
      t.linkDetector?.invalidateCache?.();
    },
    onHint(fn: (at: { x: number; y: number } | null) => void) {
      hints.add(fn);
    },
    dispose() {
      window.clearTimeout(hintTimer);
      hints.clear();
      host.removeEventListener("mousemove", onMove, opts);
      host.removeEventListener("mouseleave", onLeave, opts);
      window.removeEventListener("keydown", onKey, opts);
      window.removeEventListener("keyup", onKey, opts);
      window.removeEventListener("blur", onBlur);
    },
  };
}

// xterm.js draws only what changed, and stops drawing while its element is
// off screen (an IntersectionObserver), so it needs no help when hidden.
async function createXterm(host: HTMLElement, colors: TerminalColors, prefs: TerminalPrefs): Promise<RawHandle> {
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  const { openUrl } = await import("@/lib/open-url");
  const t = new Terminal({
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    letterSpacing: 0,
    cursorStyle: prefs.cursorStyle,
    cursorInactiveStyle: "outline",
    cursorBlink: prefs.cursorBlink,
    scrollback: prefs.scrollback,
    minimumContrastRatio: 4.5,
    macOptionIsMeta: true,
    allowProposedApi: true,
    theme: theme(colors),
    // OSC 8 hyperlinks open like the addresses below. Without a handler,
    // xterm.js asks with confirm() and then opens a blank window.open(),
    // neither of which the app's webview does.
    linkHandler: { activate: (_e, uri) => void (openable(uri) && openUrl(uri)) },
  });
  const fit = new FitAddon();
  t.loadAddon(fit);
  t.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
  t.open(host);
  forTests(host, t);
  return {
    get cols() {
      return t.cols;
    },
    get rows() {
      return t.rows;
    },
    write: (d) => t.write(d),
    reset: () => t.reset(),
    fit: () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet.
      }
    },
    focus: () => t.focus(),
    setTheme: (c) => {
      t.options.theme = theme(c);
    },
    onData: (fn) => void t.onData(fn),
    onResize: (fn) => void t.onResize(fn),
    hasSelection: () => t.hasSelection(),
    selection: () => t.getSelection(),
    paste: (text) => t.paste(text),
    screen: () => xtermScreen(t),
    geometry: () => {
      const el = t.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!el || !t.cols || !t.rows || !el.isConnected) return null;
      const cellWidth = el.clientWidth / t.cols;
      const cellHeight = el.clientHeight / t.rows;
      if (!cellWidth || !cellHeight) return null;
      return { el, cellWidth, cellHeight, baseline: centredBaseline(prefs, cellHeight) };
    },
    onParsed: (fn) => void t.onWriteParsed(fn),
    onDrawn: (fn) => void t.onRender(fn),
    registerLinkFinder: (find) =>
      void t.registerLinkProvider({
        provideLinks(y, callback) {
          const text = t.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
          const links = find(text).map((l) => ({
            text: text.slice(l.start, l.end),
            range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
            activate: (e: MouseEvent) => l.activate(e),
          }));
          callback(links.length ? links : undefined);
        },
      }),
    onLinkHint: () => {},
    dispose: () => t.dispose(),
  };
}

// The parts of ghostty-web 0.4 a Screen reads: the WASM terminal's cursor
// and cells (getViewport reads the active screen whole, in one call), and
// how far the view is scrolled back.
interface GhosttyScreen {
  viewportY: number;
  wasmTerm?: {
    cols: number;
    rows: number;
    getCursor(): { x: number; y: number; visible: boolean };
    getViewport(): { codepoint: number }[];
    isAlternateScreen(): boolean;
  };
  renderer?: {
    getCanvas?(): HTMLCanvasElement;
    getMetrics?(): { width: number; height: number; baseline: number };
  };
}

function ghosttyScreen(t: GhosttyScreen): Screen | null {
  const w = t.wasmTerm;
  if (!w || t.viewportY !== 0) return null;
  // getCursor brings the render state up to date first; then the cells.
  const c = w.getCursor();
  const cols = w.cols;
  let cells: { codepoint: number }[] | undefined;
  return {
    cols,
    rows: w.rows,
    cursorX: c.x,
    cursorY: c.y,
    cursorVisible: c.visible,
    alternate: w.isAlternateScreen(),
    cell(x, y) {
      cells ??= w.getViewport();
      const cp = cells[y * cols + x]?.codepoint;
      return cp ? String.fromCodePoint(cp) : " ";
    },
  };
}

// The parts of xterm.js 5 a Screen reads. Whether the cursor shows is only
// kept inside (coreService); it counts as shown if that ever moves.
type XtermLike = {
  cols: number;
  rows: number;
  buffer: { active: { type: string; cursorX: number; cursorY: number; viewportY: number; baseY: number; getLine(y: number): { getCell(x: number): { getChars(): string } | undefined } | undefined } };
};

function xtermScreen(t: XtermLike): Screen | null {
  const b = t.buffer.active;
  if (b.viewportY !== b.baseY) return null;
  const hidden = (t as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core?.coreService?.isCursorHidden;
  return {
    cols: t.cols,
    rows: t.rows,
    cursorX: b.cursorX,
    cursorY: b.cursorY,
    cursorVisible: hidden !== true,
    alternate: b.type === "alternate",
    cell: (x, y) => b.getLine(b.baseY + y)?.getCell(x)?.getChars() || " ",
  };
}

// xterm.js's DOM renderer centres each line's text in its cell: the
// baseline sits half the leftover height below the font's ascent.
function centredBaseline(prefs: TerminalPrefs, cellHeight: number): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return cellHeight * 0.75;
  ctx.font = `${prefs.fontSize}px ${prefs.fontFamily}`;
  const m = ctx.measureText("M");
  const ascent = m.fontBoundingBoxAscent || prefs.fontSize * 0.8;
  const descent = m.fontBoundingBoxDescent || prefs.fontSize * 0.2;
  return (cellHeight - ascent - descent) / 2 + ascent;
}
