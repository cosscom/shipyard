// The app's UI kit, shared with plugins. See src/plugins/host.ts.
const ui = globalThis.__berth.ui;
export default ui;
export const {
  Badge, Button, Card, CardHeader, CardTitle, CardDescription, CardPanel, CardFooter,
  Empty, EmptyHeader, EmptyTitle, EmptyDescription, Input, Kbd, ScrollArea, Separator,
  Spinner, Switch, Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
  Tooltip, TooltipTrigger, TooltipPopup, Icon, cn, ViewHeader, PluginPage,
  Frame, FramePanel, FrameHeader, FrameTitle, FrameDescription, FrameFooter, Tabs, TabsList, TabsTab, TabsPanel, Textarea, AlertDialog, AlertDialogTrigger, AlertDialogPopup, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogClose, ToggleGroup, ToggleGroupItem, Meter, MeterLabel, MeterTrack, MeterIndicator, MeterValue, Alert, AlertTitle, AlertDescription, Skeleton, Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuGroupLabel, MenuSeparator,
  Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription, SheetPanel, SheetFooter, SheetClose, Checkbox, PickOne, BoxFilter, FilterChip, Tip, AgentPicker, AgentIcon,
  loadDiffs, WidgetRow, WidgetEmpty, WidgetSkeleton, Chart, SqlEditor, SessionSurface, HelperSurface, BrowserSurface, HelperBox, useHelperState,
} = ui;
