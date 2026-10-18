import { ArrowRightIcon, ChevronRightIcon, FolderGit2Icon, FolderOpenIcon, FolderPlusIcon, GitForkIcon, SparklesIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { CloneForm } from "@/components/add-project/clone-form";
import { CreateForm } from "@/components/add-project/create-form";
import { FolderBrowser } from "@/components/add-project/folder-browser";
import { StepHeader } from "@/components/step-header";
import { Button } from "@/components/ui/button";
import type { Location } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { useIsLocalBox } from "@/lib/local-box";
import { NONE, useStore } from "@/lib/store";
import { thisComputer } from "@/lib/platform";

type Way = "browse" | "clone" | "create";

const wayTitles: Record<Way, string> = { browse: "Browse folders", clone: "Clone from URL", create: "Create a new project" };
// On this Mac's own box (Use this Mac) the folders are this Mac's.
const wayDetails = (box: string, local: boolean): Record<Way, string> => ({
  browse: local ? thisComputer("A repository already on this Mac, from your own folders") : `A repository already cloned on ${box}`,
  clone: local ? thisComputer("GitHub, GitLab or any git remote, cloned onto this Mac") : "GitHub, GitLab or any git remote, cloned by the box",
  create: "An empty repository, ready for worktrees",
});

// The sample project boxes make (examples/hello), and what it is.
export const SAMPLE = "hello";

// RepoStep adds the first project on the new box: the sample project, the
// quickest way to a first agent, then the same three ways the Add a
// project dialog offers: a repository already there, a clone, or a new
// empty one. A box that already has projects can go straight on. Skipping
// is the page's "Skip setup", beside the progress.
export function RepoStep({ box, onDone }: { box: string; onDone(location: string, sample?: boolean): void }) {
  const existing = useStore((s) => s.boxes[box]?.locations ?? NONE);
  const local = useIsLocalBox(box);
  const where = local ? thisComputer("this Mac") : box;
  const [way, setWay] = useState<Way>();
  // A box just paired may not have said what it can do yet.
  const caps = useStore((s) => s.boxes[box]?.info?.capabilities);
  useEffect(() => {
    void useStore.getState().refreshBox(box, ["info", "locations"]);
  }, [box]);
  const canSample = caps ? caps.includes("sample") : undefined;
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string>();
  const sample = async () => {
    if (existing.some((l) => l.name === SAMPLE)) return onDone(SAMPLE, true);
    const client = useStore.getState().client;
    if (!client) return;
    setMaking(true);
    setError(undefined);
    try {
      const loc = await client.box<Location>(box, "POST", "locations/new", { sample: SAMPLE });
      await useStore.getState().refreshBox(box, ["locations"]);
      onDone(loc.name, true);
    } catch (err) {
      setError(plainError(err, { box }));
      setMaking(false);
    }
  };

  const added = async (loc: Location) => {
    await useStore.getState().refreshBox(box, ["locations"]);
    onDone(loc.name);
  };

  return (
    <div>
      <StepHeader
        variant="page"
        title={way ? wayTitles[way] : `Add a project on ${where}`}
        description={
          way ? wayDetails(box, local)[way] : `A git repository on ${local ? thisComputer("this Mac") : "the box"}. Each piece of work gets its own worktree beside it, so agents never trip over each other.`
        }
        onBack={way ? () => setWay(undefined) : undefined}
      />

      {way ? (
        <div className="mt-6">
          {/* The Add a project forms, in a frame shaped like their dialog. */}
          <div data-slot="dialog-popup" className="overflow-hidden rounded-2xl border bg-popover pt-1">
            {way === "browse" && <FolderBrowser box={box} onAdded={added} />}
            {way === "clone" && <CloneForm box={box} onAdded={added} onCancel={() => setWay(undefined)} />}
            {way === "create" && <CreateForm box={box} onAdded={added} onCancel={() => setWay(undefined)} />}
          </div>
        </div>
      ) : (
        <>
          {existing.length > 0 && (
            <div className="mt-6">
              <div className="mb-2 text-muted-foreground text-meta">Already on {where}</div>
              <ul className="divide-y divide-border/70 rounded-xl border">
                {existing.map((l) => (
                  <li key={l.name} className="flex items-center gap-3 px-3.5 py-2.5">
                    <FolderGit2Icon className="size-4 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-row">{l.name}</div>
                      <div className="truncate font-mono text-tag text-muted-foreground">{l.path}</div>
                    </div>
                    <Button size="xs" variant="outline" onClick={() => onDone(l.name)}>
                      Use this
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canSample !== false && (
            <section aria-labelledby="sample-heading" className="mt-6 rounded-xl border border-foreground/20 bg-card px-4 py-3.5">
              <div className="flex items-center gap-4">
                <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
                  <SparklesIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 id="sample-heading" className="text-row">
                    Try the sample project
                  </h2>
                  <p className="mt-0.5 text-muted-foreground text-meta">
                    <span className="font-mono">hello</span>: a tiny Node web server and its test, made in ~/work/hello on {where}. A good size for a first task.
                  </p>
                </div>
                <Button autoFocus={existing.length === 0} className="shrink-0" disabled={canSample === undefined} loading={making} onClick={() => void sample()}>
                  Use the sample <ArrowRightIcon />
                </Button>
              </div>
              {error && <p className="mt-2 ps-13 text-destructive-foreground text-meta">{error}</p>}
            </section>
          )}
          <div className="mt-6 space-y-2">
            <div className="text-muted-foreground text-meta">{existing.length > 0 ? "Or add another" : canSample !== false ? "Or one of your own" : "Add one"}</div>
            <WayButton icon={<FolderOpenIcon />} title={wayTitles.browse} detail={wayDetails(box, local).browse} onClick={() => setWay("browse")} />
            <WayButton icon={<GitForkIcon />} title={wayTitles.clone} detail={wayDetails(box, local).clone} onClick={() => setWay("clone")} />
            <WayButton icon={<FolderPlusIcon />} title={wayTitles.create} detail={wayDetails(box, local).create} onClick={() => setWay("create")} />
          </div>
        </>
      )}
    </div>
  );
}

function WayButton({ icon, title, detail, onClick }: { icon: ReactNode; title: string; detail: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-xl border bg-card/40 px-4 py-3 text-left outline-none transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-row">{title}</span>
        <span className="mt-0.5 block truncate text-muted-foreground text-meta">{detail}</span>
      </span>
      <ChevronRightIcon className="size-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
