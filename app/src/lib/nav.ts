import { create } from "zustand";

import { toastManager } from "@/components/ui/toast";
import { plainError } from "@/lib/errors";
import { DEFAULT, move, type NavLayout, type NavList, type NavState, navSync, place } from "@/lib/nav-core";
import { type Poller, poll } from "@/lib/poll";
import { useStore } from "@/lib/store";

// The app's places, arranged by the person: a few pinned at the top, the
// rest under More, and some hidden (still in ⌘K). The sidebar, its folded
// rail and zen's switcher all show this one arrangement. Stored on the
// laptop agent (/v1/app/sidebar). Anything new, such as a plugin's screen,
// lands in More, never in Pinned. The arranging itself is in nav-core.

export { arrange, type NavLayout, type NavList } from "@/lib/nav-core";

// What Customize says while the stored arrangement hasn't been read.
export const NAV_NOT_LOADED = "Your saved layout hasn't loaded yet. Trying again…";

export const useNav = create<NavState>()(() => ({ layout: DEFAULT, loaded: false }));

const sidebarDoc = <T,>(method: "GET" | "PUT", body?: unknown) => {
  const client = useStore.getState().client;
  return client ? client.laptop<T>(method, "/v1/app/sidebar", body) : Promise.reject(new Error("not connected to the Shipyard agent"));
};

const sync = navSync(
  {
    get: () => sidebarDoc("GET"),
    put: (layout) => sidebarDoc("PUT", layout),
    describe: (err) => {
      const msg = plainError(err);
      if (msg !== useNav.getState().error) console.warn(`sidebar layout: ${msg}`);
      return msg;
    },
  },
  { get: () => useNav.getState(), set: (p) => useNav.setState(p) },
);

// loadNav reads the stored arrangement, trying again (after 1 s, doubling
// to 10 s, not while the window is hidden) until it has it: the agent may be
// restarting as the app starts, as after an update.
let loading: Poller | undefined;
export function loadNav() {
  if (loading || useNav.getState().loaded) return;
  const p = poll(
    async () => {
      if (!(await sync.load())) return false;
      p.stop();
      loading = undefined;
    },
    { every: 1000, max: 10_000 },
  );
  loading = p;
}
// retryNav tries now, as the agent is back (the event stream reconnected).
export const retryNav = () => loading?.kick();

// Until the stored arrangement is read nothing changes it: a change would
// save the default over it. Every way to change it comes through here.
export const navReady = () => {
  if (useNav.getState().loaded) return true;
  toastManager.add({ type: "info", title: NAV_NOT_LOADED });
  return false;
};

const save = (fn: (l: NavLayout) => NavLayout) => (navReady() ? sync.save(fn) : Promise.resolve(false));

export const navActions = {
  place: (id: string, list: NavList, index: number | undefined, ids: string[]) => save((l) => place(l, id, list, index, ids)),
  move: (id: string, dir: -1 | 1, ids: string[]) => save((l) => move(l, id, dir, ids)),
  reset: () => save(() => DEFAULT),
};
