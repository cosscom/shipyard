import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { since } from "@/components/cards";
import { Button, Card, Chip, Empty, Label, Note } from "@/components/ui";
import { phone } from "@/lib/api";
import { useStore } from "@/lib/store";
import { mono, useColors } from "@/lib/theme";
import { runDone, type Run, type RunStep } from "@/lib/types";

// One run: the gate it waits at (approve, reject, or pick an attempt), its
// steps in outline, and cancelling it. The box keeps its variables, prompts
// and outputs to itself; the phone sees each step's first line.

export default function RunScreen() {
  const c = useColors();
  const params = useLocalSearchParams<{ box: string; run: string }>();
  const id = decodeURIComponent(params.box);
  const runId = decodeURIComponent(params.run);
  const box = useStore((s) => s.boxes.find((b) => b.id === id));
  // The box's list changes on every run event: read the run again then.
  const summary = useStore((s) => s.data[id]?.runs?.find((r) => r.id === runId));
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const read = useCallback(() => {
    if (!box) return;
    phone
      .run(box, runId)
      .then((r) => (setRun(r), setError(undefined)))
      .catch((err) => setError((err as Error).message));
  }, [box, runId]);
  useEffect(() => {
    read();
    const t = setInterval(read, 5000);
    return () => clearInterval(t);
  }, [read, summary?.status, summary?.cursor]);

  if (!box) return <Empty>This phone isn't paired with that box.</Empty>;
  if (!run) return <View style={{ padding: 16 }}>{error ? <Note bad>{error}</Note> : <Note>Reading the run…</Note>}</View>;

  const decide = async (what: string, call: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await call();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      read();
      void useStore.getState().refresh(id, { runs: true });
    } catch (err) {
      Alert.alert("That didn't go through", (err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const cancel = () =>
    Alert.alert("Cancel this run?", "Its agents stop where they are.", [
      { text: "Keep it", style: "cancel" },
      { text: "Cancel run", style: "destructive", onPress: () => void decide("cancel", () => phone.cancel(box, runId)) },
    ]);

  const steps: { step: RunStep; depth: number }[] = [];
  const walk = (list: RunStep[] | undefined, depth: number) => {
    for (const s of list ?? []) {
      if (s.status === "skipped") continue;
      steps.push({ step: s, depth });
      walk(s.children, depth + 1);
    }
  };
  walk(run.steps, 0);

  return (
    <ScrollView contentContainerStyle={st.page}>
      <Stack.Screen options={{ title: run.title || run.template }} />
      <Note>{[run.template, box.name, since(run.created)].filter(Boolean).join(" · ")}</Note>
      {run.gate && (
        <Card state="waiting" style={{ gap: 10 }}>
          <Label size={17} weight="600">
            {run.gate.title}
          </Label>
          {!!run.gate.text && <Text style={{ color: c.muted, fontFamily: mono, fontSize: 12, lineHeight: 17 }}>{run.gate.text}</Text>}
          {run.gate.pick && run.candidates?.length ? (
            <>
              {run.candidates.map((cand) => (
                <Chip
                  key={cand.index}
                  k={String(cand.index + 1)}
                  disabled={!!busy}
                  label={`${cand.agent} · +${cand.diff.added} −${cand.diff.removed} · check ${cand.verify.passed ? "passed" : "failed"}${cand.judge?.rank === 1 ? " · judge's pick" : ""}`}
                  onPress={() => void decide("pick", () => phone.decide(box, runId, true, cand.index))}
                />
              ))}
              <Button title="Reject all" tone="danger" busy={busy === "reject"} onPress={() => void decide("reject", () => phone.decide(box, runId, false))} />
            </>
          ) : (
            <View style={st.row}>
              <Button title="Approve" busy={busy === "approve"} onPress={() => void decide("approve", () => phone.decide(box, runId, true))} style={{ flex: 1 }} />
              <Button title="Reject" tone="danger" busy={busy === "reject"} onPress={() => void decide("reject", () => phone.decide(box, runId, false))} style={{ flex: 1 }} />
            </View>
          )}
        </Card>
      )}
      <View style={{ gap: 6 }}>
        {steps.map(({ step, depth }, i) => (
          <View key={i} style={{ marginLeft: depth * 14, flexDirection: "row", gap: 8 }}>
            <Text style={{ color: step.status === "failed" ? c.bad : step.status === "succeeded" ? c.done : c.muted, fontFamily: mono, fontSize: 13 }}>
              {step.status === "succeeded" ? "✓" : step.status === "failed" ? "✕" : "·"}
            </Text>
            <Text style={{ color: c.fg, fontSize: 14, flex: 1 }}>
              <Text style={{ fontWeight: "600" }}>{step.kind || step.id}</Text>
              <Text style={{ color: c.muted }}>{` ${step.output || step.error || step.status || ""}`}</Text>
            </Text>
          </View>
        ))}
      </View>
      {!!run.error && <Note bad>{run.error}</Note>}
      {!runDone(run) && <Button title="Cancel run" tone="ghost" busy={busy === "cancel"} onPress={cancel} />}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  row: { flexDirection: "row", gap: 10 },
});
