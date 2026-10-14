// The app's UI kit, shared with plugins so they look like the rest of Shipyard.
// Components take the same props as in the app (coss ui, built on Base UI);
// they are typed loosely here so the SDK does not depend on the app's source.
import type { ComponentType, ReactNode } from "react";

import type { BerthPluginContext, HelperStatus } from "./index";

// biome-ignore lint/suspicious/noExplicitAny: see above.
type Loose = ComponentType<any>;

export declare const Badge: Loose;
export declare const Button: Loose;
export declare const Card: Loose;
export declare const CardHeader: Loose;
export declare const CardTitle: Loose;
export declare const CardDescription: Loose;
export declare const CardPanel: Loose;
export declare const CardFooter: Loose;
export declare const Empty: Loose;
export declare const EmptyHeader: Loose;
export declare const EmptyTitle: Loose;
export declare const EmptyDescription: Loose;
export declare const Input: Loose;
export declare const Kbd: Loose;
export declare const ScrollArea: Loose;
export declare const Separator: Loose;
export declare const Spinner: Loose;
export declare const Switch: Loose;
export declare const Table: Loose;
export declare const TableHeader: Loose;
export declare const TableBody: Loose;
export declare const TableRow: Loose;
export declare const TableHead: Loose;
export declare const TableCell: Loose;
export declare const Tooltip: Loose;
export declare const TooltipTrigger: Loose;
export declare const TooltipPopup: Loose;
// A section of a screen: <Frame variant="card"> with a FrameHeader and
// FramePanels inside, one outline for the section. Without the variant,
// Frame is a muted tray of raised panels, meant for grouped inputs.
export declare const Frame: Loose;
export declare const FramePanel: Loose;
export declare const FrameHeader: Loose;
export declare const FrameTitle: Loose;
export declare const FrameDescription: Loose;
export declare const FrameFooter: Loose;
export declare const Tabs: Loose;
export declare const TabsList: Loose;
export declare const TabsTab: Loose;
export declare const TabsPanel: Loose;
export declare const Textarea: Loose;
export declare const AlertDialog: Loose;
export declare const AlertDialogTrigger: Loose;
export declare const AlertDialogPopup: Loose;
export declare const AlertDialogHeader: Loose;
export declare const AlertDialogFooter: Loose;
export declare const AlertDialogTitle: Loose;
export declare const AlertDialogDescription: Loose;
export declare const AlertDialogClose: Loose;
export declare const ToggleGroup: Loose;
export declare const ToggleGroupItem: Loose;
export declare const Meter: Loose;
export declare const MeterLabel: Loose;
export declare const MeterTrack: Loose;
export declare const MeterIndicator: Loose;
export declare const MeterValue: Loose;
export declare const Alert: Loose;
export declare const AlertTitle: Loose;
export declare const AlertDescription: Loose;
export declare const Skeleton: Loose;
export declare const Menu: Loose;
export declare const MenuTrigger: Loose;
export declare const MenuPopup: Loose;
export declare const MenuItem: Loose;
export declare const MenuGroup: Loose;
export declare const MenuGroupLabel: Loose;
export declare const MenuSeparator: Loose;
// A panel that slides in from an edge: <Sheet open onOpenChange><SheetPopup
// side="right">…</SheetPopup></Sheet>, with SheetHeader, SheetPanel (the
// scrolling middle) and SheetFooter inside.
export declare const Sheet: Loose;
export declare const SheetPopup: Loose;
export declare const SheetHeader: Loose;
export declare const SheetTitle: Loose;
export declare const SheetDescription: Loose;
export declare const SheetPanel: Loose;
export declare const SheetFooter: Loose;
export declare const SheetClose: Loose;
export declare const Checkbox: Loose;
// The app's own pickers, so a plugin's choices look like the app's.
// PickOne: one of a few values, as a segmented control.
export declare const PickOne: ComponentType<{
  value: string;
  options: { value: string; label: ReactNode; icon?: ReactNode }[];
  onChange(value: string): void;
  label?: string;
  className?: string;
}>;
// BoxFilter: which boxes a screen covers. Pressed means shown; every box
// starts pressed and the last one on stays on. `hidden` is what you keep.
export declare const BoxFilter: ComponentType<{ boxes: string[]; hidden: string[]; onChange(hidden: string[]): void; label?: string; className?: string }>;
// FilterChip: narrows a list to rows with a label, tag or state. Chips start
// off; each one on narrows further. (One of a few values is PickOne.)
export declare const FilterChip: ComponentType<{ pressed: boolean; onPressedChange(pressed: boolean): void; children?: ReactNode; className?: string }>;
// Tip: the app's tooltip on one element, never the HTML title attribute,
// which shows late and not at all for keyboard users. A disabled button
// still shows its tip (why it is disabled, say).
export declare const Tip: ComponentType<{ label: ReactNode; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; delay?: number; className?: string; wrapClassName?: string; children: ReactNode }>;
// AgentPicker: one of a box's agents (BoxInfo.agents), with their icons.
export declare const AgentPicker: ComponentType<{ presets: { id: string; name: string }[]; value: string; onChange(id: string): void; allowNone?: boolean; className?: string }>;
// AgentIcon: an agent's mark, by preset id ("claude", "codex", …).
export declare const AgentIcon: ComponentType<{ agent?: string; className?: string }>;
// The app's live conversation/terminal and browser views, embeddable in a
// plugin screen. Their parent must give them a bounded height.
export declare const SessionSurface: ComponentType<{ box: string; session: string; agent?: string; mode: "chat" | "terminal"; visible?: boolean; focused?: boolean; onModeChange?(mode: "chat" | "terminal"): void }>;
export declare const HelperSurface: ComponentType<{ box: string; session: string; helper: string; name?: string; onClose(): void }>;
export declare const BrowserSurface: ComponentType<{ id: string; url: string; worktree?: string; visible?: boolean; onNavigate?(url: string): void }>;
// The strip at the top of a screen: <ViewHeader title description actions />.
// Render it anywhere in a screen and it takes the app's strip, so the screen
// names itself once, the way the app's own views do.
export declare const ViewHeader: ComponentType<{ title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }>;
// The page body the app puts a screen in (max-w-5xl, left aligned). A
// screen with layout "fill" can use it for parts of its area.
export declare const PluginPage: ComponentType<{ className?: string; children?: ReactNode }>;
// Any lucide icon by name: <Icon name="Server" />.
export declare const Icon: ComponentType<{ name: string; className?: string }>;
// A chart drawn by the app's own chart components, in the theme's colours:
// bars, lines or areas over rows, as an agent's chart artifact is (the
// berth.chart format, docs/guides/artifacts). x names the row's label ("x"
// when left out) and y its series, by key; a color is "1" to "5" (the
// theme's series palette), "good", "bad", "warn" or "muted". The chart
// fills its box, 16rem high unless className says otherwise.
export interface ChartSpec {
  type: "bar" | "line" | "area";
  data: Record<string, string | number | null>[];
  x?: string;
  y: (string | { key: string; label?: string; color?: string })[];
  // "ms", "%", "$": written after (or before) a value in the tooltip.
  units?: string;
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
}
export declare const Chart: ComponentType<{ spec: ChartSpec; className?: string }>;
// A small SQL editor: the File tab's editor (CodeMirror, in the theme's
// colours) for a statement or a few, with completion of the tables and
// columns you give it and a key to run. It loads on first use, so a plugin
// has an editor without carrying one. Its box sets the size (10rem high
// unless className says otherwise); the editor scrolls inside it.
export interface SqlEditorProps {
  value: string;
  onChange(value: string): void;
  // ⌘↵ (Ctrl+↵ off a Mac): the selection then, as offsets into value, with
  // from === to for a cursor. What to run from that is the plugin's rule.
  onRun?(selection: { from: number; to: number }): void;
  // The selection whenever it moves, for a Run button outside the editor.
  onSelect?(selection: { from: number; to: number }): void;
  // What to complete: each table (or "schema.table") and its columns.
  schema?: Record<string, string[]>;
  // The schema whose tables complete without its name ("public").
  defaultSchema?: string;
  // "postgresql", "mysql", "mariadb", "sqlite", "mssql", "plsql" or
  // "cassandra": its keywords and quoting. Anything else is standard SQL.
  dialect?: string;
  // Where a statement failed, as offsets into value: underlined from `from`
  // to `to`, or to the end of the word there. Typing takes the mark away.
  error?: { from: number; to?: number };
  // What a screen reader calls the editor ("SQL" when left out).
  label?: string;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}
export declare const SqlEditor: ComponentType<SqlEditorProps>;
export declare function cn(...classes: unknown[]): string;

// For a plugin that carries a program for boxes (berth-plugin.json's
// "box.helper", berth.helper): the per-box switch every such plugin needs.
// HelperCopy is what the plugin says of its own helper; the states, the
// buttons and the confirms are the app's, the same for every plugin.
export interface HelperCopy {
  // The plugin, as a sentence names it: "Leadline".
  name: string;
  // The program it puts on a box: "berth-leadline".
  program: string;
  // A lucide icon for the plugin, where it introduces itself.
  icon?: string;
  // The confirm before the program is installed or replaced: what it does
  // once it runs on the box. It follows "This installs <program>, a program
  // this plugin carries, on <box> and keeps it running there."
  does(box: string): ReactNode;
  // A panel on a box where it is off: what turning it on there gets you.
  about(box: string): ReactNode;
  // A box's row while it is off.
  off(box: string): ReactNode;
  // Removing what the program kept on a box.
  remove: {
    // The confirm's title: "Remove what Leadline recorded on devl?"
    title(box: string): string;
    // What goes. It follows "This stops <program> on <box>, removes it, and".
    body(box: string): ReactNode;
    // The notification once it is gone: "Removed Leadline's data on devl".
    done(box: string): string;
  };
  // Only for a helper that changes the environment of the services a box
  // starts ("attach_env"): those services still point at it once it is
  // turned off. This is the sentence for the box's row, given the services
  // by name ("web in acme/fix-orders") and how many there are.
  left?(services: string, count: number): string;
}
// HelperBox, as a "row" (the default): one box of a list of boxes, an <li>
// with its state (Off, Installing…, Running, Failed, Can't run it, Offline),
// Turn on… (a confirm that names the program), Update, Turn off and Remove
// data…, and children under a running helper. As a "panel": a worktree
// panel's whole body on a box where the helper isn't running, with why and
// the same Turn on…; it draws nothing once the helper runs.
export declare const HelperBox: ComponentType<{
  berth: BerthPluginContext;
  box: string;
  copy: HelperCopy;
  variant?: "row" | "panel";
  // A row: whether the box can be reached, and whether the row is on screen
  // (nothing is read while it is not).
  online?: boolean;
  active?: boolean;
  // A panel: opens the plugin's own screen, from an "About <name>" button.
  onAbout?(): void;
  // The prefix of its data-testid attributes ("helper" when left out):
  // <prefix>-box, <prefix>-restart, <prefix>-notice.
  testId?: string;
  children?: ReactNode;
}>;
// useHelperState is the plugin's helper on a box as HelperBox knows it,
// read again while active (every second while it installs or starts,
// otherwise every fifteen). status is undefined until the first answer;
// fault is why it could not be read; old is a Shipyard on this computer
// from before helpers. refresh reads now: call it when a request to the
// helper says it has gone ("helper_off").
export declare function useHelperState(
  berth: BerthPluginContext,
  box: string,
  active: boolean,
): { status?: HelperStatus; fault?: { message: string; code?: string; status?: number; hint?: string }; old?: boolean; refresh(): void };

// The app's diff renderer (@pierre/diffs, diffs.com: highlighted in two
// workers, themed like the app), loaded on first use and shared with the
// app's own diffs: its default export draws files as a scrolling list.
// Call loadDiffs() only when a diff is to be shown.
export interface DiffFile {
  name: string;
  prevName?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  hunks: readonly unknown[];
}
export interface DiffViewerItem {
  id: string;
  fileDiff: DiffFile;
  collapsed: boolean;
  // A new number whenever the item changes (folded, a new read), so the
  // view redraws exactly the files that did.
  version: number;
}
export interface DiffViewerProps {
  items: DiffViewerItem[];
  layout: "split" | "unified";
  wrap: boolean;
  dark: boolean;
  // Scrolls to a file; n changes for each jump.
  jump?: { id: string; n: number };
  // The file at the top of the view, as it scrolls.
  onActive?(id: string): void;
  renderHeader(id: string): ReactNode;
  // A different diff: start again from its top.
  resetKey?: string;
}
export interface DiffsModule {
  // A git patch, one entry per file.
  parse(patch: string): DiffFile[];
  default: ComponentType<DiffViewerProps>;
}
export declare function loadDiffs(): Promise<DiffsModule>;

// For Home widgets (berth.addHomeWidget), so one reads like Shipyard's own.
// WidgetRow: one 36px line, a button when it has onClick (label names it
// for screen readers when its text doesn't say enough).
export declare const WidgetRow: ComponentType<{ children?: ReactNode; onClick?: () => void; className?: string; label?: string }>;
// WidgetEmpty: nothing to show. A small scene ("calm", "anchor", "chart",
// "dock", "storm" for an error…), what that means, and one thing to do.
// compact drops the scene, for a one-row widget.
export declare const WidgetEmpty: ComponentType<{ scene?: string; title: string; hint?: ReactNode; action?: string; onAction?: () => void; compact?: boolean }>;
// WidgetSkeleton: rows while they load, at their height, so nothing moves.
export declare const WidgetSkeleton: ComponentType<{ rows?: number; className?: string }>;
