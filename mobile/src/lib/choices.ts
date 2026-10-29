import { choicesIn, permissionChoices, type Choice } from "@berth/core/screen.ts";

import type { PhoneSession } from "./types";

// The answers a waiting agent offers, as chips: what its hooks said it
// asks (a structured session has no screen to read), else the numbered
// options on its screen, else yes or no when the screen asks that. A
// permission menu reads as Allow / Always allow / Deny, keeping each
// option's own number.
export function answerChoices(s: PhoneSession | undefined, screen: string | undefined): Choice[] {
  if (!s || s.exited || (s.agent_state !== "waiting" && s.agent_state !== "idle")) return [];
  // Turn check's wait asks in the agent's last message: the reply answers.
  if (s.soft_wait) return [];
  const asked = s.ask?.choices ?? [];
  const options = asked.length ? asked : screen ? choicesIn(screen) : [];
  if (options.length) return permissionChoices(options) ?? options;
  const tail = (screen ?? "").split("\n").slice(-30).join("\n");
  if (/\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]/.test(tail)) {
    return [
      { key: "y", label: "Yes" },
      { key: "n", label: "No" },
    ];
  }
  return [];
}
