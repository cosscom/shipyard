import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Alert, AppState } from "react-native";

import { parsePairing } from "@berth/core/pairing.ts";

import { noticeKey, routeFor } from "@/lib/links";
import { forgetPushKey, syncPush } from "@/lib/push";
import { startFeeds, useStore } from "@/lib/store";
import { useColors } from "@/lib/theme";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

// A notice's own fields: the relay puts them under "berth", beside "aps".
function noticeData(n: Notifications.Notification): unknown {
  const data = n.request.content.data as Record<string, unknown> | undefined;
  const payload = (n.request.trigger as { payload?: Record<string, unknown> } | null)?.payload;
  return data?.berth ?? payload?.berth ?? data;
}

// While its session is on screen, a notice about it isn't shown again.
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const key = noticeKey(noticeData(n));
    const shown = !!key && key === useStore.getState().showing;
    return { shouldShowBanner: !shown, shouldShowList: true, shouldPlaySound: !shown, shouldSetBadge: false };
  },
});

const pushTargets = () => {
  const { boxes, data, demo } = useStore.getState();
  return demo ? [] : boxes.map((box) => ({ box, info: data[box.id]?.info }));
};

export default function Layout() {
  const c = useColors();
  const ready = useStore((s) => s.ready);

  useEffect(() => {
    void useStore.getState().load();
  }, []);

  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync().catch(() => undefined);

    // Pairing links: berth://pair#…, or the desktop's own link opened here.
    const pairFrom = async (url: string | null) => {
      const list = url ? parsePairing(url) : undefined;
      if (!list) return;
      const added = await useStore.getState().pair(list);
      Alert.alert("Paired", added.length === 1 ? `This phone is paired with ${added[0].name}.` : `This phone is paired with ${added.length} boxes.`);
      router.replace("/");
    };
    void Linking.getInitialURL().then(pairFrom);
    const links = Linking.addEventListener("url", (e) => void pairFrom(e.url));

    // A tapped notification opens its session or run, also from a cold start.
    const open = (r: Notifications.NotificationResponse | null) => {
      if (r) router.push(routeFor(noticeData(r.notification), useStore.getState().boxes) as never);
    };
    void Notifications.getLastNotificationResponseAsync().then(open);
    const taps = Notifications.addNotificationResponseReceivedListener(open);
    // A new device token needs a new key from the relay, at every box.
    const tokens = Notifications.addPushTokenListener(() => void forgetPushKey().then(() => syncPush(pushTargets())));

    // Every box stays current while the app is open; push covers the rest.
    let stop: (() => void) | undefined = startFeeds();
    const appState = AppState.addEventListener("change", (s) => {
      if (s === "active" && !stop) {
        stop = startFeeds();
        // What it said while away is old news once it's seen.
        void Notifications.dismissAllNotificationsAsync().catch(() => undefined);
      } else if (s === "background" && stop) {
        stop();
        stop = undefined;
      }
    });
    // Register with boxes once they've said what they offer.
    const registered = setTimeout(() => void syncPush(pushTargets()), 3000);

    return () => {
      links.remove();
      taps.remove();
      tokens.remove();
      appState.remove();
      clearTimeout(registered);
      stop?.();
    };
  }, [ready]);

  if (!ready) return null;
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.bg },
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Pair", presentation: "modal" }} />
        <Stack.Screen name="s/[box]/[session]" options={{ title: "" }} />
        <Stack.Screen name="r/[box]/[run]" options={{ title: "" }} />
      </Stack>
    </>
  );
}
