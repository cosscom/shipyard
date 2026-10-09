import { type CSSProperties, memo, useEffect, useRef, useState } from "react";

import { builtin } from "@/components/art/chat-backgrounds";
import { type HarbourLight, useHarbourLight } from "@/components/art/harbour-art";
import { useActiveTheme } from "@/hooks/use-theme";
import { type ChatBackground as Bg, imageBlob } from "@/lib/chat-background";
import { type Img, render, type RGB, type Source, type ThemeColours } from "@/lib/chat-background-render";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { scrollBehavior } from "@/lib/motion";

import "@/components/conversation/chat-background.css";

// ChatBackground is what is behind a conversation (Settings › Appearance ›
// Chat background), and, when it needs one, a reading sheet that keeps the
// conversation legible over it: lib/chat-background-render.ts measures how
// opaque. The built-ins at their default strength need little or none. It
// sits behind the pane's content (the pane is `isolate`), takes no
// pointer, and draws once per change of background, effect, theme or size,
// debounced.

export const ChatBackground = memo(function ChatBackground() {
  const bg = usePrefs((p) => p.chatBackground);
  if (bg.source === "none" || (bg.source === "image" && !bg.image)) return null;
  return <Layer bg={bg} />;
});

function Layer({ bg }: { bg: Bg }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { drawn, sheet, pixelated } = useRendered(wrap, canvas, bg);
  const full = usePrefs((p) => p.chatWidth === "full");
  return (
    <div ref={wrap} aria-hidden data-testid="chat-background" data-drawn={drawn || undefined} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" style={{ "--chat-sheet": `${Math.round(sheet * 100)}%` } as CSSProperties}>
      <canvas ref={canvas} className={cn("absolute inset-0 size-full transition-opacity duration-300", pixelated && "[image-rendering:pixelated]", drawn ? "opacity-100" : "opacity-0")} />
      {/* The reading column stays clean: the plain page lies over the
          background behind the conversation and its composer, easing in
          from the column's edges, so the background lives in the margins.
          It follows the column: the pane's padding, the loops panel's room
          when there is room for it, the chat's width. At Full the column
          is the pane, so the fade is wider and the edges keep a little. A
          picture shown as it is is loud, so its fade ends before the column. */}
      <div className="absolute inset-y-0 right-6 left-6 @[900px]:right-[max(24px,var(--berth-loops-w,0px))]">
        <div className="relative mx-auto h-full max-w-(--berth-chat-w)">
          <div data-glass={bg.original || undefined} data-full={full || undefined} className={cn("cb-sheet absolute inset-y-0 transition-opacity duration-300", bg.original ? "-inset-x-24" : "-inset-x-6", drawn ? "opacity-100" : "opacity-0")} />
        </div>
      </div>
    </div>
  );
}

// openChatBackgroundSettings shows Settings › Appearance at its Chat
// background, for the pane menu's "Chat background…".
export function openChatBackgroundSettings() {
  useStore.getState().setView({ kind: "settings", section: "appearance" });
  window.setTimeout(() => document.getElementById("chat-background")?.scrollIntoView({ block: "start", behavior: scrollBehavior() }), 80);
}

// useRendered draws bg into the canvas at the size of wrap, and again when
// it changes.
export function useRendered(wrap: React.RefObject<HTMLElement | null>, canvas: React.RefObject<HTMLCanvasElement | null>, bg: Bg, unit = 1) {
  const theme = useActiveTheme();
  const light = useHarbourLight();
  const [state, setState] = useState({ drawn: false, sheet: 0, pixelated: false });
  const key = sourceKey(bg, light);
  const effects = JSON.stringify([bg.strength, bg.dither, bg.tone, bg.original, bg.fit, bg.position]);

  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv || !key) return;
    let alive = true;
    let timer = 0;
    let pending = false;
    let size = "";
    const draw = async () => {
      if (document.hidden) {
        pending = true;
        return;
      }
      pending = false;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h || `${w}x${h}` === size) return;
      const src = await loadSource(bg, light).catch(() => undefined);
      if (!alive || !src) return;
      size = `${w}x${h}`;
      const r = render(cv, src, w, h, window.devicePixelRatio || 1, bg, themeColours(el, theme.appearance === "dark"), unit);
      setState({ drawn: true, ...r });
    };
    const later = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void draw(), ms);
    };
    const onVisible = () => pending && !document.hidden && void draw();
    const ro = new ResizeObserver(() => later(150));
    ro.observe(el);
    document.addEventListener("visibilitychange", onVisible);
    // Sliders move in small steps: draw once they rest a moment.
    later(40);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
    };
    // bg is read through key and effects; theme through its id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, effects, theme.id, theme.appearance, unit]);

  // Give the pixels back when the background goes.
  useEffect(() => {
    const cv = canvas.current;
    return () => {
      if (cv) cv.width = cv.height = 0;
    };
  }, [canvas]);
  return state;
}

function sourceKey(bg: Bg, light: HarbourLight): string {
  if (bg.source === "image") return bg.image ? `i:${bg.image.id}` : "";
  if (bg.source !== "builtin") return "";
  const b = builtin(bg.builtin);
  return b.src ? `s:${b.src(light)}` : `${b.kind}:${b.id}`;
}

// Decoded pictures are kept, a few at a time, so moving a slider (or
// drawing every tile in Settings) never decodes one again.
const pictures = new Map<string, Promise<Img>>();
const KEEP = 12;

export function loadSource(bg: Bg, light: HarbourLight): Promise<Source> {
  const b = bg.source === "builtin" ? builtin(bg.builtin) : undefined;
  if (b && !b.src) return Promise.resolve({ kind: b.kind as "pattern" | "gradient", id: b.id });
  const key = sourceKey(bg, light);
  let img = pictures.get(key);
  if (!img) {
    img = (async (): Promise<Img> => {
      if (bg.source === "image" && bg.image) {
        const blob = await imageBlob(bg.image.id);
        if (!blob) throw new Error("gone");
        return createImageBitmap(blob);
      }
      const el = new Image();
      el.src = b?.src?.(light) ?? "";
      await el.decode();
      return el;
    })();
    pictures.set(key, img);
    img.catch(() => pictures.delete(key));
    while (pictures.size > KEEP) {
      const [oldest, p] = pictures.entries().next().value as [string, Promise<Img>];
      pictures.delete(oldest);
      void p.then((s) => "close" in s && s.close(), () => undefined);
    }
  }
  return img.then((i) => ({ kind: "image", img: i }));
}

// themeColours reads the page's background, text and muted text, through
// a canvas so any colour syntax a theme uses comes back as RGB.
export function themeColours(el: HTMLElement, dark: boolean): ThemeColours {
  const probe = document.createElement("span");
  el.appendChild(probe);
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const read = (v: string): RGB => {
    probe.style.color = `var(${v})`;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = getComputedStyle(probe).color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const out = { bg: read("--background"), fg: read("--foreground"), muted: read("--muted-foreground"), dark };
  probe.remove();
  return out;
}
