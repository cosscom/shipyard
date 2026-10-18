// Which project the two-column sidebar's tasks column shows
// (components/sidebar/columns.tsx). Pure, so it is tested on its own
// (sidebar-columns.test.ts).
//
// The one picked last wins: a click on a project in the first column picks
// it, and so does opening a worktree (the pick becomes that worktree's
// project; components/sidebar/columns.tsx). A pick that is gone (the
// project was removed, or Group by changed what a key names) gives way to
// the project of the worktree in front, then to the first project listed.
export function pickedColumn(order: readonly string[], pick: string | null | undefined, inFront: string | undefined): string | undefined {
  if (pick && order.includes(pick)) return pick;
  if (inFront && order.includes(inFront)) return inFront;
  return order[0];
}

// nextRow is the row ↑ or ↓ moves focus to in a list of rows, or undefined
// at either end (the list doesn't wrap, as a menu would).
export function nextRow(count: number, at: number, key: string): number | undefined {
  if (!count) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return at < 0 ? 0 : at + 1 < count ? at + 1 : undefined;
  if (key === "ArrowUp") return at < 0 ? count - 1 : at > 0 ? at - 1 : undefined;
  return undefined;
}
