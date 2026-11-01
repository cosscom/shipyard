import type { Box } from "./types";

// Where a notification, or a link into the app, opens.

export interface NoticeData {
  box?: string;
  kind?: string;
  session?: string;
  run?: string;
}

export const sessionPath = (box: Box, s: string) => `/s/${encodeURIComponent(box.id)}/${encodeURIComponent(s)}`;
export const runPath = (box: Box, id: string) => `/r/${encodeURIComponent(box.id)}/${encodeURIComponent(id)}`;

// routeFor is the screen a notification opens: its session or run, on the
// box it came from (by the box's name, which is what the relay carries), or
// the list when the box isn't paired here.
export function routeFor(data: unknown, boxes: Box[]): string {
  const d = (data && typeof data === "object" ? ((data as { berth?: NoticeData }).berth ?? data) : {}) as NoticeData;
  const box = boxes.find((b) => b.name === d.box) ?? (boxes.length === 1 ? boxes[0] : undefined);
  if (!box) return "/";
  if (d.kind === "run" && d.run) return runPath(box, d.run);
  if (d.session) return sessionPath(box, d.session);
  return "/";
}

// noticeKey says which session a notification is about, to leave it
// unshown while that session is on screen.
export function noticeKey(data: unknown): string | undefined {
  const d = (data && typeof data === "object" ? ((data as { berth?: NoticeData }).berth ?? data) : {}) as NoticeData;
  if (d.kind === "run" && d.run) return `${d.box}/run/${d.run}`;
  if (d.session) return `${d.box}/${d.session}`;
  return undefined;
}
