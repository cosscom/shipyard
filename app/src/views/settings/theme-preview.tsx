import type { Theme } from "@/lib/api";

// A theme card's picture: the theme's sidebar and terminal drawn small, in
// the theme's own colours. Its text is part of the drawing (a terminal in
// miniature), so it is sized to the card rather than by the type scale.

// Preview draws a theme's sidebar beside its terminal, in its own colors.
export function Preview({ theme }: { theme: Theme }) {
  const c = theme.colors;
  const t = theme.terminal;
  return (
    <div className="flex h-full" style={{ background: c.background }}>
      <div className="flex w-[38%] flex-col gap-1.5 border-r px-2.5 py-2.5" style={{ background: c.sidebar, borderColor: c.border }}>
        <div className="h-1.5 w-4/5 rounded-full" style={{ background: c.sidebarForeground, opacity: 0.55 }} />
        <div className="h-1.5 w-3/5 rounded-full" style={{ background: c.sidebarForeground, opacity: 0.3 }} />
        <div className="flex items-center gap-1">
          <span className="size-1.5 rounded-full" style={{ background: c.warning }} />
          <div className="h-1.5 flex-1 rounded-full" style={{ background: c.accent }} />
        </div>
        <div className="h-1.5 w-2/3 rounded-full" style={{ background: c.sidebarForeground, opacity: 0.3 }} />
      </div>
      <div className="flex-1 px-2.5 py-2 font-mono text-[10px] leading-[1.35]" style={{ background: t.background, color: t.foreground }}>
        <div>
          <span style={{ color: t.green }}>●</span> tests pass
        </div>
        <div>
          <span style={{ color: t.yellow }}>●</span> <span style={{ color: t.blue }}>~/work/shop</span>
        </div>
        <div>
          <span style={{ color: t.magenta }}>❯</span> <span style={{ color: t.cyan }}>berth</span>
          <span className="ml-0.5 inline-block h-2.5 w-1 align-middle" style={{ background: t.cursor }} />
        </div>
      </div>
    </div>
  );
}

// Dots are a theme's colours at a glance, in the corner of its preview: its
// primary, then the terminal's red, yellow, green, blue and magenta.
export function Dots({ theme }: { theme: Theme }) {
  const t = theme.terminal;
  return (
    <span className="absolute right-2 bottom-2 flex items-center gap-[3px] rounded-full border px-1.5 py-1" style={{ background: theme.colors.background, borderColor: theme.colors.border }} aria-hidden>
      {[theme.colors.primary, t.red, t.yellow, t.green, t.blue, t.magenta].map((c, i) => (
        <span key={i} className="size-2 rounded-full" style={{ background: c }} />
      ))}
    </span>
  );
}
