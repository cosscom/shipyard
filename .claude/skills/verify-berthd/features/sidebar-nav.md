# Sidebar places

The top of the sidebar lists the app's places (Home, Review, Worktrees, Automations, Kits, the Agent Dashboard under Labs) and every plugin's sidebar items. The person arranges them into Pinned, More and Hidden. The folded rail and zen's switcher list the same places from the same model (`app/src/components/sidebar/nav.tsx`).

## Sub-features

- `nav-pinned`: pinned places as rows, in the stored order.
- `nav-more`: More, one row and a menu of the rest; highlighted, naming the place, while you're on one of its places.
- `nav-customize`: the Customize sidebar sheet (drag, or Pin / Move to More / Hide buttons, Reset to default); right-click a row for the same.
- `nav-counts`: a count on a row. Home shows agents waiting for you (amber), Review shows what's to review (quiet), and a plugin's sidebar item shows its `useCount` (amber, or quiet with `urgent: false`; none for 0, undefined or a hook that throws). An amber count under More also shows on More's row.

## How to get to it (user POV)

- Look at the sidebar's top section; click a row to open its place.
- Click **More** for the rest; **Customize sidebar…** at the bottom of that menu.
- Right-click a pinned row for Pin / Move to More / Hide / Move up / Move down.

## Driving it with drive.mjs

- `node .claude/skills/verify-berthd/scripts/drive.mjs plugin-nav-badges --port $PORT` loads a test plugin with five sidebar items (counts 3, quiet 2, 4 from `useStorage`, 0, and one that throws). It checks More's row shows 3, the More menu shows `Waiting3`, `Quiet2`, `Stored4` and no count on Zero or Boom, pins four of them through Customize, then checks the rows: Waiting `3` amber (`text-warning-foreground`), Quiet `2` not amber, Zero and Boom no `nav-badge`, More's row now `4`, Home's own badge still there, and Waiting still opens its screen (`aria-current="page"`).
- Hooks: `nav-<id>` on each row's button (`nav-home`, `nav-review`, `nav-plugin:<plugin>:<item>`), `nav-more` on More's button, `nav-badge` on a row's count. A row's count is `page.locator("li", { has: page.getByTestId("nav-<id>") }).getByTestId("nav-badge")`.
- Pin through the sheet: `getByRole("dialog", { name: "Customize sidebar" })`, then the `li` holding the label's exact text, its `Pin` button.

## Gotchas

- New places, a plugin's included, land under More until pinned, so a plugin's count first shows on More's row, and only the first amber one.
- While you're on a place under More, More's row names it instead of showing a count.
- The mock saves the layout in memory only; a reload starts from the default.
- Counts in the More menu are plain text after the label: the menu item's text is `Waiting3`.
