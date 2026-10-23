# @berth/plugin

Types for Shipyard plugins. A plugin is an ES module whose default export
receives a `BerthPluginContext`, registers what it adds, and may return a
cleanup function:

```tsx
import type { BerthPluginContext } from "@berth/plugin";
import { Button } from "@berth/plugin/ui";

export default function activate(berth: BerthPluginContext) {
  berth.addCommand({ id: "hello", title: "Say hello", run: () => berth.notify("Hello", "from a plugin") });
  berth.addScreen({ id: "hello", title: "Hello", Component: () => <Button>Hi</Button> });
  berth.addSidebarItem({ id: "hello", title: "Hello", icon: "Sparkles", screen: "hello" });
}
```

A screen opens under the app's header strip, which shows its `title` (and
`description`) the way the app's own views do. Render `<ViewHeader title
description actions />` from `@berth/plugin/ui` anywhere in the screen to put
a live description or buttons in that strip. The app lays a screen out as a
page, one width and left aligned like every other screen; pass `layout:
"fill"` to `addScreen` for a table or split view that fills the area and
scrolls itself. Use `<Frame variant="card">` for a section of a screen (one
outline, rows directly inside), and `sessionName(session, …)` from
`@berth/plugin` to name a session the way the app does.

Choices and filters use the app's controls so they mean the same thing
everywhere: `PickOne` for one of a few values (including a filter with an
"All" choice), `BoxFilter` for which boxes a screen covers (every box on to
start, unpress to hide), and `FilterChip` to narrow a list by labels or tags
(off to start, any number on). Tooltips are `<Tip label>`, never the HTML
`title` attribute; size list rows with `h-row` or `py-row-pad` so they follow
the Density setting.

Bundle it as ESM with `react`, `react/jsx-runtime`, `react-dom`,
`@berth/plugin` and `@berth/plugin/ui` left external: the app provides one
shared copy of each, so plugin components are ordinary React components in
the app's tree. Put the bundle and a `berth-plugin.json` in
`~/.berth/plugins/<id>/`:

```json
{ "id": "hello", "name": "Hello", "version": "0.1.0", "main": "dist/index.js" }
```

To give an agent a file (a pasted screenshot, a dropped log), upload it with
`berth.api.attach(box, { session } | { location, worktree }, file)` and put
the `path` it resolves with in the prompt, as the app's composer does. Pass
`{ pasted: true }` for a pasted screenshot so it shrinks first. Pasted text
that names files on this computer (`berth.api.localPaths(text)`) attaches
too: pass each path as `file`. Both came after the first SDK release, so
check `typeof berth.api.attach === "function"` before you offer them.

See `plugins/hello-ports` in the Shipyard repository for a complete example.
