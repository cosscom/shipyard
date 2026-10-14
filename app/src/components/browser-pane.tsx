import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeftIcon, ArrowUpRightIcon, ArrowRightIcon, BotIcon, CrosshairIcon, ExternalLinkIcon, GlobeIcon, MonitorSmartphoneIcon, RotateCwIcon, SendIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";

import { DevtoolsDrawer, DevtoolsToggle, InspectButton } from "@/components/browser-devtools";
import { LoginMenu, OtherLogin } from "@/components/browser-login";
import { BrowserSandboxCard, seedSandbox, useSandboxCardState } from "@/components/browser-sandbox";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { isTauri } from "@/lib/api";
import { openPreviewAt } from "@/lib/actions";
import { type AgentBrowserTab, agentBrowserStatus, boxHasBrowser, fitFrame, type Frame, sizeLabel, watchAgentBrowser } from "@/lib/agent-browser";
import { chooseTab, noteTabs, showTabStrip, tabActive, tabLabel, tabMovedNote, type TabSeen } from "@/lib/browser-tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { agentOf } from "@/lib/derive";
import { useEventLog } from "@/lib/events";
import { DEVTOOLS_FRAME, proxiedHost, useAgentDevtoolsFeed, useDevtoolsFeed, useDrawerOpen, withDevtoolsFlag } from "@/lib/devtools";
import { send as sendPrompt } from "@/lib/orchestrate";
import { PICKER_SCRIPT, type Pick, parsePick, pickMessage } from "@/lib/picker";
import { toastManager } from "@/components/ui/toast";
import { berthUrlLabel, boxAliases, type BrowserContext, describeBerthUrl, hostSuffix, resolveBrowserInput, suggestions, worktreeHost } from "@/lib/browser-url";
import { openUrl } from "@/lib/open-url";
import { initialPageLoads, type PageEvent, pageEvent, type PageLoads, reloadLoop, settle } from "@/lib/page-loads";
import { overlayOpen } from "@/lib/overlays";
import { poll, type Poller } from "@/lib/poll";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { demoDevServer } from "@/demo/dev-server";
import { currentSpace, rememberUrl, useWorkspaces, useWorktreeRef } from "@/lib/workspaces";

interface Props {
  // The pane's id. Child webviews are keyed by it, so pass the pane's own id
  // to keep the page when the pane moves within the layout.
  id?: string;
  url: string;
  visible: boolean;
  // Use the in-pane frame for a browser placed inside a transformed canvas.
  preferFrame?: boolean;
  onNavigate(url: string): void;
  // The worktree (workspace key) the pane belongs to, which a typed port
  // opens on; unset, the one showing.
  worktree?: string;
  // Told when a page starts and finishes loading (a Compare tab times both).
  onLoading?(loading: boolean): void;
  // Set when an agent opened its browser here (lib/agent-browser-open): the
  // pane shows the agent's view, again each time it changes. onUnwatch is
  // told when you go back to your own.
  watch?: number;
  onUnwatch?(): void;
}

type Mode = "native" | "iframe";

// BrowserPane shows a web page in a pane, mostly a box's dev server through
// the laptop's proxy (a worktree's own name, like
// http://checkout.shop.devl.localhost:1377/). In the app it is a native child
// webview laid over the pane, so every page works as in a browser; in a plain
// browser, or when that fails, it is an iframe.
export function BrowserPane({ id: paneId, url, visible, preferFrame = false, onNavigate, worktree, onLoading, watch, onUnwatch }: Props) {
  const fallbackId = useId();
  const id = useMemo(() => (paneId ?? fallbackId).replace(/[^A-Za-z0-9_-]/g, ""), [paneId, fallbackId]);
  const [mode, setMode] = useState<Mode>(preferFrame ? "iframe" : isTauri() ? "native" : "iframe");
  const [failure, setFailure] = useState<string>();
  const [input, setInput] = useState(url);
  const [loading, setLoading] = useState(false);
  // A page reloading itself over and over (lib/page-loads.ts), and the one
  // the notice was dismissed for.
  const [loop, setLoop] = useState<{ url: string; count: number }>();
  const [loopDismissed, setLoopDismissed] = useState<string>();
  const ctx = useBrowserContext(worktree);
  // Select the stable list and derive from it: a selector that builds a new
  // array every time never lets the store settle.
  const boxes = useStore((s) => s.status?.boxes);
  // Each box's own name, as one string so the store can settle on it.
  const selves = useStore((s) => Object.entries(s.boxes).map(([name, b]) => `${name}=${b?.info?.name ?? ""}`).join(","));
  const where = useMemo(() => {
    if (!url) return undefined;
    const self = new Map(selves.split(",").map((kv) => kv.split("=") as [string, string]));
    return describeBerthUrl(url, (boxes ?? []).map((b) => b.name), boxAliases((boxes ?? []).map((b) => ({ name: b.name, self: self.get(b.name) }))));
  }, [url, boxes, selves]);

  // The iframe keeps its own history of addresses entered here; the native
  // webview has the page's real history.
  const [history, setHistory] = useState<string[]>(url ? [url] : []);
  const [at, setAt] = useState(url ? 0 : -1);
  const [nonce, setNonce] = useState(0);
  const native = useRef<NativeView>(null);
  const address = useRef<HTMLInputElement>(null);
  const selecting = useRef(false);

  useEffect(() => setInput(url), [url]);

  // A new, empty tab (⌘⇧B) is for typing an address: take the keyboard from
  // the terminal that had it, though never from a dialog or menu. The next
  // frame, after the pane is shown.
  useEffect(() => {
    if (!visible || url || watching) return;
    const frame = requestAnimationFrame(() => {
      if (!overlayOpen()) address.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
    // Only as the empty tab is shown, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const go = (next: string) => {
    rememberUrl(next);
    if (mode === "iframe") {
      setHistory((h) => [...h.slice(0, at + 1), next]);
      setAt((i) => i + 1);
    }
    onNavigate(next);
  };

  const step = (d: -1 | 1) => {
    if (mode === "native") return native.current?.step(d);
    const i = at + d;
    if (i < 0 || i >= history.length) return;
    setAt(i);
    onNavigate(history[i]);
  };

  const reload = () => (mode === "native" ? native.current?.reload() : setNonce((n) => n + 1));

  // The pane is always your own browser, on this laptop, through its proxy.
  // While an agent drives its own browser on the box for this worktree, its
  // view can be watched here instead, live, and it says so.
  const [watching, setWatching] = useState(!!watch);
  const tabsBox = useStore((s) => !!ctx.ref && !!s.boxes[ctx.ref.box]?.info?.capabilities?.includes("browser.tabs"));
  const agentLive = useAgentBrowserLive(ctx.ref, visible, watching && tabsBox);
  useEffect(() => {
    if (watch) setWatching(true);
  }, [watch]);
  useEffect(() => {
    if (!watching && watch) onUnwatch?.();
    // Only as you stop watching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);
  // Opened for the agent, its view shows while the box is still asked
  // whether its browser runs.
  const agentView = watching && (agentLive ? agentLive.running : !!watch && !!ctx.ref && boxHasBrowser(ctx.ref.box));
  // Where the agent's page is, from its frames as they come, and its size
  // and how much of it shows.
  const [agentAt, setAgentAt] = useState<string>();
  const [agentSize, setAgentSize] = useState<AgentSize>();
  useEffect(() => {
    if (agentLive && !agentLive.running) setWatching(false);
  }, [agentLive]);
  // On a box with tabs (lib/browser-tabs), the tab the view watches. It is
  // chosen as the view opens, the one used last then, from a status asked
  // for at that moment, and after that only you change it: agents working in
  // other tabs never move the view, however busy they are. Only when the
  // watched tab goes does it move, to the one used last, and say so. It is
  // the pane's, for its worktree; one you picked is kept for when you come
  // back to the agent's view, one it chose is chosen again.
  const path = ctx.ref?.path;
  const [tab, setTab] = useState<{ path: string; name: string; picked: boolean }>();
  const [tabMoved, setTabMoved] = useState<string>();
  const openedAt = useRef(0);
  useEffect(() => {
    if (!agentView) {
      openedAt.current = 0;
      setTab((t) => (t?.picked ? t : undefined));
      setTabMoved(undefined);
      return;
    }
    if (!openedAt.current) openedAt.current = Date.now();
    if (!tabsBox || !path || !agentLive) return;
    const current = tab?.path === path ? tab.name : undefined;
    // A status from well before the view opened may be half a minute old;
    // the poll asks again as it opens.
    if (current === undefined && agentLive.at < openedAt.current - FRESH_MS) return;
    const next = chooseTab(agentLive.tabs, current) ?? { name: "" };
    if (next.name === current) return;
    setTab({ path, name: next.name, picked: false });
    if (next.movedFrom !== undefined) setTabMoved(tabMovedNote(next.movedFrom, next.name));
  }, [agentView, tabsBox, path, agentLive, tab]);
  useEffect(() => {
    if (!tabMoved) return;
    const t = window.setTimeout(() => setTabMoved(undefined), 8000);
    return () => window.clearTimeout(t);
  }, [tabMoved]);
  // What the view streams: main on a box without tabs; nothing yet while a
  // box with them is asked which.
  const watchedTab = !tabsBox ? "" : tab && tab.path === path ? tab.name : undefined;
  const watchedInfo = watchedTab === undefined ? undefined : agentLive?.tabs?.find((t) => t.name === watchedTab);
  // Its page and size until its frames say them; the browser's own for main
  // on a box that lists no tabs.
  const watchedUrl = watchedInfo ? watchedInfo.url : watchedTab === "" ? agentLive?.url : undefined;
  const watchedSize = watchedInfo ? watchedInfo.size : watchedTab === "" ? agentLive?.size : undefined;
  const pickTab = (name: string) => {
    if (!path) return;
    setTab({ path, name, picked: true });
    setTabMoved(undefined);
  };
  // The agent's browser can't start on the box (Chromium's sandbox): a
  // marked chip, and a card in the agent's view with the ways out.
  const sandbox = useSandboxCardState(ctx.ref?.box ?? "");
  const sandboxBlocked = !agentLive?.running && (sandbox === "blocked" || sandbox === "fixing" || sandbox === "still-blocked");
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const sandboxView = sandboxOpen && sandbox !== "hidden" && !agentView && !!ctx.ref;
  useEffect(() => {
    if (sandbox === "hidden") setSandboxOpen(false);
  }, [sandbox]);
  const [picked, setPicked] = useState<Pick>();
  // "Another email…" from Log in as… (browser-login.tsx).
  const [otherLogin, setOtherLogin] = useState(false);
  // The Console and Network drawer (browser-devtools.tsx): the page's, and
  // the agent's browser's while its view shows.
  const proxyPort = useStore((s) => s.status?.proxy.url_port);
  const proxied = !!url && !!proxiedHost(url, proxyPort);
  useDevtoolsFeed({ key: id, mode, url, visible, proxyPort });
  const drawer = useDrawerOpen(id) && !!url;
  const agentKey = `${id}-agent`;
  const agentDrawer = useDrawerOpen(agentKey);
  const agentDevtools = useAgentDevtoolsFeed(agentKey, ctx.ref, agentView && agentDrawer && watchedTab !== undefined, watchedTab);

  // A pick from the native webview comes back as an event.
  useEffect(() => {
    if (mode !== "native") return;
    let stop: (() => void) | undefined;
    let gone = false;
    void listen<{ id: string; url: string }>("berth://browser-pick", (e) => {
      if (e.payload.id !== id) return;
      const p = parsePick(e.payload.url);
      if (p) setPicked(p);
    }).then((un) => (gone ? un() : (stop = un)));
    return () => {
      gone = true;
      stop?.();
    };
  }, [id, mode]);

  const pick = () => {
    if (mode === "native") {
      void invoke("browser_pick", { id, script: PICKER_SCRIPT }).catch((err) => toastManager.add({ type: "error", title: "Couldn't start the picker", description: String(err) }));
      return;
    }
    // A frame: only a page the frame may script (same origin).
    const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-pane="${id}"]`);
    try {
      const w = frame?.contentWindow as (Window & { eval(js: string): void }) | null;
      if (!w) throw new Error("no page");
      (window as unknown as { __berthPick?: (p: Pick) => void }).__berthPick = (p: Pick) => setPicked(p);
      w.eval(PICKER_SCRIPT);
    } catch {
      toastManager.add({ type: "info", title: "This page can't be picked from here", description: "Picking works in the Shipyard app's own browser panes." });
    }
  };

  return (
    <div data-testid="browser-pane" data-mode={mode} className="flex min-h-0 flex-1 flex-col bg-background">
      {sandboxView ? (
        <SandboxBar box={ctx.ref!.box} fixed={sandbox === "fixed" || sandbox === "no-sandbox"} onBack={() => setSandboxOpen(false)} />
      ) : agentView && ctx.ref ? (
        <AgentBar
          ctx={ctx}
          url={agentAt ?? watchedUrl}
          size={agentSize}
          fallbackSize={watchedSize}
          logKey={agentDevtools ? agentKey : undefined}
          onBack={() => setWatching(false)}
          onOpenHere={(u) => {
            setWatching(false);
            go(u);
          }}
        />
      ) : (
        <form
          // A narrow pane (a Compare tab's side in a small window) keeps the
          // address, dropping the labels around it.
          className="@container/bar flex h-9 shrink-0 items-center gap-1 border-b px-2"
          onSubmit={(e) => {
            e.preventDefault();
            const next = resolveBrowserInput(input, ctx);
            if (next) go(next);
          }}
        >
          <ToolButton label="Back" disabled={!url || (mode === "iframe" && at <= 0)} onClick={() => step(-1)}>
            <ArrowLeftIcon />
          </ToolButton>
          <ToolButton label="Forward" disabled={!url || (mode === "iframe" && at >= history.length - 1)} onClick={() => step(1)}>
            <ArrowRightIcon />
          </ToolButton>
          <ToolButton label="Reload" disabled={!url} onClick={reload}>
            {loading ? <Spinner className="size-3.5" /> : <RotateCwIcon />}
          </ToolButton>
          <div className="flex h-6.5 min-w-0 flex-1 items-center rounded-md border bg-muted/50 focus-within:border-ring">
            {where && (
              // Tooltips here open upward: below the bar is the page, which in
              // the app is a native view that would cover them.
              <Tip label={<span className="break-all font-mono">{url}</span>} className="max-w-md">
                <span className="@max-[26rem]/bar:hidden ml-1 shrink-0 rounded bg-accent px-1.5 py-px font-medium text-[10px] text-muted-foreground">{berthUrlLabel(where)}</span>
              </Tip>
            )}
            <input
              ref={address}
              aria-label="Address"
              value={input}
              placeholder="Port (3000), or a URL"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setInput(e.target.value)}
              onFocus={(e) => {
                e.target.select();
                selecting.current = true;
              }}
              // WebKit's mouseup after a click to focus undoes the select:
              // the first click selects the whole address, as browsers do.
              onMouseUp={(e) => {
                if (selecting.current) e.preventDefault();
                selecting.current = false;
              }}
              className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-xs outline-none"
            />
          </div>
          <LoginMenu ctx={ctx} url={url} onGo={go} onOther={() => setOtherLogin(true)} />
          <ToolButton label="Pick an element for the agent" disabled={!url} onClick={pick}>
            <CrosshairIcon />
          </ToolButton>
          <InspectButton id={id} native={mode === "native"} disabled={!url} />
          <DevtoolsToggle logKey={id} disabled={!url} />
          <ToolButton label="Preview sizes: this page at every size at once" disabled={!url} onClick={() => openPreviewAt(url, { kind: "tab" }, worktree)}>
            <MonitorSmartphoneIcon />
          </ToolButton>
          <ToolButton label="Open in your browser" disabled={!url} onClick={() => void openUrl(url)}>
            <ExternalLinkIcon />
          </ToolButton>
          {sandboxBlocked && ctx.ref && (
            <Tip label={`The agent's browser can't start on ${ctx.ref.box}. See why, and fix it.`}>
              <button
                type="button"
                onClick={() => setSandboxOpen(true)}
                className="ml-1 inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md border border-warning/40 bg-warning/8 px-2 text-[11px] text-warning-foreground hover:bg-warning/16"
              >
                <ShieldAlertIcon className="size-3" />
                Agent's browser blocked
              </button>
            </Tip>
          )}
          {agentLive?.running && (
            <Tip label="An agent is using its own browser on the box for this worktree. Watch it here.">
              <button
                type="button"
                onClick={() => setWatching(true)}
                className="ml-1 inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <LiveDot />
                <span className="@max-[30rem]/bar:sr-only">Agent's view · live</span>
              </button>
            </Tip>
          )}
        </form>
      )}
      {otherLogin && !agentView && !sandboxView && <OtherLogin ctx={ctx} url={url} onGo={go} onDone={() => setOtherLogin(false)} />}
      {picked && ctx.ref && <PickSender pick={picked} ctx={ctx} onDone={() => setPicked(undefined)} />}
      {mode === "native" && loop && loop.url !== loopDismissed && !agentView && !sandboxView && (
        <ReloadLoopNotice loop={loop} onOpen={() => void openUrl(loop.url)} onDismiss={() => setLoopDismissed(loop.url)} />
      )}
      {failure && mode === "iframe" && <p className="shrink-0 border-b bg-muted/40 px-3 py-1 text-muted-foreground text-xs">The built-in browser could not open ({failure}); showing the page in a frame instead.</p>}
      {agentView && ctx.ref && tabsBox && showTabStrip(agentLive?.tabs) && watchedTab !== undefined && <AgentTabs tabs={agentLive!.tabs!} watched={watchedTab} onPick={pickTab} />}
      {agentView && tabMoved && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1 text-muted-foreground text-xs">
          <span className="min-w-0 flex-1 truncate">{tabMoved}</span>
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 hover:bg-accent hover:text-foreground" onClick={() => setTabMoved(undefined)}>
            <XIcon className="size-3" />
          </button>
        </div>
      )}
      {/* Watching the agent keeps your page as it was, hidden underneath. */}
      {agentView && ctx.ref && <AgentView ctx={ctx} visible={visible} tab={watchedTab} onUrl={setAgentAt} onSize={setAgentSize} />}
      {sandboxView && (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-muted/30 p-6 pt-12">
          <BrowserSandboxCard box={ctx.ref!.box} worktree={ctx.ref} className="w-full max-w-2xl bg-background shadow-xs" />
        </div>
      )}
      {!url ? (
        !agentView && !sandboxView && <Suggestions ctx={ctx} onPick={go} />
      ) : mode === "native" ? (
        <NativeSurface
          ref={native}
          id={id}
          url={url}
          visible={visible && !agentView && !sandboxView}
          onUrl={(u) => {
            setInput(u);
            if (u !== url) onNavigate(u);
          }}
          onLoading={(l) => {
            setLoading(l);
            onLoading?.(l);
          }}
          onReloadLoop={setLoop}
          onFail={(why) => {
            setFailure(why);
            setMode("iframe");
          }}
        />
      ) : (
        <div className={cn("flex min-h-0 flex-1 flex-col", (agentView || sandboxView) && "hidden")}>
          <FramedPage key={`${url}#${nonce}`} id={id} url={url} devtools={proxied} onReload={reload} onLoading={onLoading} />
        </div>
      )}
      {drawer && !agentView && !sandboxView && <DevtoolsDrawer logKey={id} pageUrl={url} ctx={ctx} proxied={proxied} />}
      {agentView && agentDrawer && agentDevtools && <DevtoolsDrawer logKey={agentKey} pageUrl={agentAt ?? watchedUrl ?? ""} ctx={ctx} proxied agent />}
    </div>
  );
}

// useBrowserContext gathers what resolving a typed port needs: the pane's
// worktree (else the one showing), its box's services, and the proxy's URL
// port.
export function useBrowserContext(worktree?: string): BrowserContext {
  const own = useWorktreeRef(worktree);
  const ref = own ?? currentSpace()?.ref;
  const services = useStore((s) => (ref ? s.boxes[ref.box]?.services : undefined));
  const urlPort = useStore((s) => s.status?.proxy.url_port);
  return { ref, services, urlPort };
}

interface NativeView {
  step(d: -1 | 1): void;
  reload(): void;
}

interface NativeProps {
  id: string;
  url: string;
  visible: boolean;
  onUrl(url: string): void;
  onLoading(loading: boolean): void;
  onReloadLoop(loop: { url: string; count: number } | undefined): void;
  onFail(why: string): void;
  ref: React.Ref<NativeView>;
}

interface Navigated {
  id: string;
  url: string;
  // "moved": the page changed its address without loading (client-side
  // routing), so only the address bar follows.
  state: "started" | "committed" | "finished" | "moved";
}

// NativeSurface reserves the pane's space and keeps a child webview of the
// same size on top of it: open on mount, follow every move and resize, hide
// while the pane is hidden or one of the app's own popups is open (a native
// view would cover it), and close on unmount.
function NativeSurface({ id, url, visible, onUrl, onLoading, onReloadLoop, onFail, ref }: NativeProps) {
  const surface = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // Every call waits for the ones before it, so a hide or a resize never
  // reaches the webview before the open that creates it.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const send = (cmd: string, args: Record<string, unknown> = {}) => {
    const next = queue.current.then(() => call(cmd, { id, ...args }));
    queue.current = next.catch(() => {});
    return next;
  };
  // The URL the webview itself last reported, so a navigation it made is not
  // sent back to it as a new one.
  const reported = useRef<string>(undefined);
  const overlay = useAppOverlay();
  const shown = visible && !overlay;
  const callbacks = useRef({ onUrl, onLoading, onReloadLoop, onFail });
  callbacks.current = { onUrl, onLoading, onReloadLoop, onFail };

  // Whether the page is loading, and whether it keeps reloading itself, from
  // the webview's events and the app's own navigations (lib/page-loads.ts).
  const loads = useRef<PageLoads>(initialPageLoads);
  const apply = (next: PageLoads) => {
    const was = loads.current;
    loads.current = next;
    if (next.loading !== was.loading) callbacks.current.onLoading(next.loading);
    const a = reloadLoop(was);
    const b = reloadLoop(next);
    if (a?.url !== b?.url || a?.count !== b?.count) callbacks.current.onReloadLoop(b);
  };
  const note = (kind: PageEvent["kind"], url?: string) => apply(pageEvent(loads.current, { kind, url, at: Date.now() }));

  useImperativeHandle(
    ref,
    () => ({
      step: (d) => {
        note("step");
        void send(d < 0 ? "browser_back" : "browser_forward");
      },
      reload: () => {
        note("user");
        void send("browser_reload");
      },
    }),
    [id],
  );

  // Follow the page's own navigations.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void listen<Navigated>("berth://browser", (e) => {
      if (e.payload.id !== id) return;
      if (e.payload.state === "moved") {
        if (e.payload.url !== reported.current) {
          reported.current = e.payload.url;
          callbacks.current.onUrl(e.payload.url);
        }
        return;
      }
      note(e.payload.state, e.payload.url);
      if (e.payload.state === "finished") {
        reported.current = e.payload.url;
        callbacks.current.onUrl(e.payload.url);
      }
    }).then((un) => (gone ? un() : (stop = un)));
    // A navigation that started in a frame inside the page never finishes the
    // page: stop its spinner after a while.
    const timer = window.setInterval(() => apply(settle(loads.current, Date.now())), 1000);
    return () => {
      gone = true;
      stop?.();
      window.clearInterval(timer);
    };
    // apply and note read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Open once; navigate when the pane's URL changes from outside.
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    if (!opened.current) {
      const r = bounds(el);
      opened.current = true;
      note("user");
      send("browser_open", { url, ...r }).catch((err) => {
        opened.current = false;
        callbacks.current.onFail(String(err));
      });
      return;
    }
    if (url !== reported.current) {
      note("user");
      void send("browser_navigate", { url });
    }
  }, [id, url]);

  // Close with the pane.
  useEffect(() => {
    return () => {
      opened.current = false;
      void send("browser_close");
    };
  }, [id]);

  // Show and place it while the pane is on screen; positions change without
  // sizes changing (a sidebar toggling), so a cheap rect check runs too.
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    if (!shown) {
      void send("browser_hide");
      return;
    }
    let last = "";
    const sync = () => {
      const r = bounds(el);
      const key = `${r.x},${r.y},${r.w},${r.h}`;
      if (key === last) return;
      last = key;
      void send("browser_set_bounds", r);
    };
    sync();
    void send("browser_show");
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    const timer = window.setInterval(sync, 250);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      window.clearInterval(timer);
    };
  }, [id, shown]);

  return (
    <div ref={surface} className={cn("relative min-h-0 flex-1 bg-white", !visible && "hidden")}>
      {overlay && visible && <div className="absolute inset-0 bg-background/40" />}
    </div>
  );
}

function bounds(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
}

function call(cmd: string, args: Record<string, unknown>) {
  return invoke(cmd, args).catch((err) => {
    // A pane closing while its window tears down, or a hide before the
    // webview exists, is not worth more than a debug line.
    if (cmd === "browser_open") throw err;
    console.debug(`${cmd}:`, err);
  });
}

// useAppOverlay is true while any of the app's own menus, dialogs or popups is
// open. Native webviews sit above the app's page, so a browser pane must step
// aside for them.
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-berth-overlay]';

function useAppOverlay(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(document.querySelector(OVERLAY) !== null);
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "data-berth-overlay"] });
    return () => mo.disconnect();
  }, []);
  return open;
}

function ToolButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn("inline-flex size-6.5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent [&_svg]:size-3.5")}
      >
        {children}
      </button>
    </Tip>
  );
}

// isLocal is a page the laptop serves or proxies, which a frame can show;
// most other sites refuse to be framed.
function isLocal(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

// ReloadLoopNotice says that the page keeps reloading itself, which is the
// page's own doing, and offers your own browser. It sits above the page,
// which is a native view that would cover anything drawn over it.
function ReloadLoopNotice({ loop, onOpen, onDismiss }: { loop: { url: string; count: number }; onOpen(): void; onDismiss(): void }) {
  return (
    <div role="status" className="flex shrink-0 items-start gap-2 border-b bg-warning/8 px-3 py-2 text-xs">
      <RotateCwIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">This page keeps reloading itself</p>
        <p className="text-muted-foreground">
          It has loaded {loop.count} times in a row without being asked. That is the page's own code reloading it (a dev server's client does this when a script fails to load), and it can happen in WebKit, the engine this tab uses, but not in Chrome. Your browser may show it fine.
        </p>
      </div>
      <Button size="sm" onClick={onOpen}>
        <ExternalLinkIcon />
        Open in your browser
      </Button>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

// FramedPage shows a page in an iframe, where the native view is not
// available (a plain browser, or when it failed). Sites that refuse to be
// framed would show the browser's own grey error, so they get a designed
// fallback instead, as does a page that never finishes loading.
// devtools asks the proxy for the page with the Console drawer's script in
// it (a worktree's page only: the flag must not reach another server).
function FramedPage({ id, url, devtools, onReload, onLoading }: { id: string; url: string; devtools?: boolean; onReload(): void; onLoading?(loading: boolean): void }) {
  const [state, setState] = useState<"loading" | "loaded" | "stuck" | "blocked">(isLocal(url) ? "loading" : "blocked");
  const told = useRef(onLoading);
  told.current = onLoading;
  useEffect(() => {
    if (state === "loading" || state === "loaded") told.current?.(state === "loading");
  }, [state]);
  useEffect(() => {
    if (state !== "loading") return;
    const t = window.setTimeout(() => setState("stuck"), 15_000);
    return () => window.clearTimeout(t);
  }, [state]);

  if (state === "blocked" || state === "stuck") {
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
          <p className="font-medium text-sm">{state === "blocked" ? `${host} can't be shown inside Shipyard` : `${host} isn't loading`}</p>
          <p className="text-muted-foreground text-xs">
            {state === "blocked" ? "Most sites refuse to be embedded in other apps. Open it in your browser instead." : "It has not answered in 15 seconds. It may still be starting, or it may refuse to be embedded."}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void openUrl(url)}>
              <ExternalLinkIcon />
              Open in your browser
            </Button>
            {!__BERTH_DEMO__ && <Button size="sm" variant="ghost" onClick={state === "blocked" ? () => setState("loading") : onReload}>
              {state === "blocked" ? "Try here anyway" : "Reload"}
            </Button>}
          </div>
        </div>
      </div>
    );
  }
  // The live demo has no dev servers and loads nothing from elsewhere: a
  // box's page is a stand-in drawn here, and other sites stay blocked.
  return (
    <iframe
      data-pane={id}
      name={devtools && !__BERTH_DEMO__ ? `${DEVTOOLS_FRAME}${id}` : undefined}
      src={__BERTH_DEMO__ ? undefined : devtools ? withDevtoolsFlag(url) : url}
      srcDoc={__BERTH_DEMO__ ? demoDevServer(url) : undefined}
      title={url}
      onLoad={() => setState("loaded")}
      className="min-h-0 flex-1 bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
    />
  );
}

// Suggestions offers the pane's worktree's dev servers, by the names the
// proxy knows them by, and pages opened recently, right under the address
// bar where the eye already is.
export function Suggestions({ ctx, onPick }: { ctx: BrowserContext; onPick(url: string): void }) {
  const list = suggestions(ctx);
  const recent = useWorkspaces((s) => s.recentUrls).slice(0, 5);
  const Row = ({ url, title, note }: { url: string; title: string; note?: string }) => (
    <button key={url} type="button" onClick={() => onPick(url)} className="group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        {note && <span className="block truncate font-mono text-muted-foreground text-xs">{note}</span>}
      </span>
      <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100" />
    </button>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-12 pb-6">
      <div className="flex w-full max-w-md flex-col gap-6">
        {list.length > 0 && (
          <section>
            <p className="mb-1 px-3 font-medium text-muted-foreground text-xs">Running in this worktree</p>
            {list.map((s) => (
              <Row key={s.port} url={s.url} title={`${s.port}${s.process ? ` · ${s.process}` : ""}`} note={s.url} />
            ))}
          </section>
        )}
        {recent.length > 0 && (
          <section>
            <p className="mb-1 px-3 font-medium text-muted-foreground text-xs">Recent</p>
            {recent.map((u) => (
              <Row key={u} url={u} title={u.replace(/^https?:\/\//, "").replace(/\/$/, "")} />
            ))}
          </section>
        )}
        {list.length === 0 && recent.length === 0 && (
          <p className="px-3 text-center text-muted-foreground text-xs">Type a port to open this worktree's dev server on {ctx.ref?.box ?? "its box"}, or any URL.</p>
        )}
      </div>
    </div>
  );
}

// humanUrl is the agent's URL as this laptop names the worktree: the agent's
// browser may call the box by another name, so its path is kept and the
// host is the one this laptop's proxy knows.
function humanUrl(agentUrl: string, ctx: BrowserContext): string {
  try {
    const u = new URL(agentUrl);
    const host = ctx.ref && worktreeHost(ctx.ref);
    if (!host || !u.hostname.endsWith(".localhost")) return agentUrl;
    return `http://${host}${hostSuffix(ctx.urlPort)}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return agentUrl;
  }
}

export interface AgentLive {
  running: boolean;
  url?: string;
  // Its page's size, as the box says it: 1920×1080.
  size?: string;
  // Its tabs, on a box that has them.
  tabs?: AgentBrowserTab[];
  // When the box said so (Date.now()).
  at: number;
}

// How old a status the agent's view may choose its tab from as it opens.
const FRESH_MS = 3000;

// The box's events that a tab opened, closed, or was used: worth asking
// again at once rather than at the next poll. Navigations and shots only
// while the tabs show, where activity is drawn.
const TAB_EVENTS = new Set(["browser.tab.opened", "browser.tab.closed"]);
const TAB_ACTIVITY = new Set(["browser.navigated", "browser.shot"]);

// AgentSize is the agent's page as the view shows it: w×h CSS pixels at a
// scale, shown at zoom (1 is its own size).
interface AgentSize {
  w: number;
  h: number;
  scale?: number;
  zoom: number;
}

// useAgentBrowserLive is whether an agent's browser runs on the box for the
// pane's worktree, checked while the pane is on screen (undefined until
// known, and always for a box without one), and again at once when the box
// says it opened or closed. tabs is set while the agent's view shows a box's
// tabs: it asks every 2s then, and at once when a tab opens, closes or is
// used, so the strip's activity is current and a closed tab is noticed.
function useAgentBrowserLive(ref: BrowserContext["ref"], visible: boolean, tabs: boolean): AgentLive | undefined {
  const box = ref?.box;
  const location = ref?.location;
  const worktree = ref?.worktree;
  const capable = !!box && boxHasBrowser(box);
  const nudge = useEventLog((s) => s.events.find((e) => e.box === box && (e.type === "browser.opened" || e.type === "browser.closed") && e.data?.path === ref?.path)?.time);
  const tabNudge = useEventLog((s) => s.events.find((e) => e.box === box && (TAB_EVENTS.has(e.type) || (tabs && TAB_ACTIVITY.has(e.type))) && e.data?.path === ref?.path)?.time);
  const [live, setLive] = useState<AgentLive>();
  const poller = useRef<Poller | null>(null);
  // Forgotten for another worktree, while the pane is away, and as the
  // browser opens or closes (a pane opened to watch it must not see the old
  // "not running" first); not when tabs only ask again, which would drop
  // the view for a moment.
  useEffect(() => setLive(undefined), [capable, visible, box, location, worktree, nudge]);
  useEffect(() => {
    if (!capable || !visible || !box || !location || !worktree) return;
    let on = true;
    let seen = "";
    // Every 5s, backing off to 30s while nothing changes, or every 2s up to
    // 10s while the view shows tabs; never while the window is hidden
    // (lib/poll).
    const p = poll(
      () =>
        agentBrowserStatus(box, location, worktree).then(
          (s) => {
            if (!on) return false;
            seedSandbox(box, s.health);
            const size = s.status?.size ?? s.size;
            const list = s.tabs ?? s.status?.tabs;
            setLive({ running: s.running, url: s.status?.url, size, tabs: list, at: Date.now() });
            const now = `${s.running}|${s.status?.url ?? ""}|${size ?? ""}|${JSON.stringify(list ?? [])}`;
            const changed = now !== seen;
            seen = now;
            return changed;
          },
          () => (on && setLive({ running: false, at: Date.now() }), false),
        ),
      tabs ? { every: 2000, max: 10_000 } : { every: 5000, max: 30_000 },
    );
    poller.current = p;
    return () => {
      on = false;
      p.stop();
      if (poller.current === p) poller.current = null;
    };
  }, [capable, visible, box, location, worktree, nudge, tabs]);
  useEffect(() => {
    if (tabNudge) poller.current?.kick();
  }, [tabNudge]);
  return live;
}

function LiveDot() {
  return (
    <span className="relative flex size-1.5 shrink-0">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/70" />
      <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
    </span>
  );
}

// AgentBar stands in for the address bar while you watch the agent's
// browser: it is plainly not yours, and nothing in it drives the agent's.
function AgentBar({
  ctx,
  url,
  size,
  fallbackSize,
  logKey,
  onBack,
  onOpenHere,
}: {
  ctx: BrowserContext;
  url?: string;
  size?: AgentSize;
  fallbackSize?: string;
  logKey?: string;
  onBack(): void;
  onOpenHere(url: string): void;
}) {
  const here = url ? humanUrl(url, ctx) : undefined;
  const label = size ? sizeLabel(size.w, size.h, size.scale) : fallbackSize;
  const zoom = size && size.zoom > 0 && size.zoom < 0.995 ? `${Math.round(size.zoom * 100)}%` : undefined;
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-emerald-500/[0.06] px-2 text-xs">
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-1 font-medium text-[11px] text-emerald-800 dark:text-emerald-300">
        <BotIcon className="size-3" />
        Agent's view · live
        <LiveDot />
      </span>
      <Tip label={<span className="break-all font-mono">{url ?? ""}</span>} className="max-w-md">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{here ?? "…"}</span>
      </Tip>
      {label && (
        <Tip
          label={
            <span>
              The agent's page is {label}
              {zoom ? `, shown at ${zoom} to fit` : ", at its own size"}. Agents set it with <span className="font-mono">berthd browser resize</span>.
            </span>
          }
          className="max-w-xs"
        >
          <span data-testid="agent-size" className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] text-emerald-800 tabular-nums dark:text-emerald-200">
            {label}
            {zoom && <span className="font-sans text-emerald-800 dark:text-emerald-200">· {zoom}</span>}
          </span>
        </Tip>
      )}
      {logKey && <DevtoolsToggle logKey={logKey} />}
      {here && (
        <Button size="xs" variant="ghost" className="shrink-0" onClick={() => onOpenHere(here)}>
          Open in your view
        </Button>
      )}
      <Button size="xs" variant="outline" className="shrink-0" onClick={onBack}>
        <XIcon />
        Your view
      </Button>
    </div>
  );
}

// AgentTabs is the strip of the agent's browser's tabs under its bar, one
// per agent that asked for its own: which one the view watches, which are
// being used now (a dot), and each one's page and size on hover. Choosing
// is the only thing it does; the agents' activity never chooses for you.
function AgentTabs({ tabs, watched, onPick }: { tabs: AgentBrowserTab[]; watched: string; onPick(name: string): void }) {
  const [seen, setSeen] = useState<TabSeen>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = Date.now();
    setSeen((s) => noteTabs(s, tabs, at));
    setNow(at);
  }, [tabs]);
  const active = new Set(tabs.filter((t) => tabActive(t, seen, now)).map((t) => t.name));
  // A dot fades a few seconds after its tab was last used, between polls.
  useEffect(() => {
    if (!active.size) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active.size > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex h-8 shrink-0 items-center border-b bg-emerald-500/[0.03] px-2">
      <ToggleGroup
        size="sm"
        value={[`tab:${watched}`]}
        onValueChange={(v) => {
          const next = (v as string[])[0];
          if (next !== undefined) onPick(next.slice(4));
        }}
        aria-label="The agent's browser's tabs"
        className="min-w-0 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((t) => (
          <Tip
            key={t.name}
            label={
              <span className="flex flex-col gap-0.5">
                {t.title && <span>{t.title}</span>}
                {t.url && <span className="break-all font-mono text-[11px] opacity-80">{t.url}</span>}
                <span className="font-mono text-[11px] tabular-nums opacity-80">
                  {t.size}
                  {active.has(t.name) && <span className="font-sans"> · in use</span>}
                </span>
              </span>
            }
            side="bottom"
            className="max-w-sm"
          >
            <ToggleGroupItem
              value={`tab:${t.name}`}
              data-active={active.has(t.name) || undefined}
              className="h-6! min-w-0! shrink-0 gap-1.5 px-2! font-normal text-muted-foreground text-xs sm:text-xs data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs dark:data-pressed:bg-input"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full transition-colors", active.has(t.name) ? "bg-emerald-500" : "bg-muted-foreground/25")} aria-hidden />
              {tabLabel(t.name)}
            </ToggleGroupItem>
          </Tip>
        ))}
      </ToggleGroup>
    </div>
  );
}

// SandboxBar stands in for the address bar while the pane shows why the
// agent's browser can't start.
function SandboxBar({ box, fixed, onBack }: { box: string; fixed: boolean; onBack(): void }) {
  return (
    <div className={cn("flex h-9 shrink-0 items-center gap-2 border-b px-2 text-xs", fixed ? "bg-success/[0.06]" : "bg-warning/[0.06]")}>
      <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium text-[11px]", fixed ? "bg-success/15 text-success-foreground" : "bg-warning/15 text-warning-foreground")}>
        <BotIcon className="size-3" />
        {fixed ? "Agent's browser" : "Agent's browser · blocked"}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">on {box}</span>
      <Button size="xs" variant="outline" className="shrink-0" onClick={onBack}>
        <XIcon />
        Your view
      </Button>
    </div>
  );
}

// AgentView shows the agent's browser on the box, live: frames stream only
// while this view is on screen. It only watches; the agent drives. The page
// shows as large as the pane allows but never past its own size: a frame's
// image is the page at its scale, so up to its CSS size it stays sharp.
// tab is the one it shows (lib/browser-tabs); undefined while that is still
// being chosen.
function AgentView({ ctx, visible, tab, onUrl, onSize }: { ctx: BrowserContext; visible: boolean; tab?: string; onUrl(url?: string): void; onSize(size?: AgentSize): void }) {
  const ref = ctx.ref!;
  const [frame, setFrame] = useState<Frame>();
  const [error, setError] = useState<string>();
  const space = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number }>();
  useEffect(() => {
    const el = space.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setAvail((was) => (was && was.w === Math.floor(r.width) && was.h === Math.floor(r.height) ? was : { w: Math.floor(r.width), h: Math.floor(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fw = frame?.w ?? 0;
  const fh = frame?.h ?? 0;
  const fit = useMemo(() => (avail ? fitFrame(fw, fh, avail.w, avail.h) : undefined), [fw, fh, avail]);
  useEffect(() => {
    onSize(fw && fit ? { w: fw, h: fh, scale: frame?.scale, zoom: fit.zoom } : undefined);
    // onSize is the pane's state setter, the same every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fw, fh, frame?.scale, fit?.zoom]);
  useEffect(() => () => onSize(undefined), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!visible || tab === undefined) return;
    const ac = new AbortController();
    setError(undefined);
    // Another tab's last frame must not stand in for this one's.
    setFrame(undefined);
    const show = (f: Frame) => {
      setFrame(f);
      if (f.url) onUrl(f.url);
    };
    watchAgentBrowser(ref.box, ref.location, ref.worktree, show, ac.signal, tab).catch((e) => {
      if (!ac.signal.aborted) setError(String(e));
    });
    return () => {
      ac.abort();
      onUrl(undefined);
    };
    // onUrl is the pane's state setter, the same every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ref.box, ref.location, ref.worktree, tab]);
  return (
    <div ref={space} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30 p-3">
      {frame ? (
        <img
          alt="The agent's browser"
          data-testid="agent-frame"
          data-tab={tab}
          data-size={sizeLabel(frame.w, frame.h, frame.scale)}
          src={`data:${frame.mime ?? "image/jpeg"};base64,${frame.data}`}
          // A ring, not a border: a border would take two pixels off the
          // image and blur it at its own size.
          className="max-h-full max-w-full shrink-0 rounded bg-white object-contain shadow-sm ring-1 ring-border"
          style={fit && fit.w > 0 ? { width: fit.w, height: fit.h } : undefined}
        />
      ) : error ? (
        <p className="max-w-xs text-center text-muted-foreground text-xs">{error}</p>
      ) : (
        <Spinner className="size-4" />
      )}
    </div>
  );
}

// PickSender sends a picked element to the worktree's agent, with a note.
function PickSender({ pick, ctx, onDone }: { pick: Pick; ctx: BrowserContext; onDone(): void }) {
  const ref = ctx.ref!;
  const session = useStore((s) => s.boxes[ref.box]?.sessions?.find((x) => x.dir === ref.path && !x.exited && agentOf(x)));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await sendPrompt(ref.box, session.name, pickMessage(pick, note), { when: "idle" });
      toastManager.add({ type: "success", title: "Sent to the agent", description: `${pick.role}${pick.name ? ` "${pick.name}"` : ""}` });
      onDone();
    } catch (err) {
      toastManager.add({ type: "error", title: "Couldn't send it", description: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-b bg-accent/40 px-2 py-1.5 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <CrosshairIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-56 shrink-0 truncate font-mono">
        {pick.role}
        {pick.name && ` "${pick.name}"`}
      </span>
      <input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={session ? "What about it? (optional)" : "No agent runs in this worktree"}
        disabled={!session}
        className="h-6 min-w-0 flex-1 rounded border bg-background px-2 outline-none focus:border-ring"
      />
      <Button type="submit" size="xs" disabled={!session || busy}>
        <SendIcon />
        Send to agent
      </Button>
      <button type="button" aria-label="Cancel" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onDone}>
        <XIcon className="size-3.5" />
      </button>
    </form>
  );
}
