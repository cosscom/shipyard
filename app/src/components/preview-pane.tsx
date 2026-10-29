import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar";
import {
  AppWindowIcon,
  CameraIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GalleryHorizontalIcon,
  GlobeIcon,
  LayoutGridIcon,
  Link2Icon,
  Link2OffIcon,
  MoonIcon,
  RotateCwIcon,
  RotateCwSquareIcon,
  RulerIcon,
  ScanIcon,
  SendIcon,
  SlidersHorizontalIcon,
  SunIcon,
  SunMoonIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Suggestions, useBrowserContext } from "@/components/browser-pane";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { openBrowserAt } from "@/lib/actions";
import { uploadAttachment, withAttachments } from "@/lib/attachments";
import { resolveBrowserInput } from "@/lib/browser-url";
import { agentOf } from "@/lib/derive";
import { openUrl } from "@/lib/open-url";
import { send as sendPrompt } from "@/lib/orchestrate";
import {
  clampWidth,
  customId,
  flagged,
  type Frame,
  frameName,
  framesOf,
  GAP,
  HEIGHTS,
  LABEL,
  type Layout,
  MAX_FRAMES,
  PAD,
  parseMessage,
  percent,
  PRESETS,
  proxied,
  relay,
  scales,
  sheetLayout,
  sortSizes,
  type Strategy,
  strategyLabel,
  type Theme,
  unflagged,
} from "@/lib/preview-frames";
import { setPreviewSettings, usePreviewSettings } from "@/lib/preview-store";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { demoDevServer } from "@/demo/dev-server";
import { rememberUrl } from "@/lib/workspaces";

interface Props {
  url: string;
  visible: boolean;
  // The worktree (workspace key) the pane belongs to: its settings are
  // remembered for it, and a typed port opens on its box.
  worktree: string;
  onNavigate(url: string): void;
}

// At most this many frames load at once; the rest wait their turn.
const MAX_LOADING = 3;
// A hidden Preview tab lets its frames go after this long, and loads them
// again where they were when it shows.
const PAUSE_AFTER = 20_000;
// A frame that loaded and hasn't said hello by then has no preview script.
const HELLO_WAIT = 2500;
// How long after the app sends a frame somewhere what it loads is the
// app's doing (Live.expect).
const EXPECT = 4000;

type Status = "waiting" | "loading" | "live" | "plain";

interface Live {
  el: HTMLIFrameElement;
  origin: string;
  // Until then, the next page the frame loads or address it changes to is
  // the app's doing (its first load, or one it was sent), not the person's,
  // and is not passed on: frames that redirect differently can't bounce
  // each other around.
  expect: number;
  url?: string;
  title?: string;
  detected?: string;
}

// PreviewPane shows a worktree's page at several sizes at once: Tailwind's
// breakpoints, phones and a tablet, each an iframe at its real CSS width,
// scaled to fit, in a filmstrip, a grid, or all fitted in the pane. Synced,
// navigating, scrolling (and, mirrored, clicking and typing) in one frame
// does it in all; isolated, each is its own. Light and dark are forced per
// frame or for all. The frames talk to the app through a script the laptop's
// proxy gives Preview frames only (internal/proxy/preview.js).
export function PreviewPane({ url, visible, worktree, onNavigate }: Props) {
  const ctx = useBrowserContext(worktree);
  const s = usePreviewSettings(worktree);
  const set = useCallback((c: Parameters<typeof setPreviewSettings>[1]) => setPreviewSettings(worktree, c), [worktree]);
  const frames = useMemo(() => framesOf(s), [s]);

  // What the frames load: the pane's address, and again (a new generation)
  // whenever it is typed or the frames are reloaded. A frame's own
  // navigations don't change it, so they don't reload the others.
  const [load, setLoad] = useState({ url, n: 0 });
  // The address the frames last reported, so the pane's own update of its
  // address (to remember it) isn't taken for a new one to load.
  const reported = useRef(url);
  useEffect(() => {
    if (url !== reported.current) {
      reported.current = url;
      setLoad((l) => ({ url, n: l.n + 1 }));
    }
  }, [url]);

  const go = (next: string) => {
    rememberUrl(next);
    reported.current = next;
    setLoad((l) => ({ url: next, n: l.n + 1 }));
    onNavigate(next);
  };

  // Hidden for a while, the frames go; shown again, they come back where
  // they were.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (visible) {
      setPaused(false);
      return;
    }
    const t = window.setTimeout(() => setPaused(true), PAUSE_AFTER);
    return () => window.clearTimeout(t);
  }, [visible]);

  if (!url) {
    return (
      <div data-testid="preview-pane" className="flex min-h-0 flex-1 flex-col bg-pane">
        <AddressBar url="" onGo={(raw) => {
          const next = resolveBrowserInput(raw, ctx);
          if (next) go(next);
        }} />
        <Suggestions ctx={ctx} onPick={go} />
      </div>
    );
  }
  if (!proxied(url) && !__BERTH_DEMO__) {
    return (
      <div data-testid="preview-pane" className="flex min-h-0 flex-1 flex-col bg-pane">
        <AddressBar url={url} onGo={(raw) => {
          const next = resolveBrowserInput(raw, ctx);
          if (next) go(next);
        }} />
        <CantFrame url={url} worktree={worktree} />
      </div>
    );
  }
  return (
    <Frames
      key={`${load.n}`}
      worktree={worktree}
      base={load.url}
      address={url}
      frames={frames}
      paused={paused}
      onGo={(raw) => {
        const next = resolveBrowserInput(raw, ctx);
        if (next) go(next);
      }}
      onReload={() => setLoad((l) => ({ url: reported.current || l.url, n: l.n + 1 }))}
      onNavigate={(u) => {
        reported.current = u;
        onNavigate(u);
      }}
      set={set}
    />
  );
}

interface FramesProps {
  worktree: string;
  // What every frame first loads.
  base: string;
  // The pane's address, as the frames last reported it.
  address: string;
  frames: Frame[];
  paused: boolean;
  onGo(raw: string): void;
  onReload(): void;
  onNavigate(url: string): void;
  set(c: Parameters<typeof setPreviewSettings>[1]): void;
}

function Frames({ worktree, base, address, frames, paused, onGo, onReload, onNavigate, set }: FramesProps) {
  const s = usePreviewSettings(worktree);
  const area = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setAvail({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const sc = useMemo(() => scales(frames, s.layout, avail), [frames, s.layout, avail]);

  // The frames that are there, by id, and what each has said.
  const live = useRef(new Map<string, Live>());
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [detected, setDetected] = useState<string>();
  // Where each frame is, for reloading it there, and for its tab.
  const [urls, setUrls] = useState<Record<string, string>>({});
  // A frame loads once it is near the view, a few at a time.
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  // Each frame's address when it was put on the page: frames come back
  // where they were after a pause or a rotation.
  const srcs = useRef<Record<string, string>>({});

  const post = useCallback((id: string, msg: Record<string, unknown>) => {
    const f = live.current.get(id);
    try {
      f?.el.contentWindow?.postMessage({ berth: "preview", ...msg }, f.origin);
    } catch {
      // gone
    }
  }, []);
  const settings = useRef(s);
  settings.current = s;
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const shots = useRef(new Map<string, (m: Shot) => void>());

  // Messages from the frames: only from a frame of this tab, from the
  // origin it was given.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      let id: string | undefined;
      for (const [k, f] of live.current) if (f.el.contentWindow === e.source && f.origin === e.origin) id = k;
      if (!id) return;
      const m = parseMessage(e.data);
      if (!m || m.id !== id) return;
      const f = live.current.get(id)!;
      switch (m.type) {
        case "hello": {
          f.url = unflagged(m.url);
          f.title = m.title;
          f.detected = m.detected;
          setStatus((st) => ({ ...st, [id]: "live" }));
          setUrls((u) => ({ ...u, [id]: f.url! }));
          setDetected((d) => d ?? m.detected);
          const fr = framesRef.current.find((x) => x.id === id);
          if (fr) post(id, { type: "config", theme: fr.theme, strategy: settings.current.strategy });
          // A synced frame that came back on another page (a full reload
          // after a navigation) is a navigation too.
          if (settings.current.sync && !expected(f)) navigated(id, f.url, true);
          break;
        }
        case "nav":
          f.url = unflagged(m.url);
          f.title = m.title;
          setUrls((u) => ({ ...u, [id]: f.url! }));
          if (settings.current.sync && !expected(f)) navigated(id, f.url);
          break;
        case "detected":
          f.detected = m.detected;
          setDetected(m.detected);
          break;
        case "shot":
          shots.current.get(`${id}:${m.req}`)?.(m);
          break;
        default: {
          const out = relay(m, settings.current);
          if (out) for (const k of live.current.keys()) if (k !== id) post(k, out);
        }
      }
    };
    // One frame moved: the pane's address follows, and so do the others
    // that are somewhere else.
    // full: it loaded a new page (a link followed, a form sent), which the
    // others load too; else a router changed its address, and theirs do.
    const navigated = (from: string, to: string, full = false) => {
      onNavRef.current(to);
      for (const [k, f] of live.current) {
        if (k === from || !f.url || (f.url === to && !full)) continue;
        f.expect = Date.now() + EXPECT;
        post(k, { type: "navigate", url: to, full });
      }
    };
    // The first page or address after the app sent the frame somewhere is
    // that; what follows is the person's again.
    const expected = (f: Live) => {
      const was = Date.now() < f.expect;
      f.expect = 0;
      return was;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post]);
  const onNavRef = useRef(onNavigate);
  onNavRef.current = (u: string) => {
    if (u !== address) onNavigate(u);
  };

  // Light and dark: tell each frame when its theme changes.
  const themeKey = frames.map((f) => `${f.id}=${f.theme}`).join(",") + `|${s.strategy}`;
  useEffect(() => {
    for (const f of frames) if (live.current.has(f.id)) post(f.id, { type: "config", theme: f.theme, strategy: s.strategy });
    // themeKey is what changes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey, post]);

  // Which frames may have an iframe now: those seen, in order, while at
  // most MAX_LOADING are loading.
  let loading = 0;
  const allowed = new Set<string>();
  for (const f of frames) {
    if (paused || !seen[f.id]) continue;
    const st = status[f.id] ?? "waiting";
    if (st === "waiting" || st === "loading") {
      if (loading >= MAX_LOADING) continue;
      loading++;
    }
    allowed.add(f.id);
  }

  const register = useCallback((id: string, el: HTMLIFrameElement | null, origin: string) => {
    if (el) live.current.set(id, { el, origin, expect: Date.now() + EXPECT });
    else live.current.delete(id);
  }, []);

  // A paused frame forgets it loaded: it loads again in its turn, where it
  // was.
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!paused) return;
    for (const [id, f] of live.current) if (f.url) srcs.current[id] = f.url;
    setStatus({});
    setGen((g) => g + 1);
  }, [paused]);

  const reloadOne = (id: string) => {
    const f = live.current.get(id);
    if (f?.url) srcs.current[id] = f.url;
    setStatus((st) => ({ ...st, [id]: "waiting" }));
    setNonce((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }));
  };
  const [nonce, setNonce] = useState<Record<string, number>>({});

  const [shot, setShot] = useState<{ blob: Blob; url: string } | "taking">();
  const takeShot = async () => {
    setShot("taking");
    try {
      const blob = await screenshot(frames, live.current, post, shots.current);
      setShot({ blob, url: URL.createObjectURL(blob) });
    } catch (err) {
      setShot(undefined);
      toastManager.add({ type: "error", title: "Couldn't take the screenshot", description: String(err) });
    }
  };

  const liveCount = Object.values(status).filter((x) => x === "live").length;
  const plain = Object.values(status).some((x) => x === "plain");
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();

  return (
    <div data-testid="preview-pane" data-layout={s.layout} data-sync={s.sync ? "synced" : "isolated"} className="flex min-h-0 flex-1 flex-col bg-pane">
      <PreviewBar
        worktree={worktree}
        address={address}
        frames={frames}
        detected={detected}
        shooting={shot === "taking"}
        canShoot={liveCount > 0}
        onGo={onGo}
        onReload={onReload}
        onShot={() => void takeShot()}
        set={set}
      />
      {plain && !__BERTH_DEMO__ && (
        <p role="status" className="shrink-0 border-b bg-warning/8 px-3 py-1 text-warning-foreground text-meta">
          Some frames aren't connected, so they don't sync or switch themes. Pages from Shipyard's proxy (*.localhost:1377) connect once the Shipyard agent is up to date: restart it from the status bar.
        </p>
      )}
      <div
        ref={area}
        data-testid="preview-frames"
        className={cn(
          "relative flex min-h-0 flex-1 items-start bg-muted/40 vibrancy:bg-transparent",
          s.layout === "row" && "flex-nowrap overflow-x-auto overflow-y-hidden",
          s.layout === "grid" && "flex-wrap content-start overflow-auto",
          s.layout === "fit" && "flex-wrap content-center justify-center overflow-hidden",
        )}
        style={{ gap: GAP, padding: PAD }}
      >
        {avail.w > 0 &&
          frames.map((f, i) => (
            <FrameTile
              key={`${f.id}:${f.w}x${f.h}:${nonce[f.id] ?? 0}:${gen}`}
              frame={f}
              scale={sc[i] ?? 1}
              src={srcs.current[f.id] ?? base}
              host={host}
              strategy={s.strategy}
              root={area}
              allowed={allowed.has(f.id)}
              status={status[f.id] ?? "waiting"}
              synced={s.sync}
              url={urls[f.id]}
              onSeen={() => setSeen((x) => (x[f.id] ? x : { ...x, [f.id]: true }))}
              onStatus={(st) => setStatus((x) => (x[f.id] === "live" && st === "plain" ? x : { ...x, [f.id]: st }))}
              register={register}
              onTheme={(t) => set((cur) => ({ themes: { ...cur.themes, [f.id]: t } }))}
              onRotate={() => {
                const cur = live.current.get(f.id);
                if (cur?.url) srcs.current[f.id] = cur.url;
                set((c) => ({ rotated: c.rotated.includes(f.id) ? c.rotated.filter((x) => x !== f.id) : [...c.rotated, f.id] }));
              }}
              onReload={() => reloadOne(f.id)}
              onOpen={() => openBrowserAt(live.current.get(f.id)?.url ?? urls[f.id] ?? base, { kind: "tab" }, worktree)}
            />
          ))}
      </div>
      <ShotDialog shot={typeof shot === "object" ? shot : undefined} worktree={worktree} onClose={() => {
        if (typeof shot === "object") URL.revokeObjectURL(shot.url);
        setShot(undefined);
      }} />
    </div>
  );
}

// ---- The bar -----------------------------------------------------------------

const btn = "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-meta outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 [&_svg]:size-3.5";
const quiet = "text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent";
const seg = "flex items-center gap-0.5 rounded-lg bg-muted/70 p-0.5";
const segOn = "bg-background text-foreground shadow-xs/5";

const LAYOUTS: { id: Layout; label: string; help: string; Icon: typeof ScanIcon }[] = [
  { id: "fit", label: "Fit all", help: "Every frame at one scale, all in view", Icon: ScanIcon },
  { id: "row", label: "Filmstrip", help: "One row, each frame as tall as the pane; scroll sideways", Icon: GalleryHorizontalIcon },
  { id: "grid", label: "Grid", help: "One scale for all, the widest filling the pane; scroll down", Icon: LayoutGridIcon },
];

const THEME_ICON = { auto: SunMoonIcon, light: SunIcon, dark: MoonIcon } as const;
const THEME_LABEL = { auto: "Auto", light: "Light", dark: "Dark" } as const;

function PreviewBar({
  worktree,
  address,
  frames,
  detected,
  shooting,
  canShoot,
  onGo,
  onReload,
  onShot,
  set,
}: {
  worktree: string;
  address: string;
  frames: Frame[];
  detected?: string;
  shooting: boolean;
  canShoot: boolean;
  onGo(raw: string): void;
  onReload(): void;
  onShot(): void;
  set(c: Parameters<typeof setPreviewSettings>[1]): void;
}) {
  const s = usePreviewSettings(worktree);
  const allTheme: Theme = frames.length && frames.every((f) => f.theme === frames[0].theme) ? frames[0].theme : s.theme;
  const mixed = frames.some((f) => f.theme !== s.theme);
  return (
    <ToolbarPrimitive.Root aria-label="Preview" className="@container/bar flex h-bar-pane shrink-0 items-center gap-1.5 border-b px-edge">
      <Tip label="Reload all frames" side="bottom">
        <ToolbarPrimitive.Button aria-label="Reload all frames" onClick={onReload} className={cn(btn, quiet, "w-6.5 justify-center px-0")}>
          <RotateCwIcon />
        </ToolbarPrimitive.Button>
      </Tip>
      <Address url={address} onGo={onGo} />
      <Tip label={s.sync ? "Synced: navigating and scrolling one frame moves them all" : "Isolated: each frame on its own"} side="bottom">
        <ToolbarPrimitive.Button
          aria-pressed={s.sync}
          aria-label="Sync frames"
          onClick={() => set({ sync: !s.sync })}
          className={cn(btn, s.sync ? "bg-accent text-foreground" : quiet)}
        >
          {s.sync ? <Link2Icon /> : <Link2OffIcon />}
          <span className="@max-[44rem]/bar:hidden">{s.sync ? "Synced" : "Isolated"}</span>
        </ToolbarPrimitive.Button>
      </Tip>
      <ToolbarPrimitive.Group aria-label="Theme for all frames" className={seg}>
        {(["auto", "light", "dark"] as const).map((t) => {
          const Icon = THEME_ICON[t];
          const on = allTheme === t && !mixed;
          return (
            <Tip key={t} label={t === "auto" ? "Each page as it is (your system's appearance)" : `Force ${t} in every frame`} side="bottom">
              <ToolbarPrimitive.Button aria-pressed={on} aria-label={`${THEME_LABEL[t]} theme for all frames`} onClick={() => set({ theme: t, themes: {} })} className={cn(btn, "h-5.5 px-1.5", on ? segOn : "text-muted-foreground hover:text-foreground")}>
                <Icon />
                <span className="@max-[56rem]/bar:hidden">{THEME_LABEL[t]}</span>
              </ToolbarPrimitive.Button>
            </Tip>
          );
        })}
      </ToolbarPrimitive.Group>
      <ToolbarPrimitive.Group aria-label="Layout" className={seg}>
        {LAYOUTS.map(({ id, label, help, Icon }) => (
          <Tip key={id} label={help} side="bottom">
            <ToolbarPrimitive.Button aria-pressed={s.layout === id} aria-label={label} onClick={() => set({ layout: id })} className={cn(btn, "h-5.5 w-6 justify-center px-0", s.layout === id ? segOn : "text-muted-foreground hover:text-foreground")}>
              <Icon />
            </ToolbarPrimitive.Button>
          </Tip>
        ))}
      </ToolbarPrimitive.Group>
      <SizesMenu worktree={worktree} />
      <OptionsMenu worktree={worktree} detected={detected} />
      <Tip label={canShoot ? "Screenshot of all frames" : "No frame is connected to take a picture of"} side="bottom">
        <ToolbarPrimitive.Button aria-label="Screenshot of all frames" disabled={!canShoot || shooting} onClick={onShot} className={cn(btn, quiet, "w-6.5 justify-center px-0")}>
          {shooting ? <Spinner className="size-3.5" /> : <CameraIcon />}
        </ToolbarPrimitive.Button>
      </Tip>
    </ToolbarPrimitive.Root>
  );
}

function Address({ url, onGo }: { url: string; onGo(raw: string): void }) {
  const [input, setInput] = useState(url);
  useEffect(() => setInput(url), [url]);
  return (
    <form
      className="flex h-6.5 min-w-24 flex-1 items-center rounded-md border bg-muted/50 focus-within:border-ring"
      onSubmit={(e) => {
        e.preventDefault();
        onGo(input);
      }}
    >
      <input
        aria-label="Address"
        value={input}
        placeholder="Port (3000), or a URL"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setInput(e.target.value)}
        onFocus={(e) => e.target.select()}
        className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-mono outline-none"
      />
    </form>
  );
}

function AddressBar({ url, onGo }: { url: string; onGo(raw: string): void }) {
  return (
    <div className="flex h-bar-pane shrink-0 items-center gap-1 border-b px-edge">
      <Address url={url} onGo={onGo} />
    </div>
  );
}

function SizesMenu({ worktree }: { worktree: string }) {
  const s = usePreviewSettings(worktree);
  const [width, setWidth] = useState("");
  const toggle = (id: string, on: boolean) =>
    setPreviewSettings(worktree, (c) => {
      if (!on) return { sizes: c.sizes.length > 1 ? c.sizes.filter((x) => x !== id) : c.sizes };
      if (c.sizes.length >= MAX_FRAMES) {
        toastManager.add({ type: "info", title: `At most ${MAX_FRAMES} frames`, description: "Each frame is a whole page. Hide one to show another." });
        return {};
      }
      return { sizes: sortSizes([...c.sizes, id]) };
    });
  const addWidth = () => {
    const w = clampWidth(Number(width));
    if (w === undefined) {
      toastManager.add({ type: "info", title: "Widths are 240 to 3840 pixels" });
      return;
    }
    setPreviewSettings(worktree, (c) => ({ custom: [...c.custom, w], sizes: c.sizes.length < MAX_FRAMES && !c.sizes.includes(customId(w)) ? sortSizes([...c.sizes, customId(w)]) : c.sizes }));
    setWidth("");
  };
  const devices = PRESETS.filter((p) => p.kind !== "breakpoint");
  const breakpoints = PRESETS.filter((p) => p.kind === "breakpoint");
  return (
    <Menu>
      <Tip label="Sizes to show" side="bottom">
        <MenuTrigger render={<ToolbarPrimitive.Button aria-label="Sizes" className={cn(btn, quiet)} />}>
          <RulerIcon />
          <span className="tabular-nums @max-[36rem]/bar:hidden">{s.sizes.length}</span>
        </MenuTrigger>
      </Tip>
      <MenuPopup align="end" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Tailwind breakpoints</MenuGroupLabel>
          {breakpoints.map((p) => (
            <MenuCheckboxItem key={p.id} checked={s.sizes.includes(p.id)} onCheckedChange={(on) => toggle(p.id, on)} closeOnClick={false}>
              <span className="flex w-full items-baseline gap-2">
                <span className="w-7 font-medium font-mono">{p.label}</span>
                <span className="text-muted-foreground text-meta tabular-nums">{p.w}px</span>
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Devices</MenuGroupLabel>
          {devices.map((p) => (
            <MenuCheckboxItem key={p.id} checked={s.sizes.includes(p.id)} onCheckedChange={(on) => toggle(p.id, on)} closeOnClick={false}>
              <span className="flex w-full items-baseline gap-2">
                <span>{p.label}</span>
                <span className="text-muted-foreground text-meta tabular-nums">
                  {p.w} × {p.h}
                </span>
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        {s.custom.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Custom</MenuGroupLabel>
              {s.custom.map((w) => (
                <MenuCheckboxItem key={w} checked={s.sizes.includes(customId(w))} onCheckedChange={(on) => toggle(customId(w), on)} closeOnClick={false}>
                  <span className="text-meta tabular-nums">{w}px</span>
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
          </>
        )}
        <MenuSeparator />
        <form
          className="flex items-center gap-1.5 px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addWidth();
          }}
        >
          <input
            aria-label="Custom width"
            inputMode="numeric"
            value={width}
            onChange={(e) => setWidth(e.target.value.replace(/\D/g, ""))}
            // The menu's typeahead would take the keys.
            onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
            placeholder="Width, e.g. 1440"
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-meta tabular-nums outline-none focus:border-ring"
          />
          <Button type="submit" size="xs" variant="outline" disabled={!width}>
            Add
          </Button>
        </form>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Breakpoint height</MenuGroupLabel>
          <MenuRadioGroup value={String(s.height)} onValueChange={(v) => setPreviewSettings(worktree, { height: Number(v) })}>
            {HEIGHTS.map((h) => (
              <MenuRadioItem key={h} value={String(h)} closeOnClick={false}>
                <span className="text-meta tabular-nums">{h}px</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function OptionsMenu({ worktree, detected }: { worktree: string; detected?: string }) {
  const s = usePreviewSettings(worktree);
  const strategies: { id: Strategy; label: string }[] = [
    { id: "auto", label: `Auto${detected ? ` (${strategyLabel(detected)})` : ""}` },
    { id: "media", label: "prefers-color-scheme" },
    { id: "class", label: ".dark class" },
    { id: "data-theme", label: "data-theme attribute" },
  ];
  return (
    <Menu>
      <Tip label="Sync and theme options" side="bottom">
        <MenuTrigger render={<ToolbarPrimitive.Button aria-label="Preview options" className={cn(btn, quiet, "w-6.5 justify-center px-0")} />}>
          <SlidersHorizontalIcon />
        </MenuTrigger>
      </Tip>
      <MenuPopup align="end" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Synced scrolling</MenuGroupLabel>
          <MenuRadioGroup value={s.scroll} onValueChange={(v) => setPreviewSettings(worktree, { scroll: v as "proportional" | "anchor" })}>
            <MenuRadioItem value="proportional" closeOnClick={false}>
              Proportional
            </MenuRadioItem>
            <MenuRadioItem value="anchor" closeOnClick={false}>
              By element at the top
            </MenuRadioItem>
          </MenuRadioGroup>
          <MenuCheckboxItem variant="switch" checked={s.mirror} onCheckedChange={(on) => setPreviewSettings(worktree, { mirror: on })} closeOnClick={false}>
            Mirror clicks and typing
          </MenuCheckboxItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Force light and dark with</MenuGroupLabel>
          <MenuRadioGroup value={s.strategy} onValueChange={(v) => setPreviewSettings(worktree, { strategy: v as Strategy })}>
            {strategies.map((x) => (
              <MenuRadioItem key={x.id} value={x.id} closeOnClick={false}>
                {x.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

// ---- A frame -----------------------------------------------------------------

interface TileProps {
  frame: Frame;
  scale: number;
  src: string;
  host: string;
  strategy: Strategy;
  root: React.RefObject<HTMLDivElement | null>;
  allowed: boolean;
  status: Status;
  synced: boolean;
  url?: string;
  onSeen(): void;
  onStatus(s: Status): void;
  register(id: string, el: HTMLIFrameElement | null, origin: string): void;
  onTheme(t: Theme): void;
  onRotate(): void;
  onReload(): void;
  onOpen(): void;
}

function FrameTile({ frame: f, scale, src, host, strategy, root, allowed, status, synced, url, onSeen, onStatus, register, onTheme, onRotate, onReload, onOpen }: TileProps) {
  const tile = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSeen, onStatus });
  callbacks.current = { onSeen, onStatus };
  // Loads once near the view.
  useEffect(() => {
    const el = tile.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && callbacks.current.onSeen(), { root: root.current, rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  // The frame's name and first address are fixed when it is put on the
  // page; later changes go to it as messages.
  const [first] = useState(() => ({ name: frameName(f.id, f.theme, strategy), src: flagged(src) }));
  const origin = useMemo(() => {
    try {
      return new URL(first.src).origin;
    } catch {
      return "";
    }
  }, [first.src]);
  const ref = useCallback((el: HTMLIFrameElement | null) => register(f.id, el, origin), [register, f.id, origin]);
  useEffect(() => {
    if (allowed && status === "waiting") callbacks.current.onStatus("loading");
  }, [allowed, status]);
  // Loaded, but no hello: a page without the preview script.
  const [loadedAt, setLoadedAt] = useState(0);
  useEffect(() => {
    if (!loadedAt || status === "live") return;
    const t = window.setTimeout(() => callbacks.current.onStatus("plain"), HELLO_WAIT);
    return () => window.clearTimeout(t);
  }, [loadedAt, status]);
  // A frame that never loads gives its turn to the next.
  useEffect(() => {
    if (status !== "loading") return;
    const t = window.setTimeout(() => callbacks.current.onStatus("plain"), 20_000);
    return () => window.clearTimeout(t);
  }, [status]);

  const w = Math.round(f.w * scale);
  const h = Math.round(f.h * scale);
  const device = f.kind === "phone" || f.kind === "tablet";
  const ThemeIcon = THEME_ICON[f.theme];
  const next: Theme = f.theme === "dark" ? "light" : "dark";
  const shownUrl = url && url !== src ? url.replace(/^https?:\/\/[^/]+/, "") : "";
  return (
    <div ref={tile} data-testid="preview-frame" data-frame={f.id} data-status={status} data-theme={f.theme} className="flex shrink-0 flex-col" style={{ width: w }}>
      <div className="group/label relative flex items-center gap-1.5 overflow-hidden text-meta" style={{ height: LABEL - 6, marginBottom: 6 }}>
        <Tip label={statusHelp(status, synced)} side="bottom" align="start">
          <span role="img" aria-label={statusHelp(status, synced)} className={cn("size-1.5 shrink-0 rounded-full", status === "live" ? (synced ? "bg-success" : "bg-muted-foreground/60") : status === "plain" ? "bg-warning" : "bg-muted-foreground/30")} />
        </Tip>
        <Tip label={`${f.detail} · shown at ${percent(scale)}`} side="bottom" align="start">
          <span className={cn("shrink-0 font-medium", f.kind === "breakpoint" && "font-mono")}>{f.label}</span>
        </Tip>
        <span className="min-w-0 truncate text-muted-foreground tabular-nums">
          {f.w} × {f.h}
          {/* A narrow frame keeps its size; its scale is in the tooltip. */}
          {w >= 200 && <span className="text-muted-foreground"> · {percent(scale)}</span>}
          {shownUrl && <span className="font-mono text-muted-foreground"> · {shownUrl}</span>}
        </span>
        {f.theme !== "auto" && (
          <span aria-hidden className="ml-auto flex shrink-0 items-center text-muted-foreground group-focus-within/label:invisible group-hover/label:invisible [&_svg]:size-3">
            <ThemeIcon />
          </span>
        )}
        {/* Its actions over the end of the label, on hover or focus, so a
            narrow frame keeps its name and size. */}
        <span className="absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-[color-mix(in_oklab,var(--muted)_40%,var(--background))] from-70% to-transparent pl-4 opacity-0 transition-opacity focus-within:opacity-100 group-hover/label:opacity-100">
          <Tip label={f.theme === "auto" ? `Force ${next} here` : `${THEME_LABEL[f.theme]} here; switch to ${next}`} side="bottom">
            <button type="button" aria-label={`Theme of ${f.label}: ${THEME_LABEL[f.theme]}`} onClick={() => onTheme(next)} className={cn(tileBtn, f.theme !== "auto" && "text-foreground")}>
              <ThemeIcon />
            </button>
          </Tip>
          {device && (
            <Tip label={f.rotated ? "Turn upright" : "Turn sideways"} side="bottom">
              <button type="button" aria-label={`Rotate ${f.label}`} onClick={onRotate} className={tileBtn}>
                <RotateCwSquareIcon />
              </button>
            </Tip>
          )}
          <Tip label="Reload this frame" side="bottom">
            <button type="button" aria-label={`Reload ${f.label}`} onClick={onReload} className={tileBtn}>
              <RotateCwIcon />
            </button>
          </Tip>
          <Tip label="Open in a Browser tab" side="bottom">
            <button type="button" aria-label={`Open ${f.label} in a Browser tab`} onClick={onOpen} className={tileBtn}>
              <AppWindowIcon />
            </button>
          </Tip>
        </span>
      </div>
      <div className={cn("relative overflow-hidden border bg-white shadow-xs/5", device ? "rounded-xl" : "rounded-md")} style={{ width: w, height: h }}>
        {allowed ? (
          <iframe
            ref={ref}
            name={first.name}
            title={`${f.label}, ${f.w} by ${f.h}, ${host}`}
            src={__BERTH_DEMO__ ? undefined : first.src}
            srcDoc={__BERTH_DEMO__ ? demoDevServer(src) : undefined}
            onLoad={() => setLoadedAt(Date.now())}
            className="absolute top-0 left-0 origin-top-left border-0 bg-white"
            style={{ width: f.w, height: f.h, transform: `scale(${scale})` }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-muted/60 text-muted-foreground">
            <Spinner className="size-4 opacity-60" />
          </div>
        )}
        {allowed && status === "loading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/30">
            <Spinner className="size-4 opacity-60" />
          </div>
        )}
      </div>
    </div>
  );
}

const tileBtn = "inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5";

function statusHelp(status: Status, synced: boolean): string {
  switch (status) {
    case "live":
      return synced ? "Connected and synced" : "Connected, on its own";
    case "plain":
      return "Not connected: this page has no Shipyard preview script, so it doesn't sync or switch themes";
    case "loading":
      return "Loading";
    default:
      return "Waiting its turn to load";
  }
}

// ---- Pages that can't be framed ------------------------------------------------

function CantFrame({ url, worktree }: { url: string; worktree: string }) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <GlobeIcon className="size-6 text-muted-foreground" />
        <p className="text-row">{host} can't be framed</p>
        <p className="text-muted-foreground text-meta">Preview shows pages through Shipyard's proxy, a worktree's dev server or a box port. Most other sites refuse to be shown inside another page.</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => openBrowserAt(url, { kind: "tab" }, worktree)}>
            <AppWindowIcon />
            Open in Browser tab
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void openUrl(url)}>
            <ExternalLinkIcon />
            Open in your browser
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Screenshot ----------------------------------------------------------------

// screenshot asks each connected frame to draw itself (the preview script
// renders its page into a picture) and lays them out in one PNG, labelled.
type Shot = { data?: string; svg?: string; error?: string };

async function screenshot(frames: Frame[], live: Map<string, Live>, post: (id: string, m: Record<string, unknown>) => void, waiting: Map<string, (m: Shot) => void>): Promise<Blob> {
  const req = Math.random().toString(36).slice(2);
  const pictures = await Promise.all(
    frames.map(
      (f) =>
        new Promise<HTMLImageElement | undefined>((resolve) => {
          if (!live.has(f.id)) return resolve(undefined);
          const key = `${f.id}:${req}`;
          const t = window.setTimeout(() => done({}), 15_000);
          function done(m: Shot) {
            window.clearTimeout(t);
            waiting.delete(key);
            const src = m.data ?? (m.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(m.svg)}` : undefined);
            if (!src) return resolve(undefined);
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(undefined);
            img.src = src;
          }
          waiting.set(key, done);
          post(f.id, { type: "shot", req });
        }),
    ),
  );
  if (!pictures.some(Boolean)) throw new Error("No frame could be drawn.");
  const totalW = frames.reduce((n, f) => n + f.w, 0);
  const scale = Math.min(1, Math.max(0.35, 3200 / totalW));
  const label = 36;
  const { tiles, width, height } = sheetLayout(frames, { scale, gap: 32, label, pad: 32, maxWidth: 4000 });
  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const c = canvas.getContext("2d")!;
  c.scale(dpr, dpr);
  c.fillStyle = "#f4f4f5";
  c.fillRect(0, 0, width, height);
  frames.forEach((f, i) => {
    const t = tiles[i];
    c.fillStyle = "#18181b";
    c.font = "600 15px system-ui, -apple-system, sans-serif";
    c.textBaseline = "alphabetic";
    c.fillText(f.label, t.x, t.y - 12);
    const lw = c.measureText(f.label).width;
    c.fillStyle = "#71717a";
    c.font = "400 13px system-ui, -apple-system, sans-serif";
    c.fillText(`${f.w} × ${f.h}${f.theme !== "auto" ? ` · ${f.theme}` : ""}`, t.x + lw + 8, t.y - 12);
    c.save();
    c.beginPath();
    c.roundRect(t.x, t.y, t.w, t.h, 8);
    c.clip();
    c.fillStyle = "#ffffff";
    c.fillRect(t.x, t.y, t.w, t.h);
    const img = pictures[i];
    if (img) c.drawImage(img, t.x, t.y, t.w, t.h);
    else {
      c.fillStyle = "#e4e4e7";
      c.fillRect(t.x, t.y, t.w, t.h);
      c.fillStyle = "#71717a";
      c.font = "400 13px system-ui, -apple-system, sans-serif";
      c.fillText("Couldn't draw this frame", t.x + 12, t.y + 24);
    }
    c.restore();
    c.strokeStyle = "#d4d4d8";
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1, 8);
    c.stroke();
  });
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be made."))), "image/png");
    } catch (err) {
      reject(err);
    }
  });
}

function ShotDialog({ shot, worktree, onClose }: { shot?: { blob: Blob; url: string }; worktree: string; onClose(): void }) {
  const ctx = useBrowserContext(worktree);
  const ref = ctx.ref;
  const session = useStore((st) => (ref ? st.boxes[ref.box]?.sessions?.find((x) => x.dir === ref.path && !x.exited && agentOf(x)) : undefined));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const name = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `preview-${ref?.worktree ?? "page"}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
  })();
  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": shot!.blob })]);
      toastManager.add({ type: "success", title: "Copied the screenshot" });
    } catch (err) {
      toastManager.add({ type: "error", title: "Couldn't copy", description: String(err) });
    }
  };
  const save = () => {
    const a = document.createElement("a");
    a.href = shot!.url;
    a.download = name;
    a.click();
  };
  const toAgent = async () => {
    const client = useStore.getState().client;
    if (!client || !ref || !session) return;
    setBusy(true);
    try {
      const file = new File([shot!.blob], name, { type: "image/png" });
      const at = await uploadAttachment(client, { box: ref.box, session: session.name }, file);
      await sendPrompt(ref.box, session.name, withAttachments(note || "Here is the page at each size (Shipyard Preview).", [at.path]), { when: "idle" });
      toastManager.add({ type: "success", title: "Sent to the agent" });
      onClose();
    } catch (err) {
      toastManager.add({ type: "error", title: "Couldn't send it", description: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!shot} onOpenChange={(o) => !o && onClose()}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Screenshot of all frames</DialogTitle>
          <DialogDescription>Each frame as it is now, side by side.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {shot && <img alt="All frames" src={shot.url} className="max-h-[55vh] w-full rounded-md border bg-muted object-contain" />}
          {session && (
            <input
              aria-label="Note for the agent"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="A note for the agent (optional)"
              className="mt-3 h-8 w-full rounded-md border bg-background px-2 text-body outline-none focus:border-ring"
            />
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
          <Button variant="outline" onClick={() => void copy()}>
            <ClipboardCopyIcon />
            Copy
          </Button>
          <Button variant="outline" onClick={save}>
            <DownloadIcon />
            Save
          </Button>
          {session && (
            <Button disabled={busy} onClick={() => void toAgent()}>
              <SendIcon />
              Send to agent
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
