import type { SidebarItem } from "@berth/plugin";

// A sidebar place's badge: its count, loud (amber) for something waiting on
// the person, and the tip that says what it counts.
export interface NavBadge {
  count: number;
  loud?: boolean;
  title: string;
}

// readNavBadge calls a plugin sidebar item's useCount and turns what it
// returns into the item's badge. A count is loud like Home's unless the
// plugin says urgent: false; 0 or nothing is no badge. A hook that throws is
// no badge too, and the error goes to report, so one broken plugin never
// breaks the sidebar.
export function readNavBadge(title: string, use: NonNullable<SidebarItem["useCount"]>, report: (err: unknown) => void): NavBadge | undefined {
  let v: ReturnType<typeof use>;
  try {
    v = use();
  } catch (err) {
    report(err);
    return undefined;
  }
  const c = typeof v === "number" ? { n: v } : v;
  if (!c || !Number.isFinite(c.n) || c.n <= 0) return undefined;
  return { count: c.n, loud: c.urgent !== false, title: `${title}: ${c.n}` };
}
