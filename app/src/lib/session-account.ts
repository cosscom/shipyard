import type { SessionAccount } from "@berth/plugin";

import { agentLabel } from "./derive.ts";

// accountChip is what the chat's foot says about the account an agent runs
// on (its Claude Code config folder, its Codex home): its name, and the
// folder for the tooltip. Nothing on a box with one account for the agent,
// where there is nothing to tell apart, nor when the box doesn't say (an
// older box, or one that can't tell). A session on another folder than the
// default always shows it: there are two then, even if the box lists one.
export function accountChip(account: SessionAccount | undefined): { label: string; tip: string } | undefined {
  if (!account?.name) return undefined;
  if (account.count <= 1 && account.name === "default") return undefined;
  return { label: account.name, tip: `${agentLabel(account.agent)} account in ${account.dir}` };
}
