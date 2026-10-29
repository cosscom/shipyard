import { router } from "expo-router";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";

import { agentOf, sessionState, type SessionState } from "@berth/core/derive.ts";

import { RunCard, SessionCard } from "@/components/cards";
import { Empty, Note, SectionTitle } from "@/components/ui";
import { runPath, sessionPath } from "@/lib/links";
import { useStore } from "@/lib/store";
import { useColors } from "@/lib/theme";
import type { Box, PhoneSession, Run } from "@/lib/types";

// Every paired box's agents, by what they need: Needs you first, then
// Working, Done, and those ready for a first prompt (folded away). Runs
// waiting at a gate are on top.

const GROUPS: [SessionState, string][] = [
  ["waiting", "Needs you"],
  ["running", "Working"],
  ["finished", "Done"],
  ["ready", "Ready"],
];

export default function NeedsYou() {
  const c = useColors();
  const boxes = useStore((s) => s.boxes);
  const data = useStore((s) => s.data);
  const demo = useStore((s) => s.demo);
  const [refreshing, setRefreshing] = useState(false);
  const [showReady, setShowReady] = useState(false);

  const agents: { s: PhoneSession; box: Box; state: SessionState }[] = [];
  const gated: { run: Run; box: Box }[] = [];
  for (const box of boxes) {
    for (const s of data[box.id]?.sessions ?? []) if (!s.exited && agentOf(s)) agents.push({ s, box, state: sessionState(s) });
    for (const run of data[box.id]?.runs ?? []) if (run.status === "waiting_gate") gated.push({ run, box });
  }
  const offline = boxes.filter((b) => data[b.id]?.error);
  const loading = boxes.some((b) => !data[b.id]?.sessions && !data[b.id]?.error);

  return (
    <ScrollView
      contentContainerStyle={st.page}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void useStore.getState().refreshAll().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {demo && <Note>This is the demo: made-up boxes and agents. Pair your own from Boxes.</Note>}
      {gated.length > 0 && (
        <>
          <SectionTitle state="waiting" title="Runs" count={gated.length} />
          {gated.map(({ run, box }) => (
            <RunCard key={box.id + run.id} run={run} box={box} onPress={() => router.push(runPath(box, run.id) as never)} />
          ))}
        </>
      )}
      {GROUPS.map(([state, title]) => {
        const items = agents.filter((a) => a.state === state).sort((a, b) => Date.parse(a.s.state_since || a.s.created) - Date.parse(b.s.state_since || b.s.created));
        if (!items.length) return null;
        if (state === "ready" && !showReady) {
          return (
            <Pressable key={state} onPress={() => setShowReady(true)} style={st.more} accessibilityRole="button">
              <Text style={{ color: c.muted, fontSize: 14 }}>{`${items.length} ready for a first prompt ›`}</Text>
            </Pressable>
          );
        }
        return [
          <SectionTitle key={state} state={state === "ready" ? "idle" : state} title={title} count={items.length} />,
          ...items.map(({ s, box }) => (
            <SessionCard key={box.id + s.name} s={s} box={box} tail={data[box.id]?.tails[s.name]} onPress={() => router.push(sessionPath(box, s.name) as never)} />
          )),
        ];
      })}
      {!agents.length && !gated.length && !loading && <Empty>No agents are running on your boxes.</Empty>}
      {offline.map((b) => (
        <Note key={b.id} bad>{`Can't reach ${b.name}: ${data[b.id]?.error}`}</Note>
      ))}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  more: { paddingVertical: 12, alignItems: "center" },
});
