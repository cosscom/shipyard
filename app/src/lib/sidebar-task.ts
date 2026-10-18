// What a task row in the sidebar says in words: how long its agent has been
// as it is, and which boxes are up at its foot. Kept apart from the
// components so the rules can be tested on their own.

// shortAgo is a time as the sidebar's time lane says it: "now" under a
// minute, then minutes, hours and days ("4m", "1h", "2d"). An unknown or
// unreadable time says nothing; one in the future (a box's clock ahead of
// this computer's) says "now".
export function shortAgo(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// boxesLine is the sidebar foot's words for the boxes: the ones online by
// name ("devl, gpu online"), or how many when more than two are up, so the
// line never runs past the sidebar ("3 of 4 boxes online").
export function boxesLine(boxes: { name: string; online: boolean }[]): string {
  if (!boxes.length) return "No boxes yet";
  const up = boxes.filter((b) => b.online).map((b) => b.name);
  if (!up.length) return boxes.length === 1 ? `${boxes[0].name} is offline` : "No boxes online";
  if (up.length > 2) return `${up.length} of ${boxes.length} boxes online`;
  return `${up.join(", ")} online`;
}
