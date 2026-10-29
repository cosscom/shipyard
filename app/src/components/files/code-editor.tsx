// The File tab's editor: CodeMirror 6 in the app's type and colours, its
// code coloured by the same Shiki theme the diff view uses
// (lib/syntax-colors.ts), so a file reads alike here and in Compare. This
// module is its own chunk, loaded the first time a File tab or the
// picker's preview shows, never with the app; languages load on first use.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, type LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, EditorView, GutterMarker, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

import { useActiveTheme } from "@/hooks/use-theme";
import type { Theme } from "@/lib/api";
import type { Changes } from "@/lib/file-marks";
import { patchText } from "@/lib/file-marks";
import { cssVars, readableStyles, type ShikiTheme, syntaxColors } from "@/lib/syntax-colors";
import { syntaxThemes } from "@/themes/apply";
import { mix, readable } from "@/themes/color";

export interface CodeEditorProps {
  path: string;
  text: string;
  onChange?(text: string): void;
  onSave?(): void;
  // The margin's marks: the agent's lines this turn and your unsaved ones.
  changes?: Changes;
  // Lines tinted as under conflict (the agent's version differs there).
  conflictLines?: number[];
  readOnly?: boolean;
  // Scroll this line near the top (1-based); reveal changes when asked to
  // go there again.
  revealLine?: number;
  // The last line of a range to select from revealLine (editable only).
  revealEnd?: number;
  reveal?: number;
  wrap?: boolean;
  fontSize?: number;
  className?: string;
  style?: CSSProperties;
}

// ---- Languages, loaded on first use ----

const LANGS: [RegExp, () => Promise<LanguageSupport>][] = [
  [/\.(tsx|jsx)$/i, () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true }))],
  [/\.(ts|mts|cts)$/i, () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true }))],
  [/\.(js|mjs|cjs)$/i, () => import("@codemirror/lang-javascript").then((m) => m.javascript())],
  [/\.(json|jsonc)$/i, () => import("@codemirror/lang-json").then((m) => m.json())],
  [/\.(css|scss)$/i, () => import("@codemirror/lang-css").then((m) => m.css())],
  [/\.(md|mdx|markdown)$/i, () => import("@codemirror/lang-markdown").then((m) => m.markdown())],
  [/\.(html?|svg|xml|vue|svelte)$/i, () => import("@codemirror/lang-html").then((m) => m.html())],
  [/\.py$/i, () => import("@codemirror/lang-python").then((m) => m.python())],
  [/\.go$/i, () => import("@codemirror/lang-go").then((m) => m.go())],
  [/\.rs$/i, () => import("@codemirror/lang-rust").then((m) => m.rust())],
  [/\.(ya?ml)$/i, () => import("@codemirror/lang-yaml").then((m) => m.yaml())],
  [/\.sql$/i, () => import("@codemirror/lang-sql").then((m) => m.sql())],
];

const languageFor = (path: string) => LANGS.find(([re]) => re.test(path))?.[1];

// ---- Colours ----

const v = (role: string) => ({ color: `var(--syn-${role}, var(--syn-text))`, fontStyle: `var(--syn-${role}-i, normal)`, fontWeight: `var(--syn-${role}-b, inherit)` });

// Shared with the SQL editor plugins get (sql-editor.tsx).
export const highlight = HighlightStyle.define([
  { tag: t.keyword, ...v("keyword") },
  { tag: t.controlKeyword, ...v("control") },
  { tag: t.moduleKeyword, ...v("module") },
  { tag: t.definitionKeyword, ...v("definition") },
  { tag: t.modifier, ...v("modifier") },
  { tag: t.operatorKeyword, ...v("operatorWord") },
  { tag: t.self, ...v("self") },
  { tag: t.string, ...v("string") },
  { tag: t.special(t.string), ...v("template") },
  { tag: t.regexp, ...v("regexp") },
  { tag: t.escape, ...v("escape") },
  { tag: t.comment, ...v("comment") },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], ...v("function") },
  { tag: t.typeName, ...v("type") },
  { tag: t.className, ...v("className") },
  { tag: t.namespace, ...v("namespace") },
  { tag: t.number, ...v("number") },
  { tag: [t.bool, t.atom], ...v("bool") },
  { tag: t.null, ...v("null") },
  { tag: t.propertyName, ...v("property") },
  { tag: t.definition(t.propertyName), ...v("key") },
  { tag: [t.variableName, t.labelName], ...v("variable") },
  { tag: t.definition(t.variableName), ...v("constant") },
  { tag: t.tagName, ...v("tag") },
  { tag: t.attributeName, ...v("attribute") },
  { tag: t.operator, ...v("operator") },
  { tag: [t.punctuation, t.separator], ...v("punctuation") },
  { tag: [t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket], ...v("bracket") },
  { tag: t.heading, ...v("heading"), fontWeight: "600" },
  { tag: t.emphasis, ...v("emphasis"), fontStyle: "italic" },
  { tag: t.strong, ...v("strong"), fontWeight: "700" },
  { tag: [t.link, t.url], ...v("link"), textDecoration: "underline" },
  { tag: t.quote, ...v("quote") },
  { tag: t.monospace, ...v("code") },
  { tag: [t.meta, t.annotation], ...v("meta") },
  { tag: t.invalid, ...v("invalid") },
]);

// Until the theme's Shiki colours load (once per theme), its terminal
// palette stands in.
function fallbackVars(theme: Theme): Record<string, string> {
  // The terminal's colours, made to read on the page (and the active
  // line's tint) as the Shiki ones are.
  const bg = mix(theme.colors.foreground, theme.colors.background, 0.035);
  const c = Object.fromEntries(Object.entries(theme.terminal).map(([k, v]) => [k, readable(v, bg)])) as unknown as Theme["terminal"];
  const fg = theme.colors.foreground;
  return {
    "--syn-text": fg,
    "--syn-keyword": c.magenta,
    "--syn-string": c.green,
    "--syn-comment": c.brightBlack,
    "--syn-comment-i": "italic",
    "--syn-function": c.blue,
    "--syn-type": c.yellow,
    "--syn-number": c.cyan,
    "--syn-property": fg,
    "--syn-tag": c.red,
    "--syn-punctuation": fg,
  };
}

const shikiCache = new Map<string, Record<string, string>>();

// useSyntaxVars is the active theme's code colours as custom properties.
export function useSyntaxVars(theme: Theme): Record<string, string> {
  const name = theme.appearance === "dark" ? syntaxThemes(theme).dark : syntaxThemes(theme).light;
  // Each colour reads on this theme's background (4.5:1, lightness only),
  // the active line's tint included.
  const bg = mix(theme.colors.foreground, theme.colors.background, 0.035);
  const key = `${name}|${bg}`;
  const [vars, setVars] = useState(() => shikiCache.get(key));
  useEffect(() => {
    const have = shikiCache.get(key);
    if (have) return setVars(have);
    setVars(undefined);
    let live = true;
    import("@pierre/diffs")
      .then((m) => m.resolveTheme(name))
      .then((resolved) => {
        const out = cssVars(readableStyles(syntaxColors(resolved as unknown as ShikiTheme), bg));
        shikiCache.set(key, out);
        if (live) setVars(out);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [name, key, bg]);
  return vars ?? fallbackVars(theme);
}

// ---- The editor's chrome, in the app's tokens ----

export const chrome = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--syn-text)", fontSize: "var(--ed-font)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    fontVariantLigatures: "none",
    overflow: "auto",
    scrollbarWidth: "thin",
    scrollbarColor: "color-mix(in oklab, var(--muted-foreground) 35%, transparent) transparent",
  },
  ".cm-content": { padding: "10px 0 40vh", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 24px 0 14px" },
  // Line numbers read at 4.5:1, as muted text does everywhere.
  ".cm-gutters": { backgroundColor: "var(--background)", border: "none", color: "var(--muted-foreground)" },
  // On the Mac's glass, the card's colour, still opaque: code scrolled
  // sideways passes under the line numbers (index.css, --content-solid).
  ":root.native-vibrancy & .cm-gutters": { backgroundColor: "var(--content-solid)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 18px", minWidth: "40px", fontVariantNumeric: "tabular-nums" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLineGutter": { color: "var(--foreground)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--foreground) 3.5%, transparent)" },
  "&:not(.cm-focused) .cm-activeLine": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)", borderLeftWidth: "1.5px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--ed-selection) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--ed-selection) 55%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--foreground) 10%, transparent)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warning) 28%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--warning) 45%, transparent)" },
  // The agent's marks, beside the line numbers.
  ".cm-agent-gutter": { width: "10px" },
  ".cm-agent-gutter .cm-gutterElement": { position: "relative" },
  ".cm-agent-bar": { position: "absolute", left: "3px", top: "0", bottom: "0", width: "3px" },
  ".cm-agent-bar[data-mark=added]": { backgroundColor: "var(--success)" },
  ".cm-agent-bar[data-mark=modified]": { backgroundColor: "var(--info)" },
  ".cm-agent-bar[data-mark=own]": { backgroundColor: "color-mix(in oklab, var(--muted-foreground) 60%, transparent)" },
  ".cm-agent-del": { position: "absolute", left: "1px", bottom: "-4px", width: "0", height: "0", borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "6px solid var(--destructive)", zIndex: "2" },
  ".cm-agent-del[data-top]": { top: "-4px", bottom: "auto" },
  ".cm-conflict-line": { backgroundColor: "color-mix(in oklab, var(--warning) 13%, transparent) !important", boxShadow: "inset 2px 0 0 var(--warning)" },
  ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { fontFamily: "var(--font-sans)", fontSize: "12px" },
  ".cm-textfield": { borderRadius: "6px", border: "1px solid var(--border)", background: "var(--background)", color: "var(--foreground)" },
  ".cm-button": { borderRadius: "6px", border: "1px solid var(--border)", backgroundImage: "none", background: "var(--secondary)", color: "var(--foreground)" },
});

// ---- The marks, as state the component updates ----

const setMarks = StateEffect.define<{ changes?: Changes; conflict?: number[] }>();

class Bar extends GutterMarker {
  constructor(
    readonly mark: "added" | "modified" | "own" | undefined,
    readonly del: "below" | "above" | undefined,
  ) {
    super();
  }
  eq(o: Bar) {
    return o.mark === this.mark && o.del === this.del;
  }
  toDOM() {
    const el = document.createElement("div");
    if (this.mark) {
      const bar = el.appendChild(document.createElement("span"));
      bar.className = "cm-agent-bar";
      bar.dataset.mark = this.mark;
    }
    if (this.del) {
      const d = el.appendChild(document.createElement("span"));
      d.className = "cm-agent-del";
      if (this.del === "above") d.dataset.top = "";
    }
    return el;
  }
}

const marksField = StateField.define<{ changes?: Changes; conflict?: number[] }>({
  create: () => ({}),
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    return val;
  },
});

const lineStart = (state: EditorState, n: number) => (n >= 1 && n <= state.doc.lines ? state.doc.line(n).from : undefined);

const marksChanged = (u: ViewUpdate) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setMarks)));

const agentGutter = gutter({
  class: "cm-agent-gutter",
  lineMarkerChange: marksChanged,
  markers(view) {
    const c = view.state.field(marksField).changes;
    if (!c) return RangeSet.empty;
    const nums = new Set([...c.lines.keys(), ...[...c.deleted].map((d) => Math.max(1, d))]);
    const out: { from: number; marker: GutterMarker }[] = [];
    for (const n of [...nums].sort((a, b) => a - b)) {
      const from = lineStart(view.state, n);
      if (from === undefined) continue;
      const del = c.deleted.has(n) ? "below" : n === 1 && c.deleted.has(0) ? "above" : undefined;
      out.push({ from, marker: new Bar(c.lines.get(n), del) });
    }
    return RangeSet.of(out.map((o) => o.marker.range(o.from)));
  },
  initialSpacer: () => new Bar(undefined, undefined),
});

const conflictTints = EditorView.decorations.compute([marksField, "doc"], (state): DecorationSet => {
  const out = [];
  for (const n of state.field(marksField).conflict ?? []) {
    const from = lineStart(state, n);
    if (from !== undefined) out.push(Decoration.line({ class: "cm-conflict-line" }).range(from));
  }
  return Decoration.set(out, true);
});

// ---- The component ----

export function CodeEditor({ path, text, onChange, onSave, changes, conflictLines, readOnly, revealLine, revealEnd, reveal, wrap, fontSize = 12.5, className, style }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const lang = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const theme = useActiveTheme();
  const syntax = useSyntaxVars(theme);

  // One view for the pane's life; text, marks and wrapping follow by
  // transaction.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          marksField,
          lineNumbers(),
          agentGutter,
          conflictTints,
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(highlight),
          lang.current.of([]),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
          chrome,
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          // In the Tab order always: read only, it still scrolls with the arrows.
          EditorView.contentAttributes.of({ "aria-label": `${path.split("/").pop()}, ${readOnly ? "read only" : "editable"}`, tabindex: "0" }),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave?.(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
          }),
        ] satisfies Extension[],
      }),
    });
    view.current = v;
    let live = true;
    languageFor(path)?.()
      .then((l) => live && v.dispatch({ effects: lang.current.reconfigure(l) }))
      .catch(() => {});
    return () => {
      live = false;
      v.destroy();
      view.current = null;
    };
    // A new path or mode is a new editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly]);

  // Text from outside (the agent wrote it, Reload): only what differs is
  // replaced, so the cursor and scroll stay where they were.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const p = patchText(v.state.doc.toString(), text);
    if (p) v.dispatch({ changes: p });
  }, [text]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of({ changes, conflict: conflictLines }) });
  }, [changes, conflictLines, path, readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    const v = view.current;
    if (!v || !revealLine || revealLine > v.state.doc.lines) return;
    const pos = v.state.doc.line(revealLine).from;
    const head = revealEnd && revealEnd > revealLine ? v.state.doc.line(Math.min(revealEnd, v.state.doc.lines)).to : undefined;
    v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 48 }), ...(readOnly ? {} : { selection: { anchor: pos, head } }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealLine, revealEnd, reveal, path]);

  const vars = useMemo(
    () =>
      ({
        ...syntax,
        "--ed-selection": theme.terminal.selectionBackground ?? "color-mix(in oklab, var(--ring) 40%, transparent)",
        "--ed-font": `${fontSize}px`,
      }) as CSSProperties,
    [syntax, theme, fontSize],
  );

  return <div ref={host} className={className} style={{ ...vars, ...style }} data-testid="code-editor" />;
}

export default CodeEditor;
