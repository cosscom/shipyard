import { CopyIcon, LinkIcon, PackageIcon, PackagePlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Tip } from "@/components/tip";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { slug } from "@/lib/flows";
import { errorMessage } from "@/lib/format";
import { describeSource, type InstalledKit, type KitInfo, kitsApi } from "@/lib/kits";
import { useStore } from "@/lib/store";
import { openAddKit, openKit, reloadKits, useKitsData } from "@/views/kits/kits-store";
import { Section } from "@/views/project/parts";

// KitSection is the project's kit on this box: what it is, whether a newer
// version is kept on this laptop, and turning this project's own setup into
// a kit to apply elsewhere or share.

export function KitSection({ box, location, kit, onChanged }: { box: string; location: string; kit?: InstalledKit; onChanged(): void }) {
  const client = useStore((s) => s.client);
  const { kits } = useKitsData();
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const here = [{ box, location }];
  const kept = kit ? kits?.find((k) => k.id === kit.id) : undefined;
  const outdated = !!kit && !!kept && !!kit.hash && kept.hash !== kit.hash;

  const remove = async () => {
    if (!client) return;
    setBusy(true);
    try {
      await kitsApi.uninstall(client, { box, location });
      toastManager.add({ title: `Removed ${kit?.name} from ${location}`, description: "New worktrees no longer get it. Existing ones keep what they had.", type: "success" });
      onChanged();
      void reloadKits();
    } catch (err) {
      toastManager.add({ title: "Could not remove the kit", description: errorMessage(err), type: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="kit"
      title="Kit"
      description="A kit sets this project up the same way on every box. Its values show here with a Kit badge; anything set on this box still wins."
      actions={
        <Button size="xs" variant="ghost" onClick={() => setSaving(true)}>
          <SaveIcon />
          Save as a kit…
        </Button>
      }
    >
      {kit ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <PackageIcon className="size-4 text-violet-600 dark:text-violet-400" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 text-body">
              <span className="truncate text-row">{kit.name || kit.id}</span>
              {kit.version && <span className="font-mono text-tag text-muted-foreground">v{kit.version}</span>}
              {outdated && <span className="rounded-md border border-warning/30 px-1.5 text-tag text-warning-foreground">Newer version on this laptop</span>}
            </div>
            <Tip label={kit.source}>
              <p className="flex min-w-0 items-center gap-1 text-muted-foreground text-meta">
                <LinkIcon className="size-3 shrink-0" />
                <span className="truncate">{describeSource(kit.source)}</span>
                <span className="shrink-0">· applied {new Date(kit.installed_at).toLocaleDateString()}</span>
              </p>
            </Tip>
          </div>
          <Tip label={kept ? undefined : "This kit is not on this laptop. Add it to update."}>
            <Button size="xs" variant={outdated ? "default" : "outline"} disabled={!kept} onClick={() => openKit(kit.id, true, here)}>
              <RefreshCwIcon />
              {outdated ? "Update" : "Reapply"}
            </Button>
          </Tip>
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost">More</Button>} />
            <MenuPopup align="end" className="min-w-48">
              <MenuItem disabled={!kept} onClick={() => openKit(kit.id)}>
                <PackageIcon />
                Review the kit
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" disabled={busy} onClick={() => setConfirm(true)}>
                <Trash2Icon />
                Remove from this project…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3">
          <p className="min-w-0 flex-1 text-muted-foreground text-body">No kit. Apply one to set this project up like it is elsewhere.</p>
          <ApplyMenu kits={kits ?? []} onApply={(k) => openKit(k.id, true, here)} />
        </div>
      )}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {kit?.name} from {location}?</AlertDialogTitle>
            <AlertDialogDescription>New worktrees on {box} stop getting its setup, services and automations. Existing worktrees keep what they had.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" />} onClick={() => void remove()}>
              Remove
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <SaveKitDialog open={saving} onOpenChange={setSaving} box={box} location={location} existing={kit} />
    </Section>
  );
}

function ApplyMenu({ kits, onApply }: { kits: KitInfo[]; onApply(k: KitInfo): void }) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" />}>
        <PackagePlusIcon />
        Apply a kit
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        {kits.length > 0 && (
          <MenuGroup>
            <MenuGroupLabel>On this laptop</MenuGroupLabel>
            {kits.map((k) => (
              <MenuItem key={k.id} onClick={() => onApply(k)}>
                <PackageIcon />
                <span className="min-w-0 flex-1 truncate">{k.name}</span>
                {k.match?.slug && <span className="font-mono text-tag text-muted-foreground">{k.match.slug}</span>}
              </MenuItem>
            ))}
          </MenuGroup>
        )}
        {kits.length > 0 && <MenuSeparator />}
        <MenuItem onClick={openAddKit}>
          <LinkIcon />
          From a link…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function SaveKitDialog({ open, onOpenChange, box, location, existing }: { open: boolean; onOpenChange(open: boolean): void; box: string; location: string; existing?: InstalledKit }) {
  const client = useStore((s) => s.client);
  const [name, setName] = useState(existing?.name ?? `${location} setup`);
  const [id, setId] = useState<string>();
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<KitInfo>();
  const kitId = id ?? slug(name);

  const save = async () => {
    if (!client || !kitId) return;
    setBusy(true);
    try {
      const k = await kitsApi.save(client, { box, location, id: kitId, name, description: description || undefined });
      setSaved(k);
      void reloadKits();
    } catch (err) {
      toastManager.add({ title: "Could not save the kit", description: errorMessage(err), type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setSaved(undefined);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-lg">
        {saved ? (
          <>
            <DialogHeader>
              <DialogTitle>Saved {saved.name}</DialogTitle>
              <DialogDescription>It's on this laptop, ready to apply to {location} on your other boxes from Kits.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3 text-body">
              <p className="font-medium">To share it with your team</p>
              <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground text-meta">
                <li>Push this folder to a git repository, alone or as a folder in one:</li>
              </ol>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-mono">{saved.path}</code>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Copy the folder's path"
                  onClick={() => {
                    void navigator.clipboard.writeText(saved.path);
                    toastManager.add({ title: "Copied the path", type: "success" });
                  }}
                >
                  <CopyIcon />
                </Button>
              </div>
              <ol start={2} className="list-decimal space-y-1.5 pl-5 text-muted-foreground text-meta">
                <li>
                  Send them the repository's link, or a Shipyard link like <code className="font-mono">berth://kit?src=https://github.com/acme/kits/tree/main/{saved.id}</code>. Opening it in Shipyard
                  shows them everything the kit does before they apply it.
                </li>
                <li>Check its environment for secrets before you push: the kit carries this box's values.</li>
              </ol>
            </DialogPanel>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  close(false);
                  useStore.getState().setView({ kind: "kits" });
                }}
              >
                Open Kits
              </Button>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Save this project's setup as a kit</DialogTitle>
              <DialogDescription>
                What {box} adds over the repository's config{existing ? `, including the ${existing.name} kit` : ""}: setup and teardown, environment, ports, services, automations, agents,
                and the kit's files.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <label className="block space-y-1">
                <span className="text-muted-foreground text-meta">Name</span>
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block space-y-1">
                <span className="text-muted-foreground text-meta">Id</span>
                <Input value={kitId} onChange={(e) => setId(slug(e.target.value))} className="font-mono text-mono" />
              </label>
              <label className="block space-y-1">
                <span className="text-muted-foreground text-meta">Description</span>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Each worktree gets its own database and dev server." className="min-h-16" />
              </label>
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button disabled={!kitId || !name.trim()} loading={busy} onClick={() => void save()}>
                Save kit
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
