import { router } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet } from "react-native";

import { RunCard } from "@/components/cards";
import { Empty, SectionTitle } from "@/components/ui";
import { useStore } from "@/lib/store";
import { runPath } from "@/lib/links";
import { runDone, type Box, type Run } from "@/lib/types";

// Every box's runs: those waiting for you, those going, those done lately.
// The phone decides gates and cancels runs; it doesn't start them.

export default function Runs() {
  const boxes = useStore((s) => s.boxes);
  const data = useStore((s) => s.data);
  const [refreshing, setRefreshing] = useState(false);
  const all: { run: Run; box: Box }[] = [];
  for (const box of boxes) for (const run of data[box.id]?.runs ?? []) all.push({ run, box });
  const groups: [string, string, { run: Run; box: Box }[]][] = [
    ["waiting", "Waiting for you", all.filter((r) => r.run.status === "waiting_gate")],
    ["running", "Going", all.filter((r) => r.run.status !== "waiting_gate" && !runDone(r.run))],
    ["finished", "Done", all.filter((r) => runDone(r.run))],
  ];
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
      {groups.map(([state, title, items]) =>
        items.length
          ? [
              <SectionTitle key={state} state={state} title={title} count={items.length} />,
              ...items.map(({ run, box }) => <RunCard key={box.id + run.id} run={run} box={box} onPress={() => router.push(runPath(box, run.id) as never)} />),
            ]
          : null,
      )}
      {!all.length && <Empty>No runs on your boxes. Start one from Shipyard on your laptop.</Empty>}
    </ScrollView>
  );
}

const st = StyleSheet.create({ page: { padding: 16, gap: 10 } });
