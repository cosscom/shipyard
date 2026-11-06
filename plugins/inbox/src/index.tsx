import { definePlugin } from "@berth/plugin";
import { useSyncExternalStore } from "react";

import { InboxScreen, openOf } from "./screen.tsx";
import { getState, startFeed, subscribe } from "./store.ts";

// One inbox across every agent on every box. Nothing here decides for you: it
// shows what's waiting and carries your answer back to the session that asked.

function useOpenCount() {
  return useSyncExternalStore(subscribe, () => openOf(getState()).length);
}

export default definePlugin((berth) => {
  const stop = startFeed(berth);
  berth.addScreen({ id: "inbox", title: "Inbox", layout: "fill", Component: () => <InboxScreen berth={berth} /> });
  berth.addSidebarItem({ id: "inbox", title: "Inbox", icon: "Inbox", screen: "inbox", useCount: useOpenCount });
  berth.addCommand({ id: "open", title: "Open Inbox", group: "Inbox", run: () => berth.openScreen("inbox") });
  return stop;
});
