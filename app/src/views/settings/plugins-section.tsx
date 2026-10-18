import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { ApiError, laptopApi, type PluginInfo } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { bytes, errorMessage } from "@/lib/format";
import { marketAction, marketNote, type Marketplace, type MarketPlugin } from "@/lib/marketplace";
import { openDocs, openUrl } from "@/lib/open-url";
import { heldNote, type PluginHelpers, stopNote, stoppedNote } from "@/lib/plugin-helpers";
import { builtinOn, setBuiltinOn, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { askToAllow, type PluginHelper, readPluginHelper, usePluginConsent } from "@/plugins/consent";
import { builtinPlugins, loadPlugins } from "@/plugins/host";
import { useRegistry } from "@/plugins/registry";
import { ConfirmDialog } from "@/views/settings/confirm";
import { Code, SettingsGroup, SettingsPage } from "@/views/settings/rows";
import { ErrorText } from "@/components/error-note";
import { Tip } from "@/components/tip";

export function PluginsSection() {
  const client = useStore((s) => s.client);
  const loaded = useRegistry((s) => s.plugins);
  const [installed, setInstalled] = useState<PluginInfo[]>();
  const [builtins, setBuiltins] = useState<PluginInfo[]>();
  const [reloading, setReloading] = useState(false);
  useEffect(() => void builtinPlugins().then(setBuiltins), []);

  const refresh = useCallback(async () => {
    if (client) setInstalled(await client.plugins().catch(() => []));
  }, [client]);
  // Read again whenever the consent dialog closes: it also opens by itself,
  // for a plugin an update changed, and allowing it there turns it on.
  const consenting = usePluginConsent((s) => !!s.request);
  useEffect(() => {
    if (!consenting) void refresh();
  }, [refresh, consenting]);

  // The listing: what the agent read from the registry, merged with what is
  // installed here. error is in plain words; old is an agent from before
  // the marketplace.
  const [market, setMarket] = useState<{ list?: Marketplace; error?: string; old?: boolean; reading?: boolean }>({ reading: true });
  const browse = useCallback(
    async (fresh = false) => {
      if (!client) return;
      setMarket((m) => ({ ...m, reading: true }));
      try {
        setMarket({ list: await laptopApi.marketplace(client, fresh) });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && !err.code) setMarket({ old: true });
        else setMarket({ error: plainError(err) });
      }
    },
    [client],
  );
  useEffect(() => void browse(), [browse]);

  const reload = async () => {
    if (!client) return;
    setReloading(true);
    await loadPlugins(client);
    await Promise.all([refresh(), browse()]);
    setReloading(false);
  };

  return (
    <SettingsPage
      title="Plugins"
      description={
        <>
          Plugins aren't sandboxed, so each stays off until you allow it.
        </>
      }
    >
      <SettingsGroup
        title="Installed"
        actions={
          <span className="flex items-center gap-3">
            <span className="font-mono text-muted-foreground text-mono">~/.berth/plugins</span>
            <Button size="xs" variant="ghost" className="gap-1.5" loading={reloading} onClick={() => void reload()}>
              <RefreshCwIcon className="mr-0.5" /> Reload
            </Button>
          </span>
        }
      >
        {installed === undefined ? (
          <div className="py-6 text-center text-muted-foreground text-body">Loading…</div>
        ) : installed.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground text-body">
            No plugins yet. Install one from Browse, or{" "}
            <button type="button" onClick={() => void openDocs("/guides/plugins")} className="underline underline-offset-2 hover:text-foreground">
              write one
            </button>
            .
          </div>
        ) : (
          installed.map((p) => <PluginRow key={p.id} plugin={p} status={loaded.find((l) => l.id === p.id)} onChanged={() => void reload()} />)
        )}
      </SettingsGroup>
      <SettingsGroup title="Built in" actions={<span className="text-desc text-muted-foreground">Same plugin API as yours; one of yours with the same id replaces it</span>}>
        {builtins === undefined ? (
          <div className="py-6 text-center text-muted-foreground text-body">Loading…</div>
        ) : builtins.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground text-body">This build has no built-in plugins.</div>
        ) : (
          builtins.map((p) => (
            <BuiltinRow key={p.id} plugin={p} status={loaded.find((l) => l.id === p.id && l.builtin)} replaced={installed?.some((u) => u.id === p.id) ?? false} onChanged={() => void reload()} />
          ))
        )}
      </SettingsGroup>
      <SettingsGroup
        title="Browse"
        description={
          market.list ? (
            <>
              Plugins listed at <Code>{market.list.host}</Code>. Installing one puts it under Installed, off until you allow it.
            </>
          ) : (
            "Installing one puts it under Installed, off until you allow it."
          )
        }
        actions={
          !market.old && (
            <Button size="xs" variant="ghost" className="gap-1.5 text-muted-foreground" disabled={market.reading} onClick={() => void browse(true)}>
              <RefreshCwIcon className={cn(market.reading && "animate-spin")} /> Read the listing again
            </Button>
          )
        }
      >
        {market.old ? (
          <p className="py-3.5 text-muted-foreground text-body">The Shipyard agent on this computer is older than this app, so it can't read the listing yet.</p>
        ) : market.error ? (
          <div className="flex items-center gap-4 py-3.5" data-testid="market-error">
            <ErrorText className="min-w-0 flex-1 text-destructive-foreground text-body" text={market.error} />
            <Button size="xs" variant="outline" className="min-w-24" loading={market.reading} onClick={() => void browse(true)}>
              Try again
            </Button>
          </div>
        ) : !market.list ? (
          <div className="px-4 py-6 text-center text-muted-foreground text-body">Loading…</div>
        ) : market.list.plugins.length === 0 ? (
          <div className="px-4 py-6 text-center text-muted-foreground text-body">Nothing is listed yet.</div>
        ) : (
          market.list.plugins.map((p) => <MarketRow key={p.id} plugin={p} was={installed?.find((u) => u.id === p.id)} onChanged={() => void reload()} onStale={() => void browse(true)} />)
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

// MarketRow is one listed plugin: what it is, and the one thing to do about
// it. Installing only puts it in ~/.berth/plugins; turning it on is the
// Installed row's switch, which asks first.
function MarketRow({ plugin: p, was, onChanged, onStale }: { plugin: MarketPlugin; was?: PluginInfo; onChanged(): void; onStale(): void }) {
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const action = marketAction(p);
  const note = marketNote(p);

  const install = async (replace = false) => {
    const client = useStore.getState().client;
    if (!client) return;
    setBusy(true);
    try {
      await laptopApi.installPlugin(client, p.id, p.version, replace);
      toastManager.add({
        title: action === "update" ? `Updated ${p.name} to ${p.version}` : `Installed ${p.name}`,
        description: was?.allowed ? "Shipyard asks again before the new code runs." : "It's off until you turn it on under Installed.",
        type: "success",
      });
      onChanged();
    } catch (err) {
      toastManager.add({ title: `Couldn't ${action === "update" ? "update" : "install"} ${p.name}`, description: errorMessage(err), type: "error" });
      // The row showed something that is no longer so: read the listing again.
      if (err instanceof ApiError && (err.code === "listing_changed" || err.code === "plugin_by_hand")) onStale();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4 py-3.5" data-testid="market-plugin" data-plugin={p.id}>
      <span className="size-2 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-row">
          <span>{p.name}</span>
          <span className="text-muted-foreground text-meta">{p.version}</span>
        </div>
        {p.description && <div className="mt-0.5 text-desc text-muted-foreground">{p.description}</div>}
        <div className="mt-0.5 font-mono text-tag text-muted-foreground">
          {p.id}
          {p.author && ` · by ${p.author}`}
          {` · ${bytes(p.size)}`}
          {/* The agent keeps only https links; the app opens nothing else either. */}
          {p.homepage?.startsWith("https://") && (
            <>
              {" · "}
              <button type="button" onClick={() => void openUrl(p.homepage!)} className="underline underline-offset-2 hover:text-foreground">
                homepage
              </button>
            </>
          )}
        </div>
        {note && <div className="mt-1 text-muted-foreground text-meta">{note}</div>}
        {p.error && (
          <div className="mt-1 text-meta">
            <span className="text-destructive-foreground">It can't be installed:</span> <span className="text-muted-foreground">{p.error}.</span>
          </div>
        )}
      </div>
      {action === "installed" ? (
        <Badge variant="outline" size="sm">
          Installed
        </Badge>
      ) : action === "replace" ? (
        <Button size="xs" variant="outline" className="min-w-24" loading={busy} onClick={() => setReplacing(true)}>
          Replace…
        </Button>
      ) : action !== "unavailable" ? (
        <Button size="xs" variant="outline" className="min-w-24" loading={busy} onClick={() => void install()}>
          {action === "update" ? "Update" : "Install"}
        </Button>
      ) : null}
      <ConfirmDialog
        open={replacing}
        onOpenChange={setReplacing}
        destructive
        title={`Replace your ${p.name}?`}
        description={`~/.berth/plugins/${p.id} holds a plugin the listing didn't install, or one changed since. Its folder is deleted and ${p.name} ${p.version} from the listing takes its place, off until you allow it.`}
        confirm="Replace"
        onConfirm={() => install(true)}
      />
    </div>
  );
}

function PluginRow({ plugin: p, status, onChanged }: { plugin: PluginInfo; status?: { state: string; error?: string }; onChanged(): void }) {
  const [removing, setRemoving] = useState(false);
  // Never on until you allow it, and off again when it changes.
  const enabled = p.enabled === true;
  const review = !enabled && (p.changed || status?.state === "review");
  // The agent counts a plugin's hooks; older builds listed them.
  const hooks = Array.isArray(p.hooks) ? p.hooks.length : typeof p.hooks === "number" ? (p.hooks as number) : 0;
  const error = p.error ?? status?.error;
  const state = review ? "review" : !enabled ? "off" : error ? "failed" : (status?.state ?? "loading");
  // The program it carries for boxes, if any: its manifest says, and the
  // row says so too, on or off.
  const [helper, setHelper] = useState<PluginHelper>();
  useEffect(() => {
    const client = useStore.getState().client;
    if (!client) return;
    let live = true;
    void readPluginHelper(client, p).then((h) => live && setHelper(h));
    return () => {
      live = false;
    };
    // Read again when its files change: a new version, or a new permission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, p.version, p.allowed, p.changed]);

  // A plugin's program doesn't outlive it: turning the plugin off, or
  // removing it, stops the program on the boxes. So both ask first, and say
  // where; and a plugin that is off for review says if its program was left
  // running meanwhile. where is the agent's word on which boxes have it.
  const [turningOff, setTurningOff] = useState(false);
  const [where, setWhere] = useState<PluginHelpers>();
  const asking = turningOff || removing;
  useEffect(() => {
    const client = useStore.getState().client;
    if (!client || !helper || (enabled && !asking)) return;
    let live = true;
    // An agent older than this answers nothing: the words then name no box.
    laptopApi.pluginHelpers(client, p.id).then(
      (h) => live && setWhere(h),
      () => live && setWhere(undefined),
    );
    return () => {
      live = false;
    };
  }, [p.id, helper, enabled, asking, p.changed, p.allowed]);
  const held = !enabled && helper ? heldNote(helper.name, where) : undefined;

  const turnOff = async () => {
    const client = useStore.getState().client;
    if (!client) return;
    try {
      const out = await laptopApi.disablePlugin(client, p.id);
      const note = helper && stoppedNote(helper.name, out.helpers);
      if (note) toastManager.add({ title: enabled ? `Turned off ${p.name}` : `Stopped ${helper.name}`, description: note, type: "success" });
      setWhere(undefined);
      onChanged();
    } catch (err) {
      toastManager.add({ title: `Couldn't turn off ${p.name}`, description: errorMessage(err), type: "error" });
    }
  };

  return (
    <div className="flex items-center gap-4 py-4" data-testid="plugin-row" data-plugin={p.id}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-row">
          <StatusDot state={state} />
          <span>{p.name}</span>
          <span className="text-muted-foreground text-meta">{p.version}</span>
        </div>
        {p.description && <div className="mt-0.5 text-desc text-muted-foreground">{p.description}</div>}
        <Contributions plugin={p.id} />
        <div className="mt-0.5 font-mono text-tag text-muted-foreground">
          {p.id}
          {hooks > 0 && ` · ${hooks} hook${hooks === 1 ? "" : "s"}`}
          {p.source === "marketplace" && " · from the listing"}
        </div>
        {helper && (
          <div className="mt-1 text-muted-foreground text-meta" data-testid="plugin-helper">
            It can also install and run a program, <Code>{helper.name}</Code>, on the boxes you turn it on for.
          </div>
        )}
        {review && (
          <div className="mt-1 text-meta">
            <span className="text-warning-foreground">Changed since you allowed it, so it's off.</span>{" "}
            <button type="button" onClick={() => void askToAllow(p).then((ok) => ok && onChanged())} className="underline underline-offset-2 hover:text-foreground">
              Review it
            </button>
          </div>
        )}
        {held && (
          <div className="mt-1 text-muted-foreground text-meta" data-testid="plugin-helper-held">
            {held}{" "}
            <button type="button" onClick={() => setTurningOff(true)} className="underline underline-offset-2 hover:text-foreground">
              Stop it
            </button>
          </div>
        )}
        {error && enabled && status?.state !== "review" && (
          <div className="mt-1 text-meta">
            <span className="text-destructive-foreground">{error}</span> <span className="text-muted-foreground">Fix it in ~/.berth/plugins/{p.id}, then Reload.</span>
          </div>
        )}
      </div>
      {/* One the listing installed is the app's to remove; a folder of your own is yours. */}
      {p.source === "marketplace" && (
        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setRemoving(true)}>
          Remove…
        </Button>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        destructive
        title={`Remove ${p.name}?`}
        description={`Its folder, ~/.berth/plugins/${p.id}, is deleted and what you allowed is forgotten. ${helper ? `${stopNote(helper.name, where, true)} ` : ""}You can install it again from Browse.`}
        confirm="Remove"
        onConfirm={async () => {
          const client = useStore.getState().client;
          if (!client) return;
          try {
            const out = await laptopApi.uninstallPlugin(client, p.id);
            toastManager.add({ title: `Removed ${p.name}`, description: helper && stoppedNote(helper.name, out.helpers), type: "success" });
            onChanged();
          } catch (err) {
            toastManager.add({ title: `Couldn't remove ${p.name}`, description: errorMessage(err), type: "error" });
          }
        }}
      />
      {helper && (
        <ConfirmDialog
          open={turningOff}
          onOpenChange={setTurningOff}
          title={enabled ? `Turn off ${p.name}?` : `Stop ${helper.name}?`}
          description={`${stopNote(helper.name, where)} Turning ${p.name} on again doesn't start it: you turn it on for each box again.`}
          confirm={enabled ? "Turn off" : "Stop it"}
          onConfirm={turnOff}
        />
      )}
      <Switch
        checked={enabled}
        aria-label={enabled ? `Turn off ${p.name}` : `Turn on ${p.name}`}
        onCheckedChange={async (on) => {
          const client = useStore.getState().client;
          if (!client) return;
          // Turning a plugin on asks first: see plugin-consent-dialog. So
          // does turning off one whose program runs on boxes.
          if (!on && helper) return setTurningOff(true);
          if (!on) return turnOff();
          try {
            if (await askToAllow(p)) onChanged();
          } catch (err) {
            toastManager.add({ title: `Couldn't turn on ${p.name}`, description: errorMessage(err), type: "error" });
          }
        }}
      />
    </div>
  );
}

function BuiltinRow({ plugin: p, status, replaced, onChanged }: { plugin: PluginInfo; status?: { state: string; error?: string }; replaced: boolean; onChanged(): void }) {
  const off = usePrefs((s) => !builtinOn(p, s));
  const state = replaced || off ? "off" : status?.error ? "failed" : (status?.state ?? "loading");
  return (
    <div className="flex items-center gap-4 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-row">
          <StatusDot state={state} />
          <span>{p.name}</span>
          <span className="font-normal text-muted-foreground text-meta">{p.version}</span>
        </div>
        {p.description && <div className="mt-0.5 text-desc text-muted-foreground">{p.description}</div>}
        <Contributions plugin={p.id} />
        {p.defaultEnabled === false && off && !replaced && <div className="mt-0.5 text-muted-foreground text-meta">Off until you turn it on.</div>}
        {replaced && <div className="mt-0.5 text-muted-foreground text-meta">Replaced by your plugin with the same id.</div>}
        {status?.error && !off && <div className="mt-1 text-destructive-foreground text-meta">{status.error}</div>}
      </div>
      <Switch
        checked={!off}
        disabled={replaced}
        aria-label={off ? `Turn on ${p.name}` : `Turn off ${p.name}`}
        onCheckedChange={(on) => {
          setBuiltinOn(p, on);
          onChanged();
        }}
      />
    </div>
  );
}

// StatusDot marks only what needs attention, before the name: the switch
// already says on.
function StatusDot({ state }: { state: string }) {
  if (state === "active" || state === "off") return null;
  return (
    <Tip label={state}>
      <span role="img" aria-label={state} className={cn("size-1.5 shrink-0 self-center rounded-full", state === "failed" ? "bg-destructive" : "bg-warning")} />
    </Tip>
  );
}

// Contributions lists what a loaded plugin adds to the app.
function Contributions({ plugin }: { plugin: string }) {
  const r = useRegistry();
  const mine = <T,>(list: { plugin: string; item: T }[]) => list.filter((c) => c.plugin === plugin).map((c) => c.item);
  const parts = [
    ...mine(r.sidebarItems).map((i) => `Sidebar: ${i.title}`),
    ...mine(r.worktreePanels).map((i) => `Panel: ${i.title}`),
    ...mine(r.worktreeSections).map((i) => `Worktree section${i.title ? `: ${i.title}` : ""}`),
    ...mine(r.homeWidgets).map((i) => `Home widget: ${i.title}`),
    ...(mine(r.statusBarItems).length ? ["Status bar"] : []),
    ...(mine(r.commands).length ? [`${mine(r.commands).length} command${mine(r.commands).length === 1 ? "" : "s"}`] : []),
    ...(mine(r.themes).length ? [`${mine(r.themes).length} theme${mine(r.themes).length === 1 ? "" : "s"}`] : []),
  ];
  if (!parts.length) return null;
  return <div className="mt-0.5 text-muted-foreground text-meta">{parts.join(" · ")}</div>;
}
