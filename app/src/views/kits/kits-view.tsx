import { CopyIcon, EllipsisIcon, LinkIcon, PackageIcon, PackagePlusIcon, PuzzleIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Scene } from "@/components/art/scenes";
import { Tip } from "@/components/tip";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { describeSource, type InstalledKitOn, type KitInfo, kitLink, kitSrcFromLink, kitsApi } from "@/lib/kits";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { kitCounts } from "@/views/kits/kit-summary";
import { openKit, openKitLink, reloadKits, useKits, useKitsData } from "@/views/kits/kits-store";
import { ViewHeader } from "@/views/view-header";
import { ErrorText } from "@/components/error-note";

// KitsView lists the kits on this laptop: how a project is set up, ready to
// apply to the same project on any box, or to share with a link.

export function KitsView() {
  const { kits, installed, error } = useKitsData();
  const adding = useKits((s) => s.adding);
  const setAdding = (v: boolean) => useKits.setState({ adding: v });

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Kits"
        description="Set a project up the same way on every box, and share it with a link."
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <PackagePlusIcon />
            Add from link
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 pt-7 pb-24">
          {error && <ErrorText className="mb-4 rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-destructive-foreground text-body" text={error} />}
          {!kits && !error && (
            <div className="grid gap-3 md:grid-cols-2">
              <Skeleton className="h-40 rounded-2xl" />
              <Skeleton className="h-40 rounded-2xl" />
            </div>
          )}
          {kits?.length === 0 && (
            <Empty className="rounded-2xl border border-dashed py-14">
              <EmptyHeader>
                <EmptyMedia>
                  <Scene name="dock" />
                </EmptyMedia>
                <EmptyTitle>No kits yet</EmptyTitle>
                <EmptyDescription>
                  A kit is how a project is set up: its setup and teardown, environment, services, automations and the scripts they use. Add one someone shared, or save a
                  project's setup as a kit from its Project settings.
                </EmptyDescription>
              </EmptyHeader>
              <Button size="sm" onClick={() => setAdding(true)}>
                <PackagePlusIcon />
                Add from link
              </Button>
            </Empty>
          )}
          {kits && kits.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {kits.map((k) => (
                <KitCard key={k.id} kit={k} installed={(installed ?? []).filter((i) => i.kit.id === k.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
      <AddFromLinkDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function KitCard({ kit, installed }: { kit: KitInfo; installed: InstalledKitOn[] }) {
  const client = useStore((s) => s.client);
  const [confirm, setConfirm] = useState(false);
  const [updating, setUpdating] = useState(false);
  const plugin = kit.origin.startsWith("plugin:") ? kit.origin.slice(7) : undefined;
  const outdated = installed.filter((i) => i.outdated).length;

  const update = async () => {
    if (!client) return;
    setUpdating(true);
    try {
      const r = await kitsApi.update(client, kit.id);
      toastManager.add({
        title: r.changed ? `Updated ${kit.name}` : `${kit.name} is up to date`,
        description: r.changed && installed.length ? "Apply it again to bring projects up to date." : undefined,
        type: "success",
      });
      void reloadKits();
    } catch (err) {
      toastManager.add({ title: "Could not update the kit", description: errorMessage(err), type: "error" });
    } finally {
      setUpdating(false);
    }
  };

  const remove = async () => {
    if (!client) return;
    try {
      await kitsApi.remove(client, kit.id);
      void reloadKits();
    } catch (err) {
      toastManager.add({ title: "Could not remove the kit", description: errorMessage(err), type: "error" });
    }
  };

  const copyLink = () => {
    if (!kit.source?.src) return;
    void navigator.clipboard.writeText(kitLink(kit.source.src));
    toastManager.add({ title: "Copied the kit's link", description: "Anyone with Shipyard can open it to review the kit and apply it.", type: "success" });
  };

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <button type="button" onClick={() => openKit(kit.id)} className="block w-full px-4 pt-3.5 pb-3 text-left hover:bg-accent/30">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40">
            <PackageIcon className="size-3.5 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-row">{kit.name}</span>
              {kit.version && <span className="shrink-0 font-mono text-meta text-muted-foreground">v{kit.version}</span>}
            </div>
            <p className="line-clamp-3 text-desc text-muted-foreground">{kit.description || kitCounts(kit)}</p>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-tag text-muted-foreground">
          {kit.match?.slug && <span className="rounded-md border px-1.5 py-px font-mono">for {kit.match.slug}</span>}
          <Tip label={kit.source?.src}>
            <span className="flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-px">
              {plugin ? <PuzzleIcon className="size-3" /> : <LinkIcon className="size-3" />}
              <span className="truncate">{plugin ? `${plugin} plugin` : describeSource(kit.source?.src)}</span>
            </span>
          </Tip>
        </div>
        {kit.description && <p className="mt-2 text-meta text-muted-foreground/80">{kitCounts(kit)}</p>}
      </button>

      <div className="flex items-center gap-2 border-t bg-muted/20 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {installed.length === 0 ? (
            <span className="text-meta text-muted-foreground">Not applied yet</span>
          ) : (
            installed.map((i) => (
              <Tip key={`${i.box}/${i.location}`} label={`${i.outdated ? "Has an older version of this kit" : "Has this kit"}. Open its project settings`}>
                <button
                  type="button"
                  onClick={() => useStore.getState().setView({ kind: "project", box: i.box, location: i.location })}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-tag hover:bg-accent",
                    i.outdated ? "border-warning/30 text-warning-foreground" : "text-foreground/80",
                  )}
                >
                  {i.location}
                  <span className="text-muted-foreground">· {i.box}</span>
                  {i.outdated && <span>· older</span>}
                </button>
              </Tip>
            ))
          )}
        </div>
        <Button size="xs" variant={outdated ? "default" : "outline"} onClick={() => openKit(kit.id, true)}>
          {outdated ? `Update ${outdated === 1 ? "1 project" : `${outdated} projects`}` : "Apply to…"}
        </Button>
        <Menu>
          <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`${kit.name} options`} />}>
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-48">
            <MenuItem onClick={() => openKit(kit.id)}>
              <PackageIcon />
              Review
            </MenuItem>
            {kit.source?.src && (
              <>
                <MenuItem onClick={copyLink}>
                  <CopyIcon />
                  Copy link
                </MenuItem>
                <MenuItem disabled={updating} onClick={() => void update()}>
                  <RefreshCwIcon />
                  Update from its link
                </MenuItem>
              </>
            )}
            {kit.origin === "user" && (
              <>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => setConfirm(true)}>
                  <Trash2Icon />
                  Remove from this laptop…
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {kit.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is forgotten on this laptop.{" "}
              {installed.length ? `The ${installed.length === 1 ? "project that has it keeps it" : `${installed.length} projects that have it keep it`} until you remove it there.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" />} onClick={() => void remove()}>
              Remove
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Card>
  );
}

function AddFromLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [value, setValue] = useState("");
  const src = kitSrcFromLink(value);
  const submit = () => {
    if (!src) return;
    onOpenChange(false);
    setValue("");
    openKitLink(src);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a kit from a link</DialogTitle>
          <DialogDescription>You see everything it does before anything is kept or run.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="berth://kit?src=…  or  https://github.com/acme/kits/tree/main/shop"
            className="font-mono text-mono"
          />
          <p className="text-desc text-muted-foreground">
            A Shipyard kit link, a git repository (a folder in it with <code className="font-mono">…/tree/main/dir</code> or <code className="font-mono">URL#dir</code>), a gist, a URL to a{" "}
            <code className="font-mono">kit.json</code>, or a folder on this laptop.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!src} onClick={submit}>
            Review
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
