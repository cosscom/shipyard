import { useEffect } from "react";

import { mockAgentDown, waitForRetry } from "@/lib/agent-start";
import { endpoint, httpClient, type Client } from "@/lib/api";
import { handleEvent } from "@/lib/events";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { loadNav } from "@/lib/nav";
import { loadNotifications } from "@/lib/notifications";
import { loadProjects } from "@/lib/project-groups";
import { reloadKits } from "@/views/kits/kits-store";
import { loadPlugins } from "@/plugins/host";

// The live demo (pnpm build:demo) is always mock mode.
export const isMock = () => __BERTH_DEMO__ || new URLSearchParams(location.search).has("mock");

// How often everything is fetched again while connected, in case an event
// was missed: the event stream says what changed as it does.
const BACKSTOP = 60_000;

// useBerthConnection finds the agent, keeps trying until it answers, then
// follows its events and polls slowly as a backstop. Every reconnect of the
// event stream refetches everything, so nothing missed while away (sleep, a
// network change, the agent restarting) stays stale.
export function useBerthConnection() {
  useEffect(() => {
    const abort = new AbortController();
    const { setClient, setConnection, refreshAll } = useStore.getState();
    let poll = 0;
    let first = 0;

    const connect = async (): Promise<Client | undefined> => {
      let delay = 1000;
      while (!abort.signal.aborted) {
        try {
          // ?mock=offline is the "not running" screen until its agent starts.
          if (mockAgentDown()) throw new Error("the Shipyard agent has not started yet (mock)");
          // The fixtures load only in mock mode: they stay out of the app's
          // startup.
          if (isMock()) return (await import("@/lib/mock")).mockClient();
          const client = httpClient(await endpoint());
          await client.status();
          return client;
        } catch (err) {
          setConnection({ state: "offline", error: errorMessage(err) });
        }
        // Starting the agent from the "not running" screen asks for a try now.
        if ((await waitForRetry(delay)) === "retry") delay = 1000;
        else delay = Math.min(delay * 2, 10_000);
      }
    };

    void connect().then((client) => {
      if (!client || abort.signal.aborted) return;
      setClient(client);
      // The first fetch of everything waits for the event stream, so that
      // nothing can change unheard between the two, and is the only one:
      // fetching before it as well read every box twice on each start. A
      // stream slow to open doesn't hold the app back for long.
      let synced = false;
      first = window.setTimeout(() => !synced && void refreshAll(), 1500);
      void loadPlugins(client);
      void loadProjects();
      void loadNav();
      void loadNotifications();
      // Project menus show each project's kit status.
      void reloadKits();
      client.events(
        handleEvent,
        () => {
          synced = true;
          void refreshAll();
        },
        abort.signal,
      );
      // The backstop: events say what changed, so this only catches what
      // one missed. Not while the window is hidden; coming back refreshes.
      poll = window.setInterval(() => !document.hidden && void refreshAll(), BACKSTOP);
    });

    // Focus and visibility come back together: one refresh for both.
    let woke = 0;
    const onWake = () => {
      if (Date.now() - woke < 2000) return;
      woke = Date.now();
      void useStore.getState().refreshAll();
    };
    const onVisible = () => !document.hidden && onWake();
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      abort.abort();
      window.clearInterval(poll);
      window.clearTimeout(first);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
