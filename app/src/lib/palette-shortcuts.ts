// Which of the app's shortcuts (shortcuts.json) ⌘K offers as commands, so
// nothing the keyboard can do is only a key away: the palette lists each,
// with its keys, and runs it as the key would (hooks/use-shortcuts.ts).
// palette-shortcuts.test.ts checks every shortcut is in one list here.

// The palette has its own item for these, with words of its own.
export const OWN_ITEMS = ["new-worktree", "new-terminal", "new-browser", "open-editor", "split-worktree", "zen", "dashboard", "notifications", "shortcuts", "rename"] as const;

// These it lists as the shortcut table names them; labs ones with Labs on.
export const FROM_TABLE = ["files", "split-right", "split-down", "compare", "close-pane", "close-group", "file-tree", "devtools", "sidebar", "zoom-in", "zoom-out", "zoom-reset", "compare-swap", "prev-group", "next-group"] as const;

// And these it doesn't, because they act on where the keyboard already is,
// or are ⌘K itself.
export const NOT_IN_PALETTE: Record<string, string> = {
  palette: "it is ⌘K",
  tab: "a tab by its place; ⌘K finds sessions and worktrees by name",
  focus: "moves from the pane the keyboard is in",
  "compare-lane": "picks a lane of the Compare tab in front, which has buttons for them",
  "add-group": "a ⌥-click in the sidebar (⌘K's worktrees open in a group with Labs on)",
  "save-file": "saves the File tab the keyboard is in",
  find: "finds in the chat the keyboard is in",
  send: "sends the reply box the keyboard is in",
  "stop-agent": "stops the agent of the reply box the keyboard is in (its Stop button does too)",
  fold: "on the sidebar's project the keyboard is on",
  menu: "opens the menu of the row the keyboard is on",
  "deck-switcher": "the workspace layout's finder; ⌘K finds the same agents and worktrees",
  "deck-zoom": "zooms the pane the keyboard is in (its header has a button for it)",
  "deck-swap": "moves the pane the keyboard is in",
};
