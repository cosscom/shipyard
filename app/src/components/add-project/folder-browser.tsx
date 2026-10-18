import { ArrowUpIcon, FolderIcon, GitBranchIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { shortPath, uniqueName } from "@/components/add-project/unique-name";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogPanel } from "@/components/ui/dialog";
import { Frame, FramePanel } from "@/components/ui/frame";
import type { Location } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { type FsEntry, type FsListing, projectsApi } from "@/lib/projects";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ErrorText } from "@/components/error-note";

// FolderBrowser walks the box's folders. Git repositories are marked; Enter
// on one adds it. Any folder can be added, though only git ones get
// worktrees. Typing a path in the field jumps there.
export function FolderBrowser({ box, start, onAdded }: { box: string; start?: string; onAdded(loc: Location): Promise<void> }) {
  const [listing, setListing] = useState<FsListing>();
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    async (path: string, fallback?: string) => {
      const client = useStore.getState().client;
      if (!client) return;
      setLoading(true);
      setError(undefined);
      try {
        const l = await projectsApi.list(client, box, path);
        setListing(l);
        setTyped(shortPath(l.path, l.home));
        setActive(l.entries.length ? 0 : -1);
      } catch (err) {
        if (fallback) return go(fallback);
        setError(plainError(err));
      } finally {
        setLoading(false);
      }
    },
    [box],
  );

  // Start where the field pointed, else ~/work, where projects usually
  // live; home when it is not there.
  useEffect(() => {
    void (start ? go(start, "~/work") : go("~/work", "~"));
    // Only where it starts; browsing moves on from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const entries = listing?.entries ?? [];
  const selected: FsEntry | undefined = entries[active];
  // What Add adds: the selected folder, or the one being shown.
  const target: FsEntry | undefined = selected ?? (listing ? { name: listing.path.split("/").pop() ?? "", path: listing.path } : undefined);

  const projects = useStore((st) => st.boxes[box]?.locations);
  const existing = (e?: FsEntry) => (e ? projects?.find((l) => l.path === e.path) : undefined);

  const add = async (e: FsEntry) => {
    const client = useStore.getState().client;
    if (!client || adding) return;
    // Already a project: open it rather than add it twice.
    const known = existing(e);
    if (known) return onAdded(known);
    setAdding(true);
    setError(undefined);
    try {
      const loc = await projectsApi.add(client, box, uniqueName(box, e.name), e.path);
      await onAdded(loc);
    } catch (err) {
      setError(plainError(err));
      setAdding(false);
    }
  };

  const open = (e: FsEntry) => (e.git ? void add(e) : void go(e.path));

  const crumbs = listing ? crumbsFor(listing) : [];

  return (
    <>
      <DialogPanel className="flex flex-col gap-2 px-5 pb-5">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" aria-label="Up a folder" disabled={!listing?.parent} onClick={() => listing?.parent && void go(listing.parent)}>
            <ArrowUpIcon />
          </Button>
          <input
            autoFocus
            value={typed}
            spellCheck={false}
            aria-label="Path"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, entries.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const here = listing ? shortPath(listing.path, listing.home) : "";
                if (typed.trim() && typed.trim() !== here) void go(typed.trim());
                else if (selected) open(selected);
              }
            }}
            className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-desc shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 sm:h-8 dark:bg-input/32"
          />
        </div>
        <Frame className="rounded-xl p-0.5">
          <nav aria-label="Folder" className="flex h-7 min-w-0 items-center gap-1 overflow-hidden px-2.5 text-muted-foreground text-meta">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex min-w-0 items-center gap-1">
                {i > 0 && <span className="text-muted-foreground/48">/</span>}
                <button type="button" onClick={() => void go(c.path)} className={cn("truncate hover:text-foreground", i === crumbs.length - 1 && "font-medium text-foreground")}>
                  {c.label}
                </button>
              </span>
            ))}
            {loading && listing && <LoaderIcon className="ml-auto size-3 shrink-0 animate-spin" />}
          </nav>
          <FramePanel className="rounded-[10px] p-0 shadow-none before:hidden dark:bg-input/32">
            <div ref={listRef} role="listbox" aria-label="Folders" className="h-64 overflow-y-auto p-1">
              {loading && !listing ? (
                <p className="flex items-center gap-2 px-2.5 py-2 text-desc text-muted-foreground">
                  <LoaderIcon className="size-3.5 animate-spin" /> Reading {box}…
                </p>
              ) : entries.length === 0 ? (
                <p className="px-2.5 py-2 text-desc text-muted-foreground">No folders here.</p>
              ) : (
                entries.map((e, n) => (
                  <button
                    key={e.path}
                    type="button"
                    role="option"
                    data-index={n}
                    aria-selected={n === active}
                    onClick={() => setActive(n)}
                    onDoubleClick={() => open(e)}
                    className={cn("flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body", n === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}
                  >
                    {e.git ? <GitBranchIcon className="size-4 shrink-0 text-success" /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 truncate">{e.name}</span>
                    <span className="ml-auto flex min-w-0 shrink items-center gap-2">
                      {e.slug && <span className="min-w-0 truncate font-mono text-muted-foreground text-mono">{e.slug}</span>}
                      {existing(e) && <span className="shrink-0 rounded border px-1.5 text-tag text-muted-foreground">added</span>}
                    </span>
                  </button>
                ))
              )}
            </div>
          </FramePanel>
        </Frame>
        {target && !target.git && !existing(target) && (
          <p className="flex items-center gap-1.5 text-muted-foreground text-meta">
            <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
            {target.name || "This folder"} is not a git repository: it can be a project, but worktrees need git.
          </p>
        )}
        {error && <ErrorText className="text-destructive text-body" text={error} />}
      </DialogPanel>
      <DialogFooter className="items-center px-5 py-3 sm:justify-between">
        <span className="min-w-0 truncate text-desc text-muted-foreground">↵ opens a folder or adds a repository</span>
        <Button className="shrink-0" loading={adding} disabled={!target || loading} onClick={() => target && void add(target)}>
          {existing(target) ? "Go to" : "Add"} {target?.name ? <span className="max-w-40 truncate">{target.name}</span> : "this folder"}
        </Button>
      </DialogFooter>
    </>
  );
}

function crumbsFor(l: FsListing): { label: string; path: string }[] {
  const underHome = l.path === l.home || l.path.startsWith(`${l.home}/`);
  const root = underHome ? l.home : "";
  const rest = (underHome ? l.path.slice(l.home.length) : l.path).split("/").filter(Boolean);
  const out = [{ label: underHome ? "~" : "/", path: underHome ? l.home : "/" }];
  let at = root;
  for (const part of rest) {
    at = `${at}/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}
