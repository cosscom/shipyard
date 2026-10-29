import { Redirect, Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";

import { sessionState } from "@berth/core/derive.ts";

import { useStore } from "@/lib/store";
import { useColors } from "@/lib/theme";

// Needs you, Runs and Boxes. With no box paired (and no demo), pairing
// comes first.

const glyph = (g: string) =>
  function Icon({ color }: { color: ColorValue }) {
    return <Text style={{ color, fontSize: 18 }}>{g}</Text>;
  };

export default function TabsLayout() {
  const c = useColors();
  const boxes = useStore((s) => s.boxes);
  const waiting = useStore((s) =>
    Object.values(s.data).reduce(
      (n, d) => n + (d.sessions ?? []).filter((x) => !x.exited && x.agent && sessionState(x) === "waiting").length + (d.runs ?? []).filter((r) => r.status === "waiting_gate").length,
      0,
    ),
  );
  if (!boxes.length) return <Redirect href="/pair" />;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.fg,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: c.bg },
        tabBarStyle: { backgroundColor: c.bg, borderTopColor: c.line },
        tabBarActiveTintColor: c.fg,
        tabBarInactiveTintColor: c.muted,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Needs you", headerTitle: "Shipyard", tabBarIcon: glyph("●"), tabBarBadge: waiting || undefined, tabBarBadgeStyle: { backgroundColor: c.waiting } }}
      />
      <Tabs.Screen name="runs" options={{ title: "Runs", tabBarIcon: glyph("▸") }} />
      <Tabs.Screen name="boxes" options={{ title: "Boxes", tabBarIcon: glyph("▤") }} />
    </Tabs>
  );
}
