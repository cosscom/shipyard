import { AlarmClockOffIcon, BookOpenIcon, ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import { ErrorDetails } from "@/components/error-note";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { installSkills, setRemind, type ShownNotice, snoozeSkillsNotice, useSkillsNotices } from "@/lib/skills-notice";
import { actionLabel, noticeDetail, noticeShort, noticeText, SNOOZE_CHOICES } from "@/lib/skills-notice-model";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ink } from "@/components/sidebar/ink";

// The sidebar's quiet word that a box's Shipyard skills aren't installed or
// are out of date (lib/skills-notice.ts), with two ways out: Install now,
// or Snooze. It sits at the sidebar's foot with the What's new note, clear
// of the projects. One box shows whole; more fold under "2 more boxes", as
// worktrees do, so the card stays a few lines tall however many boxes an
// upgrade left behind. Grey throughout: amber is an agent that needs you.

const openAgents = (box: string) => useStore.getState().setView({ kind: "settings", section: "agents", box });

// said is a notice's one line after the box's name: what is wrong, or that
// Install now didn't go through.
const said = (n: ShownNotice, failed: boolean) => (failed ? `couldn't ${n.kind === "outdated" ? "update" : "install"} Shipyard's skills` : noticeText(n));

// Notice is one box's: what is wrong, Install now and Snooze; or, after an
// install that didn't go through, why, with Retry and Settings.
function Notice({ n, onLeave, className, line }: { n: ShownNotice; onLeave?: () => void; className?: string; line?: boolean }) {
  const id = useId();
  // While a retry runs the notice shows the try, not the last failure.
  const f = n.installing ? undefined : n.failure;
  return (
    <div
      role="group"
      aria-labelledby={`${id}-text`}
      data-testid="skills-notice"
      data-box={n.box}
      data-kind={n.kind}
      data-state={n.installing ? "installing" : f ? "failed" : "idle"}
      // In the open sidebar a notice is one quiet line, its buttons at the
      // end; the rail's popover has room for it to wrap.
      className={cn(line ? "flex flex-wrap items-center min-h-7 gap-x-1 gap-y-0.5 pr-edge pl-lane" : "flex flex-col gap-2 px-2.5 py-row-pad", className)}
    >
      <div className={cn("flex flex-col gap-0.5 text-meta", line && "min-w-0 flex-1")}>
        {/* The open sidebar's line is the short form, whole at any width
            ("Skills missing on devl"); its tip and screen readers get the
            full sentence. The rail's popover has room for the sentence. */}
        <Tip label={line ? `${n.box}: ${said(n, !!f)}` : undefined} side="top" align="start">
          {line ? (
            <p id={`${id}-text`} className={cn("truncate text-meta", ink.faint)}>
              <BookOpenIcon aria-hidden className={cn("-mt-0.5 mr-1.5 inline size-3.5", ink.glyph)} />
              <span aria-hidden data-testid="skills-notice-line">
                {noticeShort(n, !!f)}
              </span>
              <span className="sr-only">
                {n.box}: {said(n, !!f)}
              </span>
            </p>
          ) : (
            <p id={`${id}-text`} className="text-pretty text-muted-foreground">
              <BookOpenIcon aria-hidden className="-mt-0.5 mr-1.5 inline size-3.5" />
              <span className="font-medium text-foreground/80">{n.box}</span>: {said(n, !!f)}
            </p>
          )}
        </Tip>
        {f && (
          <p data-testid="skills-notice-error" className="text-pretty text-destructive-foreground">
            {f.title}. {f.message} <ErrorDetails text={f.details} title={f.title} message={f.message} />
          </p>
        )}
      </div>
      <div className={cn("flex flex-wrap items-center gap-1", line && "shrink-0 gap-0")}>
        <Tip label={noticeDetail(n)} side="top" align="start" className="max-w-64">
          <Button size="xs" variant={line ? "ghost" : "outline"} disabled={n.installing} onClick={() => void installSkills(n)} className={cn(line && cn("px-1.5 font-medium hover:text-foreground", ink.row))}>
            {n.installing && <Spinner aria-hidden className="size-3" />}
            {n.installing ? (n.kind === "outdated" ? "Updating…" : "Installing…") : f ? "Retry" : actionLabel(n)}
          </Button>
        </Tip>
        {f && (
          <Tip label={`Open Settings → Agents on ${n.box}'s skills`} side="top">
            <Button
              size="xs"
              variant="ghost"
              className="px-1.5"
              onClick={() => {
                openAgents(n.box);
                onLeave?.();
              }}
            >
              Settings
            </Button>
          </Tip>
        )}
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="ghost" disabled={n.installing} aria-label={`Snooze the reminder for ${n.box}`} className={cn("px-1.5", line ? ink.glyph : "text-muted-foreground")} />}>
            {!line && "Snooze"}
            {line ? <AlarmClockOffIcon /> : <ChevronDownIcon />}
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-48">
            {SNOOZE_CHOICES.map((c) => (
              <MenuItem key={c.id} onClick={() => void snoozeSkillsNotice(n, c.id)}>
                {c.label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={() => void setRemind(n.box, false, { undo: true })}>Don't remind me for {n.box}</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {/* Said aloud while it runs; lib/skills-notice announces how it ended. */}
      <span role="status" className="sr-only">
        {n.installing ? `${n.kind === "outdated" ? "Updating" : "Installing"} Shipyard's skills on ${n.box}…` : ""}
      </span>
    </div>
  );
}

// SkillsNotices is the open sidebar's: one quiet line a box, at its foot
// above the boxes, with the rest folded under "N more boxes".
export function SkillsNotices() {
  const list = useSkillsNotices();
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  const [first, ...rest] = list;
  return (
    <section aria-label="Shipyard's skills" data-testid="skills-notices" className="flex max-h-[45%] shrink-0 flex-col overflow-hidden">
      <div className="min-h-0 overflow-y-auto">
        <Notice key={first.box} n={first} line />
        {open && rest.map((n) => <Notice key={n.box} n={n} line />)}
      </div>
      {rest.length > 0 && (
        <button
          type="button"
          aria-expanded={open}
          data-testid="skills-notices-more"
          onClick={() => setOpen(!open)}
          className={cn("ml-[calc(var(--spacing-lane)+18px)] flex h-6 w-max shrink-0 items-center gap-1 rounded-md px-1 text-tag outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", ink.faint)}
        >
          <ChevronDownIcon aria-hidden className={cn("size-3 transition-transform", open && "rotate-180")} />
          {open ? "Show fewer" : `${rest.length} more ${rest.length === 1 ? "box" : "boxes"}`}
        </button>
      )}
    </section>
  );
}

// railLabel names the rail's button: the one notice whole, or how many.
function railLabel(list: ShownNotice[]): string {
  if (list.length === 1) return `${list[0].box}: ${said(list[0], !!list[0].failure && !list[0].installing)}`;
  return `Shipyard's skills need installing or updating on ${list.length} boxes`;
}

// RailSkillsNotices is the same in the folded sidebar: one quiet button,
// with a grey mark as the rail's other counts have, that opens the notices
// beside it.
export function RailSkillsNotices() {
  const list = useSkillsNotices();
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  const label = railLabel(list);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={label} side="right">
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={label}
              data-testid="skills-notices-rail"
              className="relative inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent data-popup-open:text-foreground [&_svg]:size-4"
            />
          }
        >
          <BookOpenIcon />
          <span aria-hidden className="absolute top-0.5 right-0.5 size-2 rounded-full bg-muted-foreground/70" />
        </PopoverTrigger>
      </Tip>
      <PopoverPopup side="right" align="end" sideOffset={8} aria-label="Shipyard's skills" className="w-64 [&_[data-slot=popover-viewport]]:p-0">
        <div data-testid="skills-notices" className="max-h-[min(24rem,70vh)] divide-y overflow-y-auto">
          {list.map((n) => (
            <Notice key={n.box} n={n} onLeave={() => setOpen(false)} />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
