// One ink. The sidebar's text and icons are one grey family at a few
// strengths, so the list reads as one quiet column and colour is left to
// say the two things worth saying: amber, an agent needs you; blue, one is
// working. The strengths run from the theme's foreground down to its muted
// text, which every theme tunes to stay readable as small text (4.5:1;
// check:themes), so the faintest step reads in all of them; a plain
// foreground at low opacity doesn't, in half the built-in themes. Only
// icons go fainter than that. inkScale sets the steps on the sidebar, its
// rail and Settings' nav; ink names them.
export const inkScale = [
  "[--ink-row:color-mix(in_oklab,var(--foreground)_40%,var(--muted-foreground))]",
  "[--ink-quiet:color-mix(in_oklab,var(--foreground)_10%,var(--muted-foreground))]",
  "[--ink-faint:var(--muted-foreground)]",
  "[--ink-glyph:color-mix(in_oklab,var(--muted-foreground)_75%,transparent)]",
].join(" ");
export const ink = {
  // The row you have open, and a title whose agent needs you.
  strong: "text-foreground",
  // An ordinary row: a place, a task at work.
  row: "text-(color:--ink-row)",
  // A task that is idle or done.
  quiet: "text-(color:--ink-quiet)",
  // Project and section labels, times and small notes.
  faint: "text-(color:--ink-faint)",
  // Icons and glyphs beside text.
  glyph: "text-(color:--ink-glyph)",
};

// fade is a sidebar list's (RowLayer's) edges. While rows are scrolled out
// of sight above or below, the band at that edge (--more-above/below, up to
// 2.75rem, set by RowLayer from how far there is to scroll) is clear for
// nearly its first half (about 20px) and eases in, faint for most of the
// rest, so a row cut by the
// edge can't be read under the places above or against the foot. The band
// grows with the first bit of scrolling, so nothing jumps when it starts.
// Each edge is its own mask layer, intersected; at the top or the end of
// the list there is no mask at all.
export const fade = [
  "[--fade-t:linear-gradient(#000,#000)] [--fade-b:linear-gradient(#000,#000)] [mask-composite:intersect]",
  "data-more-above:[--fade-t:linear-gradient(to_bottom,transparent_calc(var(--more-above)*0.45),rgb(0_0_0/0.04)_calc(var(--more-above)*0.62),rgb(0_0_0/0.25)_calc(var(--more-above)*0.8),#000_var(--more-above))]",
  "data-more-below:[--fade-b:linear-gradient(to_top,transparent_calc(var(--more-below)*0.45),rgb(0_0_0/0.04)_calc(var(--more-below)*0.62),rgb(0_0_0/0.25)_calc(var(--more-below)*0.8),#000_var(--more-below))]",
  "data-more-above:[mask-image:var(--fade-t),var(--fade-b)] data-more-below:[mask-image:var(--fade-t),var(--fade-b)]",
].join(" ");
