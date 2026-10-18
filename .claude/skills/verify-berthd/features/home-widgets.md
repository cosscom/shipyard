# Home widgets

Home (with Labs) is a composer over a grid of widgets the person arranges: Needs you, Working now, Recent areas, a plugin's (Pull requests), and more from the **Add widget** picker. Each card's heading has its count (`useCount`; amber when urgent).

## Sub-features

- `home-default`: a new person gets the default widgets; nothing is saved until they customise.
- `home-customize`: add (picker), resize, move and remove; Reset brings the default back; the layout is kept in `berth.prefs` across a reload.
- `home-counts`: a widget's count in its heading.

## How to get to it (user POV)

- Click **Home**; scroll under the composer. **Customize** (`home-customize`) edits the grid.

## Driving it with drive.mjs

- No scenario yet. `app/e2e/home-widgets.spec.ts` asserts these paths; for evidence, write a scenario that opens Home (`nav-home`), and shoots `getByTestId("home-grid")`. Widgets are `[data-widget="<id>"]` (a plugin's is `<plugin>/<id>`) with `data-size`.

## Gotchas

- Without Labs (`prefs.labs: false`), Home is the Agent Dashboard and there is no grid.
- A widget fetches only while visible; a shot taken before its data arrives shows its skeleton.
