// How wide the sidebar is, dragged by its right edge (components/sidebar/
// resize-handle.tsx) and kept in prefs. Pure, so it is tested on its own
// (sidebar-width.test.ts).
//
// 200px is the narrowest that keeps a worktree row readable: its indent,
// leading icon and trailing glyphs take about 100px, leaving the name some
// 13 characters ("Fix the cart b…"), enough to tell worktrees apart, and
// room for the actions that fade in over a row's end without covering all
// of it. 304px, the default, leaves a task's title room beside its status and time. 420px fits a long display name
// with its worktree's own name beside it (about 50 characters); wider only
// adds empty space and takes it from the terminals. The widest is also held
// to 40% of the window, so a small window keeps its room for work.

export const SIDEBAR_MIN = 200;
export const SIDEBAR_DEFAULT = 304;
export const SIDEBAR_MAX = 420;
// The folded rail's width (app-sidebar.tsx Rail, w-19).
export const RAIL_WIDTH = 76;
// Dragged narrower than FOLD_AT the sidebar folds to the rail, as VS Code's
// does; dragged out of the rail past UNFOLD_AT it opens again. The gap
// between them keeps it from flickering at the edge.
export const FOLD_AT = 150;
export const UNFOLD_AT = 170;
// ← and → move it by STEP, with Shift by BIG_STEP.
export const STEP = 16;
export const BIG_STEP = 64;

// A window narrower than ROOMY_AT starts the sidebar at its old 240px, so
// the panes beside it keep their room; a roomier one at the default.
export const SIDEBAR_NARROW_DEFAULT = 240;
export const ROOMY_AT = 1200;

// defaultWidth is where the sidebar starts in a window this wide.
export function defaultWidth(windowWidth = Infinity): number {
  return windowWidth < ROOMY_AT ? SIDEBAR_NARROW_DEFAULT : SIDEBAR_DEFAULT;
}

// sidebarMax is the widest the sidebar may be in a window this wide: 420px,
// or 40% of the window when that is less, but never under the default.
export function sidebarMax(windowWidth = Infinity): number {
  return Math.max(SIDEBAR_DEFAULT, Math.min(SIDEBAR_MAX, Math.round(windowWidth * 0.4)));
}

// clampWidth holds a width between the narrowest and the widest; anything
// that isn't a width (a saved value from elsewhere) is the default.
export function clampWidth(w: unknown, windowWidth = Infinity): number {
  if (typeof w !== "number" || !Number.isFinite(w)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(sidebarMax(windowWidth), Math.max(SIDEBAR_MIN, w)));
}

// dragged is where a drag of the edge leaves the sidebar: the pointer's
// width (start + how far it moved) folds it, opens it, or sizes it, held
// between the narrowest and the widest.
export function dragged(proposed: number, folded: boolean, windowWidth = Infinity): { folded: boolean; width: number } {
  if (folded ? proposed < UNFOLD_AT : proposed < FOLD_AT) return { folded: true, width: clampWidth(proposed, windowWidth) };
  return { folded: false, width: clampWidth(proposed, windowWidth) };
}

// stepped is the width after a key on the focused edge, or undefined for a
// key that doesn't size it.
export function stepped(width: number, key: string, shift: boolean, windowWidth = Infinity): number | undefined {
  const by = shift ? BIG_STEP : STEP;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width - by, windowWidth);
    case "ArrowRight":
      return clampWidth(width + by, windowWidth);
    case "Home":
      return SIDEBAR_MIN;
    case "End":
      return sidebarMax(windowWidth);
    default:
      return undefined;
  }
}

// The two-column sidebar (components/sidebar/columns.tsx): its projects
// column is a fixed PROJECTS_COLUMN wide, enough for a project's name and
// its mark; the tasks column beside it is dragged by its own edge, like
// the sidebar's. 200px keeps a task row readable, as above, and 272px
// leaves a title room beside its status and time. Both columns together
// stay within 40% of the window, so the panes keep their room (at 1200px
// that is 480px, leaving the main area 720px), but the tasks column never
// goes under its narrowest. Dragged narrower than TASKS_FOLD_AT it folds
// away, and comes back from the projects column.
export const PROJECTS_COLUMN = 220;
export const TASKS_MIN = 200;
export const TASKS_DEFAULT = 272;
export const TASKS_MAX = 380;
export const TASKS_FOLD_AT = 140;

// tasksMax is the widest the tasks column may be in a window this wide.
export function tasksMax(windowWidth = Infinity): number {
  return Math.max(TASKS_MIN, Math.min(TASKS_MAX, Math.round(windowWidth * 0.4) - PROJECTS_COLUMN));
}

// clampTasks holds the tasks column between its narrowest and widest;
// anything that isn't a width is the default.
export function clampTasks(w: unknown, windowWidth = Infinity): number {
  if (typeof w !== "number" || !Number.isFinite(w)) return TASKS_DEFAULT;
  return Math.round(Math.min(tasksMax(windowWidth), Math.max(TASKS_MIN, w)));
}

// draggedTasks is where a drag of the tasks column's edge leaves it.
export function draggedTasks(proposed: number, windowWidth = Infinity): { folded: boolean; width: number } {
  return { folded: proposed < TASKS_FOLD_AT, width: clampTasks(proposed, windowWidth) };
}

// steppedTasks is the tasks column's width after a key on its focused
// edge, or undefined for a key that doesn't size it.
export function steppedTasks(width: number, key: string, shift: boolean, windowWidth = Infinity): number | undefined {
  const by = shift ? BIG_STEP : STEP;
  switch (key) {
    case "ArrowLeft":
      return clampTasks(width - by, windowWidth);
    case "ArrowRight":
      return clampTasks(width + by, windowWidth);
    case "Home":
      return TASKS_MIN;
    case "End":
      return tasksMax(windowWidth);
    default:
      return undefined;
  }
}
