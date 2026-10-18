import { BellIcon } from "lucide-react";
import { useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isTauri } from "@/lib/api";
import { useMinute } from "@/components/notifications/notification-center";
import {
  CATEGORIES,
  type Channels,
  quietState,
  route,
  scheduledUntil,
  setChannel,
  setDoNotDisturb,
  setNotificationsOpen,
  setQuietHours,
  useNotifications,
  useNotifyPrefs,
} from "@/lib/notifications";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";
import { IS_LINUX } from "@/lib/platform";

// How many kinds show before Show more.
const FIRST = 8;
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// The week as people read it, Monday first.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// daysOf says which days the schedule covers: "every day", "on weekdays",
// "on Mon, Wed and Fri".
function daysOf(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "every day";
  if (set.size === 0) return "on no days";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "on weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "at weekends";
  const names = WEEK.filter((d) => set.has(d)).map((d) => DAY_NAMES[d].slice(0, 3));
  return `on ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}`;
}

export function NotificationsSection() {
  const prefs = useNotifyPrefs();
  const count = useNotifications((s) => s.notes.length);
  const mac = isTauri() && !IS_LINUX;
  const dnd = prefs.dnd;
  // Re-render each minute, so a schedule that starts or ends shows.
  const now = new Date(useMinute());
  const quiet = quietState(prefs, now);
  // The schedule would be quiet now, but it was turned off for this stretch.
  const skipped = !quiet.on && !!scheduledUntil(prefs, now);
  const columns: [keyof Channels, string, string][] = [
    ["centre", "Centre", "Kept in the notification centre"],
    ["toast", "Toast", "A toast in the window"],
    ["system", mac ? "macOS" : "System", mac ? "A macOS notification while Shipyard is in the background" : "A system notification while Shipyard is in the background"],
  ];
  // The commonest kinds first; the rest behind Show more.
  const [all, setAll] = useState(false);
  const kinds = all ? CATEGORIES : CATEGORIES.slice(0, FIRST);
  const dndDescription = quiet.on
    ? quiet.by === "schedule"
      ? `On until ${clock(quiet.until!)}, by the schedule.`
      : quiet.until
        ? `On until ${clock(quiet.until)}.`
        : "On until you turn it off."
    : skipped
      ? `Off for now. The schedule starts again at ${dnd.from}.`
      : "Hold toasts, sounds and system notifications until you turn it off.";

  return (
    <SettingsPage title="Notifications" description="Everything goes to the centre (⌘⇧N). Pick what else shows.">
      <SettingsGroup
        title="What to show"
        actions={
          <div className="-mb-px flex items-center">
            {columns.map(([key, label, tip]) => (
              <Tip key={key} label={tip}>
                {/* Focusable, so the column's meaning is there for the keyboard too. */}
                <span tabIndex={0} className="w-16 rounded-sm text-center text-desc text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {label}
                </span>
              </Tip>
            ))}
          </div>
        }
      >
        {kinds.map((c) => {
          const ch = prefs.categories[c.id];
          return (
            <SettingsRow key={c.id} label={c.label} description={c.description}>
              <div className="flex items-center">
                {columns.map(([key, label]) => (
                  <span key={key} className="flex w-16 justify-center">
                    <Checkbox aria-label={`${c.label}: ${label}`} checked={ch[key]} onCheckedChange={(v) => setChannel(c.id, { [key]: v === true })} />
                  </span>
                ))}
              </div>
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      {CATEGORIES.length > FIRST && (
        <button type="button" onClick={() => setAll((v) => !v)} className="-mt-6 flex max-w-full items-baseline gap-2 text-left text-desc">
          <span className="shrink-0 font-medium">{all ? "Show fewer" : `Show ${CATEGORIES.length - FIRST} more kinds`}</span>
          {!all && <span className="truncate text-muted-foreground">{CATEGORIES.slice(FIRST).map((c) => c.label).join(", ")}</span>}
        </button>
      )}

      <SettingsGroup title="Do not disturb" description="Quiet hours keep notifications in the centre, without toasts, sounds or system notifications.">
        <SettingsRow label="Do not disturb" description={dndDescription}>
          <Switch checked={quiet.on} onCheckedChange={(on) => setDoNotDisturb(on)} />
        </SettingsRow>
        <SettingsRow label="Quiet hours on a schedule" description={dnd.scheduled ? `From ${dnd.from} to ${dnd.to}, ${daysOf(dnd.days)}.` : "The same quiet hours each day you pick, overnight or not."}>
          <Switch checked={dnd.scheduled} onCheckedChange={(scheduled) => setQuietHours({ scheduled, skipUntil: undefined })} />
        </SettingsRow>
        {dnd.scheduled && (
          <SettingsRow label="Quiet hours">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <div className="flex items-center gap-1.5 text-muted-foreground text-meta">
                <Input type="time" size="sm" aria-label="From" className="w-28" value={dnd.from} onChange={(e) => e.target.value && setQuietHours({ from: e.target.value })} />
                to
                <Input type="time" size="sm" aria-label="To" className="w-28" value={dnd.to} onChange={(e) => e.target.value && setQuietHours({ to: e.target.value })} />
              </div>
              {/* Days are a multi-pick in PickOne's track: a day that's on is
                  raised, a day that's off sits flat and muted. */}
              <ToggleGroup
                multiple
                aria-label="Days"
                size="sm"
                value={dnd.days.map(String)}
                onValueChange={(v) => setQuietHours({ days: (v as string[]).map(Number).sort() })}
                className="gap-0.5 rounded-lg bg-muted p-0.5"
              >
                {WEEK.map((i) => (
                  <Tip key={i} label={`${DAY_NAMES[i]}: ${dnd.days.includes(i) ? "quiet" : "not quiet"}`}>
                    <ToggleGroupItem
                      value={String(i)}
                      aria-label={DAY_NAMES[i]}
                      className="min-w-7 rounded-md px-0 font-normal text-muted-foreground text-meta hover:bg-background/60 hover:text-foreground data-pressed:bg-background data-pressed:font-medium data-pressed:text-foreground data-pressed:shadow-xs/5 dark:hover:bg-input/32 dark:data-pressed:bg-input"
                    >
                      {DAYS[i]}
                    </ToggleGroupItem>
                  </Tip>
                ))}
              </ToggleGroup>
            </div>
          </SettingsRow>
        )}
        <SettingsRow label="Let waiting agents through" description="An agent waiting for you still toasts and notifies during quiet hours.">
          <Switch checked={dnd.allowWaiting} onCheckedChange={(allowWaiting) => setQuietHours({ allowWaiting })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Sound and history">
        <SettingsRow label="Play a sound" description="A soft chime with each toast or system notification.">
          <Switch checked={prefs.sound} onCheckedChange={(sound) => useNotifyPrefs.setState({ sound })} />
        </SettingsRow>
        <SettingsRow label="Send a test" description="A notification through the centre and a toast, the way real ones arrive.">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              route({ category: "plugin", title: "Test notification", detail: "This is how notifications look.", tone: "info", key: `test|${Date.now()}` })
            }
          >
            Send a test
          </Button>
        </SettingsRow>
        <SettingsRow label="History" description={`${count} kept on this computer, up to 500. Only what happened while Shipyard was open.`}>
          <Button size="sm" variant="outline" onClick={() => setNotificationsOpen(true)}>
            <BellIcon />
            Open centre
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
