# Archiving and removing a worktree

A worktree that is done goes one of two ways. **Archive…** asks first, then stops its sessions and services, runs the repo's archive script if it has one, and removes the folder; the branch stays. **Remove worktree** asks nothing and removes it; the branch stays too. Both go through one queue (`app/src/lib/remove-worktree.ts`): the worktree is marked at once (`lib/removing.ts`), and each box takes one removal at a time (`inTurn`), so archiving several in a row never waits on a dialog.

## Sub-features

- `archive-confirm`: the dialog names the worktree, its branch ("Branch … stays") and the archive script, if any. It closes as soon as Archive is pressed, before the box answers.
- `archive-mark`: from that moment the row is struck through and says **Archiving…** (`[data-leaving]`, `LeavingRow` in `components/sidebar/projects.tsx`); zen's switcher says the same, and the worktree's launcher says "Archiving NAME…". It can't be opened meanwhile.
- `archive-done`: without a script the box answers once the folder is gone, then a toast **Archived NAME** / "Branch … is kept." With a script the box answers at once: a toast **Archiving NAME** / "Its archive script is running on the box…", and **Archived NAME** when `worktree.removed` arrives.
- `archive-dirty`: uncommitted work makes git refuse. The worktree comes back as it was, with a warning toast **Couldn't archive NAME** / "NAME has uncommitted changes, so it was left as it is. Commit them first, or use Remove worktree to discard them."
- `archive-queue`: archives (and removals) on one box go one after another; each row keeps its mark until its turn is done. Another box's don't wait.
- `remove`: Remove worktree, the dashboard's Stop and remove worktree, and Delete in the Worktrees table: no dialog, **Removing…**, and a dirty one gives **Kept NAME** with **Remove anyway**.
- Bulk Archive in the Worktrees table (`views/worktrees/archive-dialog.tsx`) is separate: its dialog stays open on purpose, with each row's outcome, and runs one row after another across every box (`use-bulk.ts`).

## How to get to it (user POV)

- Right-click a worktree in the sidebar, or its ⋯: **Archive…** or **Remove worktree**. Zen's worktree menu has the same items.
- A worktree with no tabs shows its launcher: **Archive this worktree…**.
- Worktrees (sidebar): select rows, then **Archive N…** or **Delete** in the bar at the bottom.

## Driving it with drive.mjs

- `node .claude/skills/verify-berthd/scripts/drive.mjs worktree-archive --port $PORT` opens the mock with `slowremove=4000` (a box takes 4 s to remove a worktree with no archive script, as a big `node_modules` does) and the list sidebar. It archives `gpu/ci-flake` and fails if the dialog stays open over 1 s, checks its row says Archiving…, archives `gpu/judge-v2` straight after (both marked; judge-v2 waits its turn), waits for **Archived ci-flake** with "Branch me/ci-flake is kept." at about 4 s and **Archived judge-v2** at about 8 s, then archives `devl/qa-deck` (script `pnpm db:drop`: **Archiving qa-deck**, then **Archived qa-deck**) and `devl/checkout-fix` (uncommitted: **Couldn't archive checkout-fix**, row still there). Each step logs how long the dialog stayed open.
- Hooks: `[data-testid=worktree-row][data-worktree="BOX/NAME"]` for a row, `[data-leaving]` with the name's text for its leaving state, `getByRole("alertdialog")` for the dialog and its exact **Archive** button, `[data-slot=toast-viewport] > *` with the title's text for a toast.
- `app/e2e/worktree-remove.spec.ts` asserts the same on the mock: Remove (no dialog, Remove anyway), Archive (dialog gone in 1 s with `slowremove`, Archiving…, the toast) and Delete in the table.

## Gotchas

- `?slowremove=MS` slows only a worktree with no archive script; one with a script (devl's shop) answers at once and finishes 1.5 s later, as on a box. `checkout-fix` always refuses without force.
- The default sidebar is the rail, which shows one project at a time; the scenario sets `sidebar=list` to see devl's and gpu's worktrees together, as the e2e specs do.
- A worktree already marked is ignored by a second Archive or Remove until its mark goes.
- The real box's slow part (deleting a big folder inside `git worktree remove`) isn't in the mock; a real box is needed to time it (`../scripts/dev-box.sh`).
