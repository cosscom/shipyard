import { ArrowRightIcon, CheckIcon, ChevronRightIcon, CloudDownloadIcon, FolderGit2Icon, FolderIcon, FolderOpenIcon, FolderPlusIcon, GitBranchIcon, PackageIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { FolderBrowser } from "@/components/add-project/folder-browser";
import { dirname } from "@/components/add-project/intent";
import { mergeProgress, type RunResult, runPlan } from "@/components/add-project/run";
import { shortPath, uniqueName } from "@/components/add-project/unique-name";
import { type Destination, type Plan, type Row, usePlan } from "@/components/add-project/use-plan";
import { BoxStrip } from "@/components/add-project/box-strip";
import { Scene } from "@/components/art/scenes";
import { Button } from "@/components/ui/button";
import { StepHeader } from "@/components/step-header";
import { DialogFooter, DialogPanel } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import type { Location } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { useStore } from "@/lib/store";
import { Tip } from "@/components/tip";
import { cn } from "@/lib/utils";
import { selectWorktree } from "@/lib/workspaces";
import { reloadKits, useKits } from "@/views/kits/kits-store";
import { openAddBox } from "@/views/onboarding/add-box-dialog";
import { ErrorText } from "@/components/error-note";

// AddProjectDialog adds a repository on a box as a project. The boxes come
// first, because that is where a project lives; then one field takes
// whatever the person has (a path, a git URL, owner/repo, a PR link, a new
// name) and the box says what Enter will do there. Folders on the box and
// projects on the other boxes are offered below it, and the same repository
// can be set up on more boxes at once, with its kit.
type Log = { box: string; lines: string[] };

// AddProjectBody is the dialog's content; its frame (components/
// add-location-dialog.tsx) loads it when it first opens.
export function AddProjectBody({ startBox }: { startBox?: string }) {
  const status = useStore((s) => s.status);
  const boxes = useMemo(() => status?.boxes ?? [], [status]);
  const firstOnline = boxes.find((b) => b.state === "online")?.name ?? "";
  const [box, setBox] = useState(startBox && boxes.some((b) => b.name === startBox) ? startBox : firstOnline);
  const online = boxes.find((b) => b.name === box)?.state === "online";
  const [browsing, setBrowsing] = useState(false);
  const [input, setInput] = useState("");
  const [dest, setDest] = useState<Destination>({});
  const [active, setActive] = useState(-1);
  const [also, setAlso] = useState<string[]>([]);
  const [withKit, setWithKit] = useState(true);
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState<string>();
  const field = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController>(null);
  const queued = useRef(false);

  useEffect(() => {
    if (!box && firstOnline) setBox(firstOnline);
  }, [box, firstOnline]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => void reloadKits(), []);

  const { intent, plan, rows, pending, home } = usePlan(box, input, dest, online && !browsing);
  const kits = useKits((s) => s.kits);

  // A new repository starts from its own folder name and ~/work again.
  const repoKey = intent.kind === "repo" ? intent.url : "";
  useEffect(() => setDest({}), [repoKey]);
  // Typing a path is finding a folder: the first one that starts with what
  // was typed is what Enter takes, as Tab would complete it. Anything else
  // runs the plan.
  const rowsKey = rows.map((r) => r.key).join("|");
  useEffect(() => {
    const first = intent.kind === "path" && plan?.do === "create" ? rows.findIndex((r) => r.kind !== "new") : -1;
    setActive(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey, plan?.do, box, input]);
  useEffect(() => setAlso((a) => a.filter((b) => b !== box)), [box]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Other boxes this repository could also be set up on.
  const slug = plan?.do === "clone" || plan?.do === "add" ? plan.slug : plan?.do === "open" ? plan.loc.slug : undefined;
  const canSpread = !!slug && (plan?.do === "clone" || plan?.do === "add" || (plan?.do === "open" && !!plan.loc.remote));
  // As one string, so the store selector returns something stable.
  const othersKey = useStore((s) =>
    boxes
      .filter((b) => b.name !== box && b.state === "online")
      .map((b) => `${b.name}:${!!slug && !!s.boxes[b.name]?.locations?.some((l) => l.slug?.toLowerCase() === slug.toLowerCase()) ? 1 : 0}`)
      .join(","),
  );
  const others = useMemo(() => (othersKey ? othersKey.split(",").map((x) => ({ name: x.slice(0, x.lastIndexOf(":")), has: x.endsWith(":1") })) : []), [othersKey]);
  const spreadTo = canSpread ? also.filter((b) => others.some((o) => o.name === b && !o.has)) : [];
  const kit = slug ? kits?.find((k) => k.match?.slug?.toLowerCase() === slug.toLowerCase()) : undefined;
  const kitOn = !!kit && withKit && plan?.do !== "create" && (plan?.do !== "open" || spreadTo.length > 0);

  const busy = phase === "running";
  const actionable = !!plan && plan.do !== "blocked" && plan.do !== "look" && !busy;

  const finish = async ({ loc, extras }: RunResult, p: Plan) => {
    const st = useStore.getState();
    await Promise.all([st.refreshBox(box, ["locations"]), ...extras.filter((e) => e.loc).map((e) => st.refreshBox(e.box, ["locations"]))]);
    const main = loc.worktrees?.find((w) => w.main) ?? { name: loc.name, path: loc.path, main: true };
    st.closeAddLocation();
    selectWorktree({ box, location: loc.name, worktree: main.name, path: main.path, main: true });
    const placed = [box, ...extras.filter((e) => e.loc).map((e) => e.box)];
    const failed = extras.filter((e) => e.error);
    if (p.do !== "open" || placed.length > 1)
      toastManager.add({
        title: p.do === "open" ? `${loc.name} is on ${placed.join(", ")}` : `Added ${loc.name}`,
        description: `${shortPath(loc.path, home)} on ${placed.join(", ")}${failed.length ? `; not on ${failed.map((f) => f.box).join(", ")} (${failed[0].error})` : ""}`,
        type: failed.length ? "warning" : "success",
      });
    // A pull request or issue link: the project is here now, so make the
    // worktree for it next.
    const link = p.do === "clone" || p.do === "open" ? p.link : undefined;
    if (link) st.openNewWorktree({ box, location: loc.name, name: link.url });
  };

  const run = async (p: Plan) => {
    if (p.do === "blocked" || p.do === "look" || busy) return;
    setPhase("running");
    setError(undefined);
    setLogs([]);
    abort.current = new AbortController();
    const signal = abort.current.signal;
    try {
      const res = await runPlan(p, {
        box,
        home,
        // The boxes picked below are for the plan shown, not a row picked instead.
        also: p === plan ? spreadTo : [],
        kit: kitOn ? kit : undefined,
        signal,
        onLine: (b, line) =>
          setLogs((ls) => {
            const i = ls.findIndex((l) => l.box === b);
            if (i < 0) return [...ls, { box: b, lines: [line] }];
            return ls.map((l, n) => (n === i ? { ...l, lines: mergeProgress(l.lines, line) } : l));
          }),
      });
      await finish(res, p);
    } catch (err) {
      setError(signal.aborted ? "Stopped." : plainError(err));
      setPhase("failed");
    }
  };

  // Enter before the box has answered does, once it has, what Enter would
  // have done then: take the folder a typed path points at, or run the plan.
  useEffect(() => {
    if (!queued.current || pending) return;
    queued.current = false;
    const first = intent.kind === "path" && plan?.do === "create" ? rows.findIndex((r) => r.kind !== "new") : -1;
    if (first >= 0) pick(rows[first]);
    else if (plan?.do === "look") setActive(rows.length ? 0 : -1);
    else if (plan) void run(plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, plan]);

  // The plan line follows the highlighted row when Enter would take it.
  const activeRow = active >= 0 ? rows[active] : undefined;
  const rowPlan: Plan | undefined =
    activeRow?.kind === "project" && activeRow.loc
      ? { do: "open", loc: activeRow.loc, note: `Already a project on ${box}` }
      : activeRow?.kind === "repo" && activeRow.entry
        ? { do: "add", path: activeRow.entry.path, name: uniqueName(box, activeRow.entry.name), git: true, slug: activeRow.entry.slug }
        : undefined;
  const shown = rowPlan ?? (input.trim() ? plan : undefined);

  const pick = (r: Row, complete = false) => {
    if (complete || r.kind === "folder" || r.kind === "elsewhere") {
      setInput(r.fill);
      field.current?.focus();
      return;
    }
    if (r.kind === "new") return void (plan && run(plan));
    if (r.loc) return void run({ do: "open", loc: r.loc });
    if (r.entry) return void run({ do: "add", path: r.entry.path, name: uniqueName(box, r.entry.name), git: !!r.entry.git, slug: r.entry.slug });
  };

  const submit = () => {
    if (busy) return;
    if (active >= 0 && rows[active]) return pick(rows[active]);
    if (!input.trim()) return;
    if (pending) {
      queued.current = true;
      return;
    }
    // Enter on a folder ("~/work/") goes into its list, as ↓ would; it
    // never adds the folder itself.
    if (plan?.do === "look") return setActive(rows.length ? 0 : -1);
    if (plan) void run(plan);
  };

  const close = () => useStore.getState().closeAddLocation();

  // No box at all: a project has nowhere to live yet, so the one thing to
  // do is add a box. Only once the status has come, so a slow start does
  // not flash it.
  if (status && boxes.length === 0) return <NoBoxes onCancel={close} />;

  if (browsing && online) {
    return (
      <>
        <StepHeader onBack={() => setBrowsing(false)} title="Browse folders" description={`Pick a repository or folder on ${box}.`} />
        <FolderBrowser box={box} start={intent.kind === "path" ? (input.trim().endsWith("/") ? input.trim().replace(/(.)\/+$/, "$1") : dirname(input.trim())) : undefined} onAdded={(loc: Location) => finish({ loc, extras: [] }, { do: "add", path: loc.path, name: loc.name, git: loc.repo })} />
      </>
    );
  }

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <StepHeader title="Add a project" description={boxes.length > 1 ? "Projects live on your boxes. Pick one, then type what to add: the box works out the rest." : `Projects live on your boxes. Type what to add on ${box || "it"}: the box works out the rest.`} />
      <DialogPanel className="flex flex-col gap-3 px-5 pt-1 pb-4">
        {boxes.length > 0 && <BoxStrip boxes={boxes} value={box} onChange={(b) => !busy && setBox(b)} />}

        {!online ? (
          <Moored box={box} others={boxes.some((b) => b.name !== box && b.state === "online")} />
        ) : (
          <>
            <div className="flex h-10 items-center gap-2 rounded-lg border border-input bg-background ps-3 pe-1 shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 dark:bg-input/32">
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <input
                ref={field}
                autoFocus
                value={input}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                aria-label="Path, git URL, owner/repo or new name"
                placeholder={`A path on ${box}, a git URL, owner/repo, or a new name`}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter is handled here, not by the form: a form whose
                  // button is disabled (the box still answering) ignores it.
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, rows.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, -1));
                  } else if (e.key === "Tab" && !e.shiftKey && (active >= 0 || (intent.kind === "path" && rows.length > 0))) {
                    // Tab completes, as in a shell.
                    e.preventDefault();
                    pick(rows[Math.max(active, 0)], true);
                  }
                }}
                className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground/72 placeholder:text-sm disabled:opacity-64"
              />
              <Button type="button" size="xs" variant="ghost" className="shrink-0 text-muted-foreground" disabled={busy} onClick={() => setBrowsing(true)}>
                <FolderOpenIcon />
                Browse
              </Button>
            </div>

            <PlanLine plan={shown} pending={pending && !!input.trim() && shown === plan} box={box} home={home} target={active < 0 || shown !== plan || rows[active]?.kind === "new"} dest={dest} setDest={setDest} busy={busy} onEnter={() => (pending ? (queued.current = true) : plan && void run(plan))} />

            <div ref={listRef} className="h-56 overflow-y-auto rounded-lg border bg-muted/24 p-1 dark:bg-input/16">
              {phase !== "idle" ? (
                <Progress logs={logs} busy={busy} />
              ) : rows.length === 0 ? (
                <Quiet intent={intent.kind} plan={plan} box={box} pending={pending} />
              ) : (
                <Rows rows={rows} active={active} onHover={setActive} onPick={pick} />
              )}
            </div>
            {error && <ErrorText className="-mt-1 text-destructive-foreground text-sm" text={error} />}
          </>
        )}
      </DialogPanel>

      <DialogFooter className="h-14 items-center gap-3 px-5 py-0 sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {online && canSpread && others.length > 0 ? (
            <>
              <span className="shrink-0 pe-0.5 text-muted-foreground text-xs">Also on</span>
              {others.map((o) => (
                <Chip
                  key={o.name}
                  on={o.has || also.includes(o.name)}
                  disabled={o.has || busy}
                  title={o.has ? `${o.name} already has ${slug}` : `Clone it on ${o.name} too`}
                  onClick={() => setAlso((a) => (a.includes(o.name) ? a.filter((x) => x !== o.name) : [...a, o.name]))}
                >
                  {o.name}
                  {o.has && <span className="text-muted-foreground">has it</span>}
                </Chip>
              ))}
              {kit && (
                <Chip on={kitOn} disabled={busy || (plan?.do === "open" && !spreadTo.length)} title={kit.description ?? `Set it up with the ${kit.name} kit`} onClick={() => setWithKit((v) => !v)}>
                  <PackageIcon className="size-3" />
                  {kit.name} kit
                </Chip>
              )}
            </>
          ) : online ? (
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <Kbd>↑↓</Kbd> pick <Kbd className="ms-1.5">⇥</Kbd> complete <Kbd className="ms-1.5">↵</Kbd> {activeRow && !rowPlan && activeRow.kind !== "new" ? "choose" : verb(shown)}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busy ? (
            <Button type="button" variant="ghost" onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
          )}
          {online && (
            <Button type="submit" loading={busy} disabled={!busy && (!actionable || !input.trim() || (pending && !queued.current)) && active < 0}>
              {active >= 0 && rows[active] && rows[active].kind !== "new" ? rowVerb(rows[active]) : primaryLabel(plan, spreadTo.length)}
            </Button>
          )}
        </div>
      </DialogFooter>
    </form>
  );
}

const verb = (p?: Plan) => (p && p.do !== "blocked" ? { open: "open", add: "add", clone: "clone", create: "create", look: "choose" }[p.do] : "add");

function primaryLabel(p: Plan | undefined, extra: number): string {
  const more = extra ? ` on ${extra + 1} boxes` : "";
  switch (p?.do) {
    case "open":
      return extra ? `Open, and clone on ${extra === 1 ? "1 more box" : `${extra} more boxes`}` : "Open project";
    case "clone":
      return `Clone${more}`;
    case "create":
      return "Create project";
    case "add":
      return `Add project${more}`;
    default:
      return "Add project";
  }
}

const rowVerb = (r: Row) => ({ project: "Open project", repo: "Add project", elsewhere: "Choose", folder: "Open folder", new: "Create project" })[r.kind];

// PlanLine says exactly what Enter does, on which box. Two lines, always the
// same height, so nothing below moves as the answer changes.
function PlanLine({ plan, pending, box, home, target, dest, setDest, busy, onEnter }: { plan?: Plan; pending: boolean; box: string; home?: string; target: boolean; dest: Destination; setDest(d: Destination): void; busy: boolean; onEnter(): void }) {
  const short = (p: string) => shortPath(p, home);
  const on = <span className="shrink-0 text-muted-foreground">on {box}</span>;
  let icon: React.ReactNode = <ArrowRightIcon />;
  let line: React.ReactNode;
  let detail: React.ReactNode;
  let tone = "";
  switch (plan?.do) {
    case undefined:
      icon = <ArrowRightIcon />;
      line = <span className="text-muted-foreground">Add a folder, clone a repository, or start a new one.</span>;
      detail = <>The box checks what you type and says what Enter will do.</>;
      tone = "text-muted-foreground";
      break;
    case "open":
      icon = <ArrowRightIcon />;
      line = (
        <>
          <b className="font-medium">Open</b> <Mono>{plan.loc.name}</Mono> {on}
        </>
      );
      detail = (
        <>
          {plan.link ? "Already here" : (plan.note ?? "Already a project here")}, at <Mono>{short(plan.loc.path)}</Mono>
          {plan.link && <>; {plan.link.kind === "pr" ? `PR #${plan.link.n}` : `issue #${plan.link.n}`} opens as a new worktree next</>}
        </>
      );
      break;
    case "add":
      icon = plan.git ? <FolderGit2Icon /> : <FolderIcon />;
      line = (
        <>
          <b className="font-medium">Add</b> <Mono>{short(plan.path)}</Mono> {on}
        </>
      );
      detail = plan.git ? (
        <>
          {plan.note ? `${plan.note} ` : ""}git{plan.slug ? ` · ${plan.slug}` : " · no remote"} · as <Mono>{plan.name}</Mono>
        </>
      ) : (
        <span className="text-warning-foreground">Not a git repository: it can be a project, but worktrees need git.</span>
      );
      break;
    case "clone":
      icon = <CloudDownloadIcon />;
      line = (
        <>
          <b className="font-medium">Clone</b> <Mono className="min-w-0 truncate">{plan.display}</Mono> {on}
        </>
      );
      detail = (
        <span className="flex min-w-0 items-center gap-1">
          into
          <Inline value={dest.parent ?? plan.parent} label="Parent folder" disabled={busy} onChange={(v) => setDest({ ...dest, parent: v })} onEnter={onEnter} />
          <span className="text-muted-foreground/56">/</span>
          <Inline value={dest.folder ?? plan.folder} label="Folder" disabled={busy} onChange={(v) => setDest({ ...dest, folder: v })} onEnter={onEnter} />
          {plan.link && <span className="truncate">, then {plan.link.kind === "pr" ? `PR #${plan.link.n}` : `issue #${plan.link.n}`} as a worktree</span>}
        </span>
      );
      break;
    case "create":
      icon = <FolderPlusIcon />;
      line = (
        <>
          <b className="font-medium">Create</b> <Mono>{`${plan.parent}/${plan.folder}`}</Mono> <span className="shrink-0 text-muted-foreground">and git init {`on ${box}`}</span>
        </>
      );
      detail = <>A new repository with an empty first commit, ready for worktrees.</>;
      break;
    case "look":
      icon = <FolderOpenIcon />;
      tone = "text-muted-foreground";
      line = (
        <>
          <span>Inside</span> <Mono className="text-foreground">{short(plan.path)}</Mono> {on}
        </>
      );
      detail = <>A folder to look in: ↓ or Enter picks from what is in it, or keep typing.</>;
      break;
    case "blocked":
      icon = <TriangleAlertIcon />;
      tone = "text-warning-foreground";
      line = <span className="truncate">{plan.message}</span>;
      detail = <>Change what you typed, or browse the box.</>;
      break;
  }
  const ready = !!plan && plan.do !== "blocked" && plan.do !== "look";
  return (
    <div aria-live="polite" className={cn("flex h-15 items-center gap-3 rounded-lg px-1 transition-opacity", pending && plan && "opacity-56")}>
      <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/48 text-muted-foreground [&_svg]:size-4", ready && "text-foreground", tone)}>{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn("flex min-w-0 items-baseline gap-1.5 truncate text-sm", tone)}>{line}</p>
        <div className="min-w-0 truncate text-muted-foreground text-xs">{detail}</div>
      </div>
      <span className="flex w-6 shrink-0 justify-end">{pending ? <Spinner className="size-3.5 text-muted-foreground" /> : ready && target ? <Kbd>↵</Kbd> : null}</span>
    </div>
  );
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("min-w-0 truncate font-mono text-[12.5px]", className)}>{children}</span>;
}

// Inline is an editable piece of the plan's sentence: where a clone goes.
function Inline({ value, label, disabled, onChange, onEnter }: { value: string; label: string; disabled?: boolean; onChange(v: string): void; onEnter(): void }) {
  return (
    <input
      aria-label={label}
      value={value}
      disabled={disabled}
      spellCheck={false}
      size={Math.max(4, value.length)}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
      className="h-5 min-w-0 rounded border border-transparent border-b-border border-dashed bg-transparent px-1 font-mono text-[12px] text-foreground/88 outline-none hover:border-border focus:border-ring focus:border-solid"
    />
  );
}

function Rows({ rows, active, onHover, onPick }: { rows: Row[]; active: number; onHover(i: number): void; onPick(r: Row): void }) {
  let group = "";
  return (
    <div role="listbox" aria-label="Suggestions">
      {rows.map((r, i) => {
        const head = r.group !== group;
        group = r.group;
        return (
          <div key={r.key}>
            {head && <p className={cn("px-2.5 pt-1.5 pb-1 text-[11px] text-muted-foreground", i > 0 && "mt-1")}>{r.group}</p>}
            <button
              type="button"
              role="option"
              data-row={i}
              aria-selected={i === active}
              tabIndex={-1}
              onMouseMove={() => i !== active && onHover(i)}
              onClick={() => onPick(r)}
              className={cn("flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm", i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}
            >
              <RowIcon kind={r.kind} />
              <span className={cn("min-w-0 truncate", r.kind === "folder" && "text-muted-foreground")}>{r.title}</span>
              {r.detail && <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">{r.detail}</span>}
              {r.badge && <span className={cn("ms-auto shrink-0 rounded border px-1.5 text-[11px] text-muted-foreground", r.kind === "new" && "border-foreground/24 text-foreground")}>{r.badge}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function RowIcon({ kind }: { kind: Row["kind"] }) {
  const c = "size-4 shrink-0";
  if (kind === "new") return <FolderPlusIcon className={cn(c, "text-foreground")} />;
  if (kind === "repo") return <GitBranchIcon className={cn(c, "text-success")} />;
  if (kind === "project") return <CheckIcon className={cn(c, "text-muted-foreground")} />;
  if (kind === "elsewhere") return <ServerIcon className={cn(c, "text-muted-foreground")} />;
  return <FolderIcon className={cn(c, "text-muted-foreground/72")} />;
}

// Quiet fills the list when there is nothing to pick: what the box will do
// for a clone, or that nothing matched.
function Quiet({ intent, plan, box, pending }: { intent: string; plan?: Plan; box: string; pending: boolean }) {
  let text = pending ? `Looking on ${box}…` : `Nothing here matches on ${box}.`;
  if (!pending && plan?.do === "clone") text = `${box} clones it with its own git credentials, so private repositories work as they do in a terminal there.`;
  if (!pending && plan?.do === "open") text = `Nothing to clone: ${box} has it already.`;
  if (!pending && plan?.do === "blocked") text = `Browse ${box} to find the folder you mean.`;
  if (!pending && plan?.do === "look") text = `Nothing in ${plan.path} yet. Type a name after the slash to start a project there.`;
  if (!pending && intent === "empty") text = `No folders in ${box}'s home or ~/work yet. Type a name to start a project.`;
  return <p className="flex h-full items-center justify-center px-8 text-balance text-center text-[13px] text-muted-foreground">{text}</p>;
}

function Progress({ logs, busy }: { logs: Log[]; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);
  return (
    <div ref={ref} aria-live="polite" className="flex flex-col gap-2 p-2">
      {logs.length === 0 && busy && <p className="font-mono text-[12px] text-muted-foreground">Starting…</p>}
      {logs.map((l) => (
        <div key={l.box}>
          {logs.length > 1 && <p className="pb-0.5 font-medium text-[11px] text-muted-foreground">{l.box}</p>}
          <pre className="whitespace-pre-wrap font-mono text-[12px] text-muted-foreground leading-relaxed">{l.lines.join("\n")}</pre>
        </div>
      ))}
    </div>
  );
}

// Moored is the dialog's body when the chosen box is out of reach, the same
// height as the field, plan and list it stands in for.
function Moored({ box, others }: { box: string; others: boolean }) {
  return (
    <div className="flex h-[22.5rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-center">
      <Scene name="offline" width={136} className="mb-3" />
      <p className="font-medium text-sm">{box ? `${box} is offline` : "No box is online"}</p>
      <p className="max-w-xs text-balance text-muted-foreground text-xs">
        {others ? "Projects are added on a box that is online. Pick another above, or check on this one in Boxes." : "Projects are added on a box that is online. Check on your boxes in Settings."}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={() => {
          // Boxes is a page: the dialog goes, or it would sit over it.
          useStore.getState().closeAddLocation();
          useStore.getState().setView({ kind: "settings", section: "boxes" });
        }}
      >
        <ServerIcon />
        Open Boxes
      </Button>
    </div>
  );
}

// NoBoxes is the whole dialog when there is no box yet: a project lives on
// one, so it says so and offers the one way forward.
function NoBoxes({ onCancel }: { onCancel(): void }) {
  return (
    <>
      <StepHeader title="Add a project" description="Projects live on your boxes, and there isn't one yet." />
      <DialogPanel className="px-5 pt-1 pb-4">
        <div className="flex h-[22.5rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-8 text-center">
          {/* A quay with an empty hook: nothing loaded yet. */}
          <Scene name="dock" width={136} className="mb-3" />
          <p className="font-medium text-sm">Add a box first</p>
          <p className="max-w-xs text-balance text-muted-foreground text-xs">A box is any VPS or dev machine: projects and their agents run there. Add one, then add a project on it.</p>
        </div>
      </DialogPanel>
      <DialogFooter className="h-14 items-center gap-2 px-5 py-0">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          autoFocus
          onClick={() => {
            onCancel();
            openAddBox();
          }}
        >
          <ServerIcon />
          Add a box
        </Button>
      </DialogFooter>
    </>
  );
}

function Chip({ on, disabled, title, onClick, children }: { on: boolean; disabled?: boolean; title?: string; onClick(): void; children: React.ReactNode }) {
  const chip = (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors disabled:cursor-default",
        on ? "border-foreground/20 bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        disabled && !on && "opacity-56",
      )}
    >
      <span className={cn("size-1.5 rounded-full", on ? "bg-foreground" : "border border-muted-foreground/56")} />
      {children}
    </button>
  );
  return title ? <Tip label={title}>{chip}</Tip> : chip;
}
