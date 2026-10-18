import { AlertTriangleIcon, GitCommitHorizontalIcon, LinkIcon, PackageIcon, PuzzleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { describeSource, type KitInfo, type KitTarget, kitsApi } from "@/lib/kits";
import { useStore } from "@/lib/store";
import { KitSummary } from "@/views/kits/kit-summary";
import { closeReview, reloadKits, useKits } from "@/views/kits/kits-store";
import { matchingTargets, ProjectPicker, type TargetResult, targetKey } from "@/views/kits/project-picker";
import { Tip } from "@/components/tip";
import { ErrorText } from "@/components/error-note";

// ReviewSheet shows everything a kit does before it runs anywhere: a kit
// from a link, which is only kept once added, or one already kept here. Then
// it applies the kit to the projects picked, showing each one's result.

export function ReviewSheet() {
  const review = useKits((s) => s.review);
  // Focus the sheet itself as it opens, not its close button, where Enter
  // would close it before it was read.
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={!!review} onOpenChange={(open) => !open && closeReview()}>
      <SheetPopup ref={popup} initialFocus={popup} className="w-[min(640px,100vw)] max-w-none outline-none">{review && <ReviewBody key={review.kind === "link" ? review.src : review.id} />}</SheetPopup>
    </Sheet>
  );
}

function ReviewBody() {
  const review = useKits((s) => s.review)!;
  const installed = useKits((s) => s.installed) ?? [];
  const client = useStore((s) => s.client);
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const [kit, setKit] = useState<KitInfo>();
  const [replaces, setReplaces] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, TargetResult>>({});
  const [busy, setBusy] = useState<"adding" | "applying">();
  const [kept, setKept] = useState(review.kind === "kit");
  const picked = useRef(false);
  const applyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!client) return;
    const load = review.kind === "link" ? kitsApi.preview(client, review.src).then((r) => (setReplaces(r.replaces), r.kit)) : kitsApi.get(client, review.id);
    load.then(setKit, (err) => setError(plainError(err)));
    if (!useKits.getState().installed) void reloadKits();
  }, [client, review]);

  // Projects of the kit's repository start selected, once.
  const online = useMemo(() => (status?.boxes ?? []).filter((b) => b.state === "online").map((b) => b.name), [status]);
  useEffect(() => {
    if (!kit || picked.current) return;
    const m = review.select ?? matchingTargets(kit.match?.slug, boxes, online);
    if (review.select || m.length || online.every((b) => boxes[b]?.locations)) {
      picked.current = true;
      setSelected(new Set(m.map(targetKey)));
    }
  }, [kit, boxes, online, review]);

  useEffect(() => {
    if (kit && review.kind === "kit" && review.apply) applyRef.current?.scrollIntoView({ block: "start" });
  }, [kit, review]);

  const targets: KitTarget[] = [...selected].map((k) => {
    const [box, ...rest] = k.split("/");
    return { box, location: rest.join("/") };
  });
  const done = Object.values(results).length > 0 && Object.values(results).every((r) => r.state !== "applying");

  const add = async (): Promise<KitInfo | undefined> => {
    if (!client || review.kind !== "link") return kit;
    setBusy("adding");
    try {
      // Keep exactly what was reviewed: the agent refuses a link whose
      // content changed since the preview.
      const k = await kitsApi.add(client, review.src, kit?.hash ?? "");
      setKit((prev) => ({ ...k, file_list: prev?.file_list ?? k.file_list }));
      setKept(true);
      void reloadKits();
      return k;
    } catch (err) {
      toastManager.add({ title: "Could not add the kit", description: errorMessage(err), type: "error" });
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const apply = async () => {
    if (!client || !kit) return;
    const k = kept ? kit : await add();
    if (!k || !targets.length) return;
    setBusy("applying");
    setResults(Object.fromEntries(targets.map((t) => [targetKey(t), { state: "applying" } as TargetResult])));
    try {
      const end = await kitsApi.apply(
        client,
        k.id,
        targets,
        (l) => {
          if (!l.box || !l.location) return;
          const key = targetKey({ box: l.box, location: l.location });
          setResults((r) => ({ ...r, [key]: l.error ? { state: "failed", error: l.error } : { state: "applied", warnings: l.warnings ?? [] } }));
        },
        undefined,
        kit.hash,
      );
      const n = end.applied ?? 0;
      toastManager.add({
        title: end.error ? `Applied ${k.name} to ${n} of ${targets.length}` : `Applied ${k.name} to ${n === 1 ? "1 project" : `${n} projects`}`,
        description: end.error ? "See the failed projects in the sheet." : "New worktrees there get it. Existing ones keep what they had until recreated.",
        type: end.error ? "warning" : "success",
      });
      void reloadKits();
    } catch (err) {
      toastManager.add({ title: "Could not apply the kit", description: errorMessage(err), type: "error" });
    } finally {
      setBusy(undefined);
    }
  };

  const plugin = kit?.origin?.startsWith("plugin:") ? kit.origin.slice(7) : undefined;
  const src = kit?.source?.src ?? (review.kind === "link" ? review.src : undefined);

  return (
    <>
      <SheetHeader className="border-b pb-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <PackageIcon className="size-4.5 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <SheetTitle className="flex items-baseline gap-2">
              {kit ? kit.name : review.kind === "link" ? "Reviewing a kit" : review.id}
              {kit?.version && <span className="font-normal font-mono text-meta text-muted-foreground">v{kit.version}</span>}
            </SheetTitle>
            <SheetDescription>{kit ? kit.description || "No description." : "Fetching it to show you what it does…"}</SheetDescription>
            {kit && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
                {plugin ? (
                  <span className="flex items-center gap-1">
                    <PuzzleIcon className="size-3" /> From the {plugin} plugin
                  </span>
                ) : (
                  <Tip label={src}>
                    <span className="flex min-w-0 items-center gap-1">
                      <LinkIcon className="size-3 shrink-0" />
                      <span className="truncate">{describeSource(src)}</span>
                    </span>
                  </Tip>
                )}
                {kit.source?.commit && (
                  <span className="flex items-center gap-1 font-mono">
                    <GitCommitHorizontalIcon className="size-3" />
                    {kit.source.commit.slice(0, 7)}
                  </span>
                )}
                {kit.match?.slug && <span className="rounded-md border px-1.5 font-mono text-tag">for {kit.match.slug}</span>}
              </div>
            )}
          </div>
        </div>
      </SheetHeader>

      <SheetPanel className="space-y-6">
        {error && <ErrorText className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-destructive-foreground text-body" text={error} />}
        {!kit && !error && (
          <div className="space-y-3">
            <Skeleton className="h-20 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
          </div>
        )}
        {kit && (
          <>
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning/6 px-3 py-2.5 text-desc">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
              <p>
                <span className="font-medium">Its scripts run on the boxes you apply it to,</span> as you, in every new worktree of those projects. Read them below
                {plugin ? "" : " and only apply kits from people you trust"}.
                {replaces && review.kind === "link" && " Adding it replaces the kit with the same id on this laptop."}
              </p>
            </div>
            <KitSummary kit={kit} />
            <section ref={applyRef} className="scroll-mt-4">
              <h3 className="mb-1 text-section">Apply to</h3>
              <p className="mb-2.5 text-desc text-muted-foreground">
                {kit.match?.slug ? `Projects of ${kit.match.slug} are picked. ` : ""}A project has one kit; applying replaces the one it has.
              </p>
              <ProjectPicker kitId={kit.id} slug={kit.match?.slug} selected={selected} onChange={setSelected} results={results} installed={installed} disabled={!!busy} />
            </section>
          </>
        )}
      </SheetPanel>

      <SheetFooter className="flex-row items-center justify-between gap-2 border-t">
        <span className="text-meta text-muted-foreground">{targets.length ? `${targets.length} ${targets.length === 1 ? "project" : "projects"} picked` : kept ? "Kept on this laptop" : "Nothing is kept until you add it"}</span>
        <div className="flex gap-2">
          {done ? (
            <Button size="sm" onClick={closeReview}>
              Done
            </Button>
          ) : (
            <>
              {!kept && (
                <Button size="sm" variant="outline" disabled={!kit || !!busy} loading={busy === "adding"} onClick={() => void add().then((k) => k && !targets.length && closeReview())}>
                  Add without applying
                </Button>
              )}
              <Button size="sm" disabled={!kit || !targets.length || !!busy} loading={busy === "applying"} onClick={() => void apply()}>
                {kept ? "Apply" : "Add and apply"}
                {targets.length ? ` to ${targets.length}` : ""}
              </Button>
            </>
          )}
        </div>
      </SheetFooter>
    </>
  );
}
