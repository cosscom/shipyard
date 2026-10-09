import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";

import { toastError } from "@/components/error-note";
import { Button } from "@/components/ui/button";
import { boxApi } from "@/lib/api";
import { permissionChoices } from "@/lib/screen";
import { useAsk } from "@/lib/transcript-feed";
import { FolderIcon, GitBranchIcon, HouseIcon, PinIcon, ServerIcon, ServerOffIcon, SettingsIcon } from "lucide-react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { KEYS } from "@/components/command/hint-layer";
import { Kbd } from "@/components/ui/kbd";
import type { SessionEntry } from "@/hooks/use-agent-counts";
import type { Location, Worktree } from "@/lib/api";
import { agentLabel, agentOf, sessionState, sortedWorktrees, worktreeOf } from "@/lib/derive";
import { ago } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { BOX_WORDS, boxState, sessionWord } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { refFor, refOf, selectWorktree, useWorkspaces, type Workspace, wsKey } from "@/lib/workspaces";
import { placeLabel, worktreeLabel } from "@/lib/worktree-names";
import { useScreenTail } from "@/views/dashboard/use-screen-tail";

// The command layout's switcher is ⌘K with more to say (Labs › Layout ›
// Command): opened empty it is the sidebar's work, in order of what needs
// you: pinned worktrees, agents that need you, those working, those done,
// where you were, then every place, project and box. Agents read as two
// lines, and the item under the keyboard is previewed at the right: an
// agent's last lines on screen, a worktree's agents. ⌘↵ pins a worktree.

// SwitchItem is what the switcher adds to a palette item.
export interface SwitchItem {
  value: string;
  label: string;
  detail?: string;
  search?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  run(): void;
  // An agent, previewed; a worktree (its key), pinned with ⌘↵ and previewed.
  agent?: SessionEntry;
  wt?: string;
  // A second line under the label.
  sub?: string;
  // Its age, at the right.
  when?: string;
  // Show which agent it is: only when they aren't all the same kind.
  kind?: boolean;
}

const slot = (icon: React.ReactNode) => <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span>;

// placeOf is an agent's worktree, "shop / checkout-fix", or its project for
// a main checkout.
function placeOf(locations: Location[] | undefined, e: SessionEntry): { label: string; key?: string } {
  const at = worktreeOf(locations, e.session);
  if (!at) return { label: e.session.name };
  return { label: at.worktree.main ? at.location.name : `${at.location.name} / ${worktreeLabel(at.worktree)}`, key: wsKey(e.box, at.worktree.path) };
}

export function agentItem(e: SessionEntry, go: (fn: () => void) => () => void, focus: (box: string, session: string) => void, mixed = true): SwitchItem {
  const boxes = useStore.getState().boxes;
  const where = placeOf(boxes[e.box]?.locations, e);
  const agent = agentOf(e.session);
  const title = e.session.title?.trim() || where.label;
  const ask = e.state === "waiting" ? e.session.ask : undefined;
  return {
    value: `agent:${e.box}/${e.session.name}`,
    label: title,
    sub: ask?.input || ask?.message ? `${ask.tool ? `${ask.tool}: ` : ""}${ask.input ?? ask.message}` : undefined,
    detail: [title !== where.label ? where.label : undefined, e.box].filter(Boolean).join(" · "),
    search: [e.session.name, where.label, agent && agentLabel(agent), sessionWord(e.state)].filter(Boolean).join(" "),
    icon: (
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <StateGlyph state={e.state} className="size-3.5" />
      </span>
    ),
    when: ago(e.session.state_since ?? e.session.created).replace(" ago", ""),
    agent: e,
    kind: mixed,
    wt: where.key,
    run: go(() => focus(e.box, e.session.name)),
  };
}

export function worktreeItem(box: string, loc: Location, wt: Worktree, go: (fn: () => void) => () => void, opts: { pin?: number } = {}): SwitchItem {
  const key = wsKey(box, wt.path);
  return {
    value: `wt:${key}`,
    label: wt.main ? loc.name : `${loc.name} / ${worktreeLabel(wt)}`,
    detail: [wt.title ? wt.name : undefined, !wt.main && wt.branch !== wt.name ? wt.branch : undefined, box].filter(Boolean).join(" · "),
    search: [wt.name, wt.title, wt.branch, box].filter(Boolean).join(" "),
    icon: slot(wt.main ? <HouseIcon /> : <GitBranchIcon />),
    shortcut: opts.pin ? `⌘${opts.pin}` : undefined,
    wt: key,
    run: go(() => selectWorktree(refOf(box, loc, wt))),
  };
}

// counted heads a lane with how many are in it, and keeps it to max.
const counted = (name: string, items: SwitchItem[], max = items.length) => ({ value: items.length > max ? `${name} · ${max} of ${items.length}` : `${name} · ${items.length}`, items: items.slice(0, max) });

// switcherGroups is the empty switcher, in order of what needs you: agents
// that need you, those working, your pins and where you were, the latest
// done (the rest are a search, or By project, away), then every place,
// project and box.
export function switcherGroups(ctx: {
  sessions: SessionEntry[];
  spaces: Record<string, Workspace>;
  recent: Workspace[];
  places: SwitchItem[];
  go: (fn: () => void) => () => void;
  focus: (box: string, session: string) => void;
  // By state (the default) or by project and box.
  by?: "state" | "place";
}): { value: string; items: SwitchItem[] }[] {
  const st = useStore.getState();
  const pins = usePrefs.getState().pins;
  const lookup = (key: string) => {
    const ref = refFor(key);
    if (!ref) return undefined;
    const loc = st.boxes[ref.box]?.locations?.find((l) => l.name === ref.location);
    const wt = loc?.worktrees?.find((w) => w.path === ref.path);
    return loc && wt ? { box: ref.box, loc, wt } : undefined;
  };
  const pinned = pins.flatMap((key, i) => {
    const at = lookup(key);
    return at ? [worktreeItem(at.box, at.loc, at.wt, ctx.go, { pin: i + 1 })] : [];
  });
  const agents = ctx.sessions.filter((e) => agentOf(e.session) && !e.session.service);
  const byWait = (a: SessionEntry, b: SessionEntry) => (a.session.state_since ?? "").localeCompare(b.session.state_since ?? "");
  const latest = (a: SessionEntry, b: SessionEntry) => (b.session.state_since ?? "").localeCompare(a.session.state_since ?? "");
  const mixed = new Set(agents.map((e) => agentOf(e.session))).size > 1;
  const lane = (state: string, sort: typeof byWait) => agents.filter((e) => e.state === state).sort(sort).map((e) => agentItem(e, ctx.go, ctx.focus, mixed));
  // Where you were, not where you are: the first is the last place (⌘K
  // again goes there).
  const current = useWorkspaces.getState().current;
  const recent = ctx.recent
    .filter((w) => wsKey(w.ref.box, w.ref.path) !== current)
    .slice(0, 5)
    .flatMap((w) => {
      const at = lookup(wsKey(w.ref.box, w.ref.path));
      return at ? [{ ...worktreeItem(at.box, at.loc, at.wt, ctx.go), value: `recent:${w.ref.box}:${w.ref.path}`, label: placeLabel(w.ref) }] : [];
    });
  // Every project on every box, each box's state said once.
  const projects: { value: string; items: SwitchItem[] }[] = [];
  const boxItems: SwitchItem[] = [];
  for (const b of st.status?.boxes ?? []) {
    const d = st.boxes[b.name];
    const state = boxState(b, d);
    const online = b.state === "online";
    const locs = d?.locations ?? [];
    boxItems.push({
      value: `box:${b.name}`,
      label: b.name,
      detail: online ? `${locs.length} project${locs.length === 1 ? "" : "s"}` : BOX_WORDS[state].word,
      search: `box ${BOX_WORDS[state].lower}`,
      icon: slot(online ? <ServerIcon /> : <ServerOffIcon />),
      run: ctx.go(() => st.setView({ kind: "settings", section: "boxes" })),
    });
    if (!online) continue;
    for (const loc of locs) {
      const wts = sortedWorktrees(loc);
      if (!wts.length) continue;
      projects.push({ value: `${loc.name} · ${b.name}`, items: wts.map((wt) => ({ ...worktreeItem(b.name, loc, wt, ctx.go, { pin: pins.indexOf(wsKey(b.name, wt.path)) + 1 || undefined }), value: `all:${b.name}:${wt.path}` })) });
    }
  }
  // By project: every project on every box, its agents (who needs you
  // first) and then its worktrees with nothing running, each headed with
  // how many there are and how many need you.
  if (ctx.by === "place") {
    const out: { value: string; items: SwitchItem[] }[] = [];
    for (const b of st.status?.boxes ?? []) {
      if (b.state !== "online") continue;
      for (const loc of st.boxes[b.name]?.locations ?? []) {
        const here = agents
          .filter((e) => e.box === b.name && worktreeOf(st.boxes[b.name]?.locations, e.session)?.location.name === loc.name && ["waiting", "running", "finished", "ready"].includes(e.state))
          .sort((x, y) => (RANK[x.state] ?? 9) - (RANK[y.state] ?? 9));
        const busy = new Set(here.map((e) => e.session.dir));
        const quiet = sortedWorktrees(loc).filter((wt) => !busy.has(wt.path));
        const items = [...here.map((e) => agentItem(e, ctx.go, ctx.focus, mixed)), ...quiet.map((wt) => ({ ...worktreeItem(b.name, loc, wt, ctx.go, { pin: pins.indexOf(wsKey(b.name, wt.path)) + 1 || undefined }), value: `place:${b.name}:${wt.path}` }))];
        if (!items.length) continue;
        const need = here.filter((e) => e.state === "waiting").length;
        out.push({ value: `${loc.name} · ${b.name} · ${here.length} agent${here.length === 1 ? "" : "s"}${need ? `, ${need} ${sessionWord("waiting").toLowerCase()}` : ""}`, items });
      }
    }
    return [...out, { value: "Boxes", items: boxItems }];
  }
  return [
    counted(sessionWord("waiting"), lane("waiting", byWait)),
    counted(sessionWord("running"), lane("running", latest)),
    { value: "Pinned", items: pinned },
    { value: "Recent", items: recent },
    counted(sessionWord("finished"), lane("finished", latest), 3),
    { value: "Go to", items: ctx.places },
    ...projects,
    { value: "Boxes", items: boxItems },
  ].filter((g) => g.items.length);
}

// SwitchRow draws an item: agents as two lines.
export function SwitchRow({ item }: { item: SwitchItem }) {
  const pinned = usePrefs((p) => (item.wt ? p.pins.indexOf(item.wt) + 1 : 0));
  return (
    <>
      {item.icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{item.label}</span>
          {item.detail && <span className="min-w-0 shrink truncate text-muted-foreground text-xs">{item.detail}</span>}
        </span>
        {item.sub && <span className="truncate font-mono text-[11px] text-muted-foreground">{item.sub}</span>}
      </span>
      {item.agent && item.kind && <AgentIcon agent={agentOf(item.agent.session)} className="size-3.5 shrink-0 opacity-70" />}
      {item.when && <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{item.when}</span>}
      {!item.shortcut && !item.agent && pinned > 0 && <Kbd className="shrink-0">⌘{pinned}</Kbd>}
      {item.shortcut && <Kbd className="shrink-0">{item.shortcut}</Kbd>}
    </>
  );
}

// ---- Answering from the switcher ----------------------------------------

// QUESTION_TOOLS are answered in the agent's own form, not with Allow or Deny.
const QUESTION_TOOLS = /^(AskUserQuestion|request_user_input|ExitPlanMode)$/;

// The preview's answers, for the switcher's keys (⌥A allow, ⌥D deny).
export const useSwitcherAnswers = create<{ allow?: () => void; deny?: () => void }>()(() => ({}));

// AskActions answers a permission without going to the agent: Allow once
// or Deny, read off its screen as Home's Needs you does. A question is
// answered in the agent's own form, which ↵ opens.
export function AskActions({ e, keys = true }: { e: SessionEntry; keys?: boolean }) {
  const client = useStore((s) => s.client);
  const tool = e.session.ask?.tool;
  const question = !tool || QUESTION_TOOLS.test(tool);
  const ask = useAsk(e.box, e.session.name, !question, e.session.state_since);
  const choices = ask && !ask.form ? permissionChoices(ask.choices) : undefined;
  const allowC = choices?.find((c) => c.label === "Allow");
  const denyC = choices?.find((c) => c.label === "Deny");
  const [sent, setSent] = useState<string>();
  const answer = useCallback(
    (key: string, label: string) => {
      if (!client) return;
      setSent(label);
      boxApi.send(client, e.box, e.session.name, key, false, { when: "now", force: true }).catch((err) => {
        setSent(undefined);
        toastError(err, { title: "Couldn't answer", box: e.box });
      });
    },
    [client, e.box, e.session.name],
  );
  const allow = allowC && !sent ? () => answer(allowC.key, "Allow") : undefined;
  const deny = denyC && !sent ? () => answer(denyC.key, "Deny") : undefined;
  useEffect(() => {
    if (!keys) return;
    useSwitcherAnswers.setState({ allow, deny });
    return () => useSwitcherAnswers.setState({ allow: undefined, deny: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowC?.key, denyC?.key, sent, answer]);
  if (sent) return <div className="text-success-foreground text-xs">{sent === "Deny" ? "Denied" : "Allowed"} · it carries on</div>;
  if (question) return keys ? <div className="flex items-center gap-1.5 text-muted-foreground text-xs"><Kbd>↵</Kbd> answer in its chat</div> : null;
  if (!allow || !deny) return null;
  return (
    <div data-testid={keys ? "switcher-answers" : "peek-answers"} className="flex shrink-0 items-center gap-1.5">
      <Button size="xs" variant="outline" onClick={deny}>
        Deny {keys && <Kbd className="ml-0.5 h-4 text-[10px]">⌥D</Kbd>}
      </Button>
      <Button size="xs" onClick={allow}>
        Allow once {keys && <Kbd className="ml-0.5 h-4 bg-transparent text-[10px] text-current/80">⌥A</Kbd>}
      </Button>
    </div>
  );
}

// ---- Preview ----------------------------------------------------------------

function AgentPreview({ e, inWorktree }: { e: SessionEntry; inWorktree?: boolean }) {
  // The agent as the box knows it now, not as the list was made.
  const session = useStore((s) => s.boxes[e.box]?.sessions?.find((x) => x.name === e.session.name)) ?? e.session;
  const stats = useStore((s) => s.boxes[e.box]?.stats);
  const locations = useStore((s) => s.boxes[e.box]?.locations);
  const state = sessionState(session, stats);
  const { tail } = useScreenTail(e.box, session, 8, false, state !== "ready");
  const where = placeOf(locations, { ...e, session });
  const agent = agentOf(session);
  const ask = state === "waiting" ? session.ask : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <AgentIcon agent={agent} className="size-3.5" />
        {agent ? agentLabel(agent) : "Shell"}
        <span className="ml-auto flex items-center gap-1">
          <StateGlyph state={state} className="size-3" />
          <span className={cn(state === "waiting" && "text-warning-foreground", state === "running" && "text-info-foreground", state === "finished" && "text-success-foreground")}>{sessionWord(state)}</span>
          <span>· {ago(session.state_since ?? session.created)}</span>
        </span>
      </div>
      {!inWorktree && <div className="font-medium text-sm leading-snug">{session.title?.trim() || where.label}</div>}
      {inWorktree && session.title && <div className="text-[13px] leading-snug">{session.title}</div>}
      {ask && (ask.input || ask.message) && (
        <div className="rounded-lg border border-warning/30 bg-warning/8 px-2.5 py-2">
          <div className="mb-1 text-[11px] text-warning-foreground">{ask.tool ? `Asks to use ${ask.tool}` : "Asks you"}</div>
          <div className="line-clamp-4 break-words font-mono text-[11px] text-foreground/85">{ask.input ?? ask.message}</div>
          <div className="mt-2">
            <AskActions e={{ ...e, session }} />
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-col">
        <div className="mb-1 text-[11px] text-muted-foreground">Last on screen</div>
        <div data-testid="switcher-tail" className="min-h-0 overflow-hidden rounded-lg bg-background/60 px-2.5 py-2 font-mono text-[11px] text-foreground/80 leading-relaxed">
          {tail?.length ? tail.map((l, i) => <div key={i} className="line-clamp-2 break-words">{l}</div>) : <span className="text-muted-foreground">{tail ? "Nothing yet." : "Reading…"}</span>}
        </div>
      </div>
      {!inWorktree && (
        <div className="mt-auto flex items-center gap-1.5 text-muted-foreground text-xs">
          <FolderIcon className="size-3" />
          <span className="truncate">{where.label}</span>
          <span className="ml-auto rounded bg-accent/70 px-1 py-px font-mono text-[10px]">{e.box}</span>
        </div>
      )}
    </div>
  );
}

const RANK: Record<string, number> = { waiting: 0, running: 1, finished: 2, ready: 3, idle: 4, exited: 5 };

// WorktreePreview is a worktree's place and branch, the agent in it that
// most wants a look (its last lines, as for an agent), and the others.
function WorktreePreview({ wsk }: { wsk: string }) {
  const ref = refFor(wsk);
  const sessions = useStore((s) => (ref ? s.boxes[ref.box]?.sessions : undefined));
  const stats = useStore((s) => (ref ? s.boxes[ref.box]?.stats : undefined));
  const wt = useStore((s) => (ref ? s.boxes[ref.box]?.locations?.find((l) => l.name === ref.location)?.worktrees?.find((w) => w.path === ref.path) : undefined));
  if (!ref) return null;
  const here = (sessions ?? [])
    .filter((x) => x.dir === ref.path && !x.exited && !x.service)
    .map((x) => ({ x, state: sessionState(x, stats) }))
    .sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9));
  const lead = here.find((h) => agentOf(h.x));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {ref.main ? <HouseIcon className="size-3.5" /> : <GitBranchIcon className="size-3.5" />}
        {ref.main ? "Main checkout" : "Worktree"}
        <span className="ml-auto rounded bg-accent/70 px-1 py-px font-mono text-[10px]">{ref.box}</span>
      </div>
      <div>
        <div className="font-medium text-sm leading-snug">{placeLabel(ref)}</div>
        {wt?.branch && <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{wt.branch}</div>}
      </div>
      {lead ? <AgentPreview e={{ box: ref.box, session: lead.x, state: lead.state }} inWorktree /> : <div className="text-muted-foreground text-xs">No agent in it. ⌘N starts one.</div>}
      {here.length > 1 && (
        <div className="flex flex-col gap-1 border-t pt-2">
          {here
            .filter((h) => h !== lead)
            .slice(0, 4)
            .map(({ x, state }) => (
              <div key={x.name} className="flex items-center gap-2 text-xs">
                <StateGlyph state={state} className="size-3" />
                <span className="min-w-0 flex-1 truncate">{x.title?.trim() || (agentOf(x) ? agentLabel(agentOf(x)!) : x.name)}</span>
                <span className="text-muted-foreground">{sessionWord(state)}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// SwitcherPreview shows the item under the keyboard; for anything else, the
// keys there are, so the switcher teaches them as it goes.
export function SwitcherPreview({ item }: { item?: SwitchItem }) {
  const pinned = usePrefs((p) => (item?.wt ? p.pins.indexOf(item.wt) + 1 : 0));
  return (
    <aside data-testid="switcher-preview" aria-label="Preview" className="hidden w-76 shrink-0 flex-col gap-3 border-l bg-muted/30 p-4 min-[900px]:flex">
      {item?.agent ? <AgentPreview key={item.value} e={item.agent} /> : item?.wt ? <WorktreePreview wsk={item.wt} /> : (
        <div className="flex flex-col gap-1">
          <div className="mb-1 flex items-center gap-1.5 text-muted-foreground text-xs">
            <SettingsIcon className="size-3.5" />
            Keys
          </div>
          {KEYS.map((k) => (
            <div key={k.what} className="flex items-center gap-2 py-0.5 text-xs">
              <span className="flex w-14 shrink-0 gap-1">
                {k.keys.map((x) => (
                  <Kbd key={x}>{x}</Kbd>
                ))}
              </span>
              <span className="truncate text-foreground/90">{k.what}</span>
            </div>
          ))}
        </div>
      )}
      {item?.wt && (
        <div className="mt-auto flex items-center gap-2 border-t pt-3 text-[11px] text-muted-foreground">
          <Kbd>↵</Kbd> open
          <span className="ml-2 flex items-center gap-1">
            <Kbd>⌘↵</Kbd>
            {pinned ? `unpin from ⌘${pinned}` : "pin to ⌘1–9"}
          </span>
          {pinned > 0 && <PinIcon className="ml-auto size-3" />}
        </div>
      )}
    </aside>
  );
}
