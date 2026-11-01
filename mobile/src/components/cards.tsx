import { StyleSheet, Text, View } from "react-native";

import { ago } from "@berth/core/format.ts";
import { agentLabel, sessionState } from "@berth/core/derive.ts";

import { mono, useColors } from "@/lib/theme";
import type { Box, PhoneSession, Run } from "@/lib/types";

import { Card, Lines, Pill } from "./ui";

// Where a session works: its worktree by its display name when it has one,
// and its project.
export function whereOf(s: PhoneSession): { worktree: string; project: string } {
  const [loc, wt] = String(s.location ?? "").split("/");
  return { worktree: s.worktree_title || s.title || wt || loc || s.name, project: loc ?? "" };
}

// A short "3m"-style age (lib/format's ago, without "ago").
export const since = (iso?: string) => (iso ? ago(iso).replace(/ ago$/, "") : "");

export function SessionCard({ s, box, tail, onPress }: { s: PhoneSession; box: Box; tail?: string[]; onPress: () => void }) {
  const c = useColors();
  const w = whereOf(s);
  const state = sessionState(s);
  const asked = s.agent_state === "waiting" && s.ask ? [s.ask.message || [s.ask.tool, s.ask.input].filter(Boolean).join(" ")].filter(Boolean) : [];
  return (
    <Card state={state} onPress={onPress}>
      <View style={st.top}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.fg, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
            {w.worktree}
          </Text>
          <Text style={{ color: c.muted, fontSize: 13 }} numberOfLines={1}>
            {[s.agent ? agentLabel(s.agent) : "Shell", w.project, box.name].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <Pill state={state} />
          <Text style={{ color: c.muted, fontSize: 12, fontFamily: mono }}>{since(s.state_since || s.created)}</Text>
        </View>
      </View>
      <Lines lines={asked.length ? asked : (tail ?? [])} c={c} />
    </Card>
  );
}

export function RunCard({ run, box, onPress }: { run: Run; box: Box; onPress: () => void }) {
  const c = useColors();
  const waiting = run.status === "waiting_gate";
  const what = run.gate ? `Waiting for you: ${run.gate.title}` : run.status === "queued" ? "Queued" : run.status === "running" ? `Running ${run.cursor ?? ""}`.trim() : run.status;
  return (
    <Card state={waiting ? "waiting" : "running"} onPress={onPress}>
      <View style={st.top}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.fg, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
            {run.title || run.template}
          </Text>
          <Text style={{ color: c.muted, fontSize: 13 }} numberOfLines={1}>
            {[run.template, box.name].join(" · ")}
          </Text>
        </View>
        <Text style={{ color: c.muted, fontSize: 12, fontFamily: mono }}>{since(run.created)}</Text>
      </View>
      <Lines lines={[what]} c={c} />
    </Card>
  );
}

const st = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
});
