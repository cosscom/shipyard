// liftToasts keeps the toast stack clear of a bar floating at the bottom of
// a page, such as the Dashboard's selection bar or the Worktrees bulk bar.
// Put it on the bar as its ref: while the bar is up, --berth-bar-lift says
// how far above the window's bottom edge the bar's top is (and a gap), and
// the toast viewport (App.tsx) starts no lower than that. The loops panel
// and the background-jobs tray do the same with --berth-loops-h and
// --berth-jobs-h.
const GAP = 12;

export function liftToasts(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return;
  const root = document.documentElement;
  const sync = () => root.style.setProperty("--berth-bar-lift", `${Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top + GAP))}px`);
  sync();
  const ro = new ResizeObserver(sync);
  ro.observe(el);
  window.addEventListener("resize", sync);
  return () => {
    ro.disconnect();
    window.removeEventListener("resize", sync);
    root.style.setProperty("--berth-bar-lift", "0px");
  };
}
