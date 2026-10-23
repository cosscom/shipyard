import type { BerthApi, BerthPluginContext } from "@berth/plugin";
import { createContext } from "react";

import { boxApi, type Client } from "@/lib/api";
import { attachApi, localPaths } from "@/lib/attachments";
import { makeHelperApi } from "@/lib/helper";
import { makeLinearApi } from "@/lib/linear";
import { notify } from "@/lib/notify";
import * as orchestrate from "@/lib/orchestrate";
import { makePromptsApi } from "@/lib/prompts-api";
import { openUrl } from "@/lib/open-url";
import { useStore } from "@/lib/store";
import { hostSuffix, portUrl } from "@/lib/browser-url";
import { focusSession, openBrowser, openPanel, selectWorktree } from "@/lib/workspaces";
import { useRegistry } from "@/plugins/registry";
import { openSettings, type SettingsSectionId } from "@/views/settings/open";
import { contribute, rememberScreenOwner } from "@/plugins/registry";

// The context a plugin's components render under, so useBerth() finds it.
export const PluginReactContext = createContext<BerthPluginContext | null>(null);

export function makeApi(client: Client): BerthApi {
  return {
    status: () => client.status(),
    boxes: async () => (await client.status()).boxes,
    locations: (box) => boxApi.locations(client, box),
    sessions: (box) => boxApi.sessions(client, box),
    stats: (box) => boxApi.stats(client, box),
    services: (box) => boxApi.services(client, box),
    info: (box) => boxApi.info(client, box),
    request: (box, method, path, body) => client.box(box, method, path, body),
    createTask: (box, task) => boxApi.createTask(client, box, task),
    renameSession: (box, session, title) => boxApi.renameSession(client, box, session, title),
    serviceUrl: (box, port) => {
      const st = useStore.getState();
      const services = st.boxes[box]?.services ?? [];
      const urlPort = st.status?.proxy.url_port;
      const svc = services.find((s) => s.port === port);
      const ref = svc && { box, location: svc.location, worktree: svc.worktree, path: svc.path, main: svc.main };
      return (ref && portUrl(port, { ref, services, urlPort })) ?? `http://${port}.${box}.localhost${hostSuffix(urlPort)}/`;
    },
    attach: attachApi(client, (box) => useStore.getState().status?.boxes.find((b) => b.name === box)?.address),
    localPaths,
  };
}

// pluginStorage keeps a plugin's values in localStorage under its own
// prefix. Storage can be unavailable (private windows); reads then fall back.
export function pluginStorage(id: string) {
  const key = (k: string) => `berth.plugin.${id}.${k}`;
  return {
    get<T>(k: string, fallback: T): T {
      try {
        const raw = localStorage.getItem(key(k));
        return raw == null ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    set(k: string, value: unknown) {
      try {
        localStorage.setItem(key(k), JSON.stringify(value));
      } catch {
        // Nowhere to keep it; the value lasts until reload.
      }
    },
  };
}

// makeContext builds what a plugin's activate receives. Every contribution is
// tagged with the plugin's id, so unloading the plugin removes all of it.
export function makeContext(id: string, client: Client): BerthPluginContext {
  const tag = <T,>(item: T) => ({ plugin: id, item });
  return {
    id,
    api: makeApi(client),
    addSidebarItem: (item) => contribute("sidebarItems", tag(item)),
    addScreen: (screen) => {
      rememberScreenOwner(screen.id, id);
      return contribute("screens", tag(screen));
    },
    addWorktreePanel: (panel) => contribute("worktreePanels", tag(panel)),
    addWorktreeSection: (section) => contribute("worktreeSections", tag(section)),
    addHomeWidget: (widget) => contribute("homeWidgets", tag(widget)),
    addCommand: (command) => contribute("commands", tag(command)),
    addStatusBarItem: (item) => contribute("statusBarItems", tag(item)),
    addTheme: (theme) => contribute("themes", tag(theme)),
    on: (type, handler) => contribute("handlers", tag({ type, handler })),
    notify: (title, body) => notify(title, body),
    openScreen: (screen) => useStore.getState().setView({ kind: "plugin", screen }),
    openSettings: (section) => openSettings(section as SettingsSectionId | undefined),
    openTerminal: (box, session) => void focusSession(box, session),
    openUrl: (url) => void openUrl(url),
    openWorktree: (w) => selectWorktree(w),
    openBrowser: (url, opts) => openBrowser(url, opts),
    openPanel: (panel, opts) => {
      const p = useRegistry.getState().worktreePanels.find((c) => c.plugin === id && c.item.id === panel);
      if (p) openPanel(id, panel, p.item.title, opts);
    },
    storage: pluginStorage(id),
    prompts: makePromptsApi(),
    linear: makeLinearApi(client),
    helper: makeHelperApi(client, id),
    orchestrate: {
      send: orchestrate.send,
      wait: orchestrate.wait,
      waitTurn: orchestrate.waitTurn,
      exec: orchestrate.exec,
      handoff: orchestrate.handoff,
      review: orchestrate.review,
      loop: orchestrate.loop,
      runs: orchestrate.runs,
    },
  };
}
