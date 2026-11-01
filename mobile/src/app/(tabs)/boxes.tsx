import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, Dot, Note, SectionTitle } from "@/components/ui";
import { can } from "@/lib/api";
import { pushChoice, setPush, unregisterBox, type PushChoice } from "@/lib/push";
import { useStore } from "@/lib/store";
import { useColors } from "@/lib/theme";

// The boxes this phone is paired with, how each is reached, and the
// notifications they send it. Forgetting a box removes it from this phone
// only; turning phone access off is Shipyard's, on the laptop.

const CHOICES: [PushChoice, string][] = [
  ["off", "Off"],
  ["waiting", "Needs you"],
  ["waiting+finished", "Needs you and done"],
];

export default function Boxes() {
  const c = useColors();
  const boxes = useStore((s) => s.boxes);
  const data = useStore((s) => s.data);
  const demo = useStore((s) => s.demo);
  const [choice, setChoice] = useState<PushChoice>("off");
  const [busy, setBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string>();

  useEffect(() => {
    void pushChoice()
      .then(setChoice)
      .catch(() => undefined);
  }, []);

  const choose = async (next: PushChoice) => {
    if (demo) return setPushNote("The demo's boxes don't send notifications. Pair your own to get them.");
    setBusy(true);
    setPushNote(undefined);
    try {
      const { failed } = await setPush(
        next,
        boxes.map((box) => ({ box, info: data[box.id]?.info })),
      );
      setChoice(next);
      const older = boxes.filter((b) => next !== "off" && !can(data[b.id]?.info, "push"));
      const notes = [
        ...failed.map((f) => `${f.box.name}: ${f.error}`),
        ...older.map((b) => `${b.name} runs an older berthd that can't notify the app; update it from Shipyard.`),
      ];
      setPushNote(notes.join("\n") || undefined);
    } catch (err) {
      setPushNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const forget = (id: string) => {
    const box = boxes.find((b) => b.id === id);
    if (!box) return;
    Alert.alert(`Forget ${box.name}?`, "This phone stops showing its agents. To stop the box answering phones at all, turn phone access off in Shipyard.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () => {
          void unregisterBox(box, data[id]?.info).catch(() => undefined);
          void useStore.getState().forget(id);
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={st.page}>
      <SectionTitle title="Notifications" />
      <View style={[st.segments, { borderColor: c.line }]}>
        {CHOICES.map(([value, label]) => (
          <Pressable
            key={value}
            disabled={busy}
            onPress={() => void choose(value)}
            accessibilityRole="button"
            accessibilityState={{ selected: choice === value }}
            style={[st.segment, choice === value && { backgroundColor: c.accent }]}
          >
            <Text style={{ color: choice === value ? c.accentFg : c.fg, fontSize: 14, fontWeight: "600", textAlign: "center" }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Note>
        {pushNote ??
          "Boxes tell this phone when an agent or a run needs you: which worktree and box, never what the agent wrote. They send it through Shipyard's push relay, which keeps nothing."}
      </Note>

      <SectionTitle title={demo ? "Demo boxes" : "Paired boxes"} count={boxes.length} />
      {boxes.map((b) => {
        const d = data[b.id];
        const state = demo
          ? "Made up for the demo"
          : d?.error
            ? "Can't reach it"
            : d?.live
              ? "Live"
              : d?.info && d.info.version < 2
                ? "Checking every few seconds (older berthd)"
                : "Connecting";
        return (
          <Card key={b.id}>
            <View style={st.row}>
              <Dot state={d?.error ? "exited" : d?.info ? "running" : "idle"} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.fg, fontSize: 16, fontWeight: "600" }}>{b.name}</Text>
                <Text style={{ color: c.muted, fontSize: 13 }} numberOfLines={2}>
                  {d?.error ?? state}
                </Text>
              </View>
              {!demo && <Button title="Forget" tone="ghost" onPress={() => forget(b.id)} />}
            </View>
          </Card>
        );
      })}
      {demo ? (
        <Button title="Leave the demo" onPress={() => (useStore.getState().endDemo(), router.replace("/pair"))} />
      ) : (
        <Button title="Pair another box" tone="ghost" onPress={() => router.push("/pair")} />
      )}
      <Note>To add a box, turn its phone access on in Shipyard → Settings → Phone and scan the code.</Note>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  segments: { flexDirection: "row", borderWidth: 1, borderRadius: 12, padding: 3, gap: 3 },
  segment: { flex: 1, minHeight: 40, borderRadius: 9, justifyContent: "center", paddingHorizontal: 6 },
});
