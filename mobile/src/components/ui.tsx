import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

import { AGENT_WORDS, agentStatus } from "@berth/core/state.ts";
import type { SessionState } from "@berth/core/derive.ts";

import { mono, stateColor, useColors, type Colors } from "@/lib/theme";

// The app's few parts, in the web phone app's look: one column, big
// targets, quiet greys, amber only for what needs you.

export const tap = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);

export function Label({ children, style, muted, mono: isMono, size = 16, weight }: { children: ReactNode; style?: StyleProp<TextStyle>; muted?: boolean; mono?: boolean; size?: number; weight?: TextStyle["fontWeight"] }) {
  const c = useColors();
  return <Text style={[{ color: muted ? c.muted : c.fg, fontSize: size, fontWeight: weight, fontFamily: isMono ? mono : undefined }, style]}>{children}</Text>;
}

export function Card({ children, onPress, state, style }: { children: ReactNode; onPress?: () => void; state?: string; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const box = [s.card, { backgroundColor: c.panel, borderColor: state === "waiting" ? c.waiting : c.line }, state === "waiting" && { borderLeftWidth: 4 }, style];
  if (!onPress) return <View style={box}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [box, pressed && { opacity: 0.7 }]} accessibilityRole="button">
      {children}
    </Pressable>
  );
}

type Tone = "primary" | "ghost" | "danger";

export function Button({ title, onPress, tone = "primary", busy, disabled, style }: { title: string; onPress: () => void; tone?: Tone; busy?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const colors: Record<Tone, { bg: string; fg: string; border: string }> = {
    primary: { bg: c.accent, fg: c.accentFg, border: c.accent },
    ghost: { bg: "transparent", fg: c.fg, border: c.line },
    danger: { bg: "transparent", fg: c.bad, border: c.line },
  };
  const t = colors[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={() => (tap(), onPress())}
      style={({ pressed }) => [s.button, { backgroundColor: t.bg, borderColor: t.border, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 }, style]}
    >
      {busy ? <ActivityIndicator color={t.fg} /> : <Text style={{ color: t.fg, fontSize: 16, fontWeight: "600" }}>{title}</Text>}
    </Pressable>
  );
}

// Chip is one answer: its key, and what it says.
export function Chip({ k, label, onPress, disabled }: { k: string; label: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => (tap(), onPress())}
      style={({ pressed }) => [s.chip, { backgroundColor: c.panel, borderColor: c.waiting, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}
    >
      <Text style={[s.chipKey, { color: c.waiting, backgroundColor: c.waitingBg }]}>{k}</Text>
      <Text style={{ color: c.fg, fontSize: 15, flexShrink: 1 }} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Dot({ state }: { state?: string }) {
  const c = useColors();
  return <View style={[s.dot, { backgroundColor: stateColor(c, state) }]} />;
}

// Pill says an agent's state in the app's words.
export function Pill({ state }: { state: SessionState }) {
  const c = useColors();
  const a = agentStatus(state);
  const color = stateColor(c, state === "ready" ? "idle" : state);
  return (
    <View style={[s.pill, { borderColor: color }]}>
      <Dot state={state === "ready" ? "idle" : state} />
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{a ? AGENT_WORDS[a].lower : "shell"}</Text>
    </View>
  );
}

export function SectionTitle({ state, title, count }: { state?: string; title: string; count?: number }) {
  const c = useColors();
  return (
    <View style={s.section}>
      {state && <Dot state={state} />}
      <Text style={{ color: c.muted, fontSize: 13, fontWeight: "600" }}>{title}</Text>
      {count !== undefined && <Text style={{ color: c.muted, fontSize: 13 }}>{count}</Text>}
    </View>
  );
}

export function Note({ children, bad }: { children: ReactNode; bad?: boolean }) {
  const c = useColors();
  return <Text style={{ color: bad ? c.bad : c.muted, fontSize: 14, lineHeight: 20 }}>{children}</Text>;
}

export function Empty({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <View style={[s.empty, { borderColor: c.line }]}>
      <Text style={{ color: c.muted, fontSize: 15, textAlign: "center" }}>{children}</Text>
    </View>
  );
}

export function Lines({ lines, c }: { lines: string[]; c: Colors }) {
  if (!lines.length) return null;
  return (
    <Text style={{ color: c.muted, fontFamily: mono, fontSize: 12, lineHeight: 17, marginTop: 8 }} numberOfLines={3}>
      {lines.join("\n")}
    </Text>
  );
}

export const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 4 },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  chip: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1 },
  chipKey: { fontFamily: mono, fontWeight: "700", fontSize: 13, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: "hidden" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, alignSelf: "flex-start" },
  section: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8, marginBottom: 2, paddingHorizontal: 2 },
  empty: { borderWidth: 1, borderStyle: "dashed", borderRadius: 14, padding: 28 },
});
