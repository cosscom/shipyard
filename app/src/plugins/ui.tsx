import { lazy, Suspense } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { Frame, FramePanel, FrameHeader, FrameTitle, FrameDescription, FrameFooter } from "@/components/ui/frame";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogTrigger, AlertDialogPopup, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogClose } from "@/components/ui/alert-dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Meter, MeterLabel, MeterTrack, MeterIndicator, MeterValue } from "@/components/ui/meter";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuGroupLabel, MenuSeparator } from "@/components/ui/menu";
import { Sheet, SheetClose, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import { PickOne } from "@/components/pick-one";
import { BoxFilter } from "@/components/box-filter";
import { FilterChip } from "@/components/filter-chip";
import { Tip } from "@/components/tip";
import { AgentPicker } from "@/components/new-worktree/agent-picker";
import { AgentIcon } from "@/components/agent-glyph";
import { loadDiffs } from "@/components/diff/load";
import { cn } from "@/lib/utils";
import { WidgetEmpty, WidgetRow, WidgetSkeleton } from "@/views/home/widgets/parts";
import { PluginPage, ViewHeader } from "@/views/view-header";

const NamedIcon = lazy(() => import("@/plugins/dynamic-icon"));

// Icon draws any lucide icon by name, for plugins and their sidebar items.
// Like lucide's DynamicIcon it draws nothing until the icon has loaded.
export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <Suspense fallback={null}>
      <NamedIcon name={name} className={className} />
    </Suspense>
  );
}

// pluginUi is what @berth/plugin/ui resolves to inside a plugin.
export const pluginUi = {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardPanel,
  CardFooter,
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  Input,
  Kbd,
  ScrollArea,
  Separator,
  Spinner,
  Switch,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  Frame,
  FramePanel,
  FrameHeader,
  FrameTitle,
  FrameDescription,
  FrameFooter,
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
  Textarea,
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogClose,
  ToggleGroup,
  ToggleGroupItem,
  Meter,
  MeterLabel,
  MeterTrack,
  MeterIndicator,
  MeterValue,
  Alert,
  AlertTitle,
  AlertDescription,
  Skeleton,
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetPanel,
  SheetFooter,
  SheetClose,
  Checkbox,
  PickOne,
  BoxFilter,
  FilterChip,
  Tip,
  AgentPicker,
  AgentIcon,
  Icon,
  ViewHeader,
  PluginPage,
  cn,
  loadDiffs,
  WidgetRow,
  WidgetEmpty,
  WidgetSkeleton,
};
