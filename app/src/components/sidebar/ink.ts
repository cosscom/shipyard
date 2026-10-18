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
