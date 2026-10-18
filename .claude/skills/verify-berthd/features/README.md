# Shipyard app verification map

The maintained list of what a person can do in the app, and how to prove each one with this skill. Read it before driving; use the matching file as the recipe. A change to a feature updates its file, and a scenario that proved it moves into `../scripts/scenarios/`, in the same PR.

## Baseline

- The production build served by `vite preview` on a free port in 1421-1439, opened at `/?mock=1` (see `../SKILL.md` Launch).
- `../scripts/doctor.sh $PORT` passes.
- The mock's fixtures as they ship: boxes `devl` and others, projects `shop` and `evals`, agents waiting and working. Nothing is seeded by hand.

## Features

| Feature | File | Scenario |
| --- | --- | --- |
| Sidebar places: Pinned, More, Hidden, counts on rows (Home's waiting, Review's, a plugin's) | [sidebar-nav.md](sidebar-nav.md) | `plugin-nav-badges` |
| Plugins: built-in and your own, what they add (screens, sidebar items, widgets, panels) | [plugins.md](plugins.md) | `plugin-nav-badges` (sidebar items) |
| Home's widget grid | [home-widgets.md](home-widgets.md) | none yet; `app/e2e/home-widgets.spec.ts` asserts it |

## Proof and skip reporting

- Every proof names the feature file and the scenario it ran, and attaches the screenshots from the evidence folder.
- Something the mock can't show (a real box, the Mac app's window and updater, a plugin's helper on a box) is reported as not verified here, with what would verify it.
