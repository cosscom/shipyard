import { agentOf, sessionState } from "@/lib/derive";
import { useStore } from "@/lib/store";

// boxLoad is how busy a box is, for choosing where new work goes: memory in
// use and agents working there. "59% mem · 2 agents". With cpu, its load
// over its cores leads: "31% CPU · 59% mem · 2 agents", as the sidebar
// foot's tip says it.
export function boxLoad(box: string, { cpu = false }: { cpu?: boolean } = {}): string {
  const d = useStore.getState().boxes[box];
  const mem = d?.stats?.memory;
  const load = d?.stats?.load?.[0];
  const cores = d?.stats?.cpus;
  const agents = (d?.sessions ?? []).filter((s) => agentOf(s) && !s.exited && ["running", "waiting"].includes(sessionState(s, d?.stats))).length;
  const parts = [
    cpu && load !== undefined && cores ? `${Math.round((load / cores) * 100)}% CPU` : "",
    mem?.total ? `${Math.round((mem.used / mem.total) * 100)}% mem` : "",
    agents ? `${agents} ${agents === 1 ? "agent" : "agents"}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}
