# A worktree's saved tabs

A worktree's tabs are saved (`berth.workspaces` in local storage, `app/src/lib/workspaces.ts`) and come back on the next launch. Every session started in a worktree that is open gets a tab of its own (`reconcile`), and the tab stays after the session ends, so it can be started again. A worktree that every agent starts in, a repo's main checkout, collects hundreds of them.

## Sub-features

- `tabs-restore`: the tabs, their order, the active one and each pane's view (chat or terminal) are as they were left.
- `tabs-mount-when-shown`: a pane's content (its terminal, its chat) mounts the first time its tab shows, then stays mounted while the window is open, so going back to it is instant and its terminal keeps its screen and connection (`components/workspace/pane-layer.tsx`). A launch draws only the tab in front, however many are saved; a pane never shown is an empty box (`[data-testid="pane"]` with no children).

## How to get to it (user POV)

- Have many tabs in one worktree (a main checkout where agents are started), quit and launch again: the window draws at once and stays responsive.
- Click an old tab: it draws; click back: the first is as it was.

## Driving it with drive.mjs

- `node .claude/skills/verify-berthd/scripts/drive.mjs many-tabs-launch --port $PORT` seeds a save of `checkout-fix` with 300 tabs of ended sessions and its agent's tab in front (the scenario's `init`), then asserts one pane drawn at launch, two after opening "Old task 7", still two after going back. It logs the page's DOM nodes at launch and after.
- `app/e2e/many-tabs.spec.ts` asserts the same, and that the first pane's element is the same one when it shows again (not remounted).

## Gotchas

- Memory itself can't be read on the mock: the panes of ended sessions there draw little. On a real box with a save of ~650 tabs, before this the Mac app's window (WKWebView) reached 8–9 GB within a minute; Playwright's WebKit on Linux reproduced it (0.8 GB → 6.1 GB in 150 s, DOM nodes 22k → 59k and climbing); with it, ~1.0 GB and ~10k nodes, flat. That needs a person's save and a real box, so it stays out of the scenario.
- The tab strip still draws every tab: hundreds of them is a long strip.
