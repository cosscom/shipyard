import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { SimpleSelect } from "@/components/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { BoxError } from "@/components/upgrade-box";
import { boxApi, type SecretMeta, type SecretSettings, type SecretsList, type SecretStore } from "@/lib/api";
import { useEventLog } from "@/lib/events";
import { sessionName } from "@/lib/derive";
import { ago, errorMessage } from "@/lib/format";
import { deleteConfirm, environmentLabel, expiresLine, isProduction, needsTypedName, storeLine } from "@/lib/secret-request";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Code, SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

// Settings › Secrets: per box, the secrets agents asked for and the person
// saved (berthd secret request), by name, where they are and who asked;
// never a value, which never comes back from the box. Delete one (a
// production one only with its name typed), and choose where a box saves
// them: its default store, and a project's own.
export function SecretsSection() {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const online = boxes.filter((b) => b.state === "online");
  return (
    <SettingsPage
      title="Secrets"
      description={
        <>
          What agents asked you for with <Code>berthd secret request</Code>, kept on each box. Agents get a reference, never the value, and nothing here shows one.
        </>
      }
    >
      {online.length === 0 ? <p className="rounded-xl border px-4 py-6 text-center text-muted-foreground text-body">No box is online. Its secrets are listed once it connects.</p> : online.map((b) => <BoxSecrets key={b.name} box={b.name} />)}
    </SettingsPage>
  );
}

function BoxSecrets({ box }: { box: string }) {
  const client = useStore((s) => s.client);
  const [list, setList] = useState<SecretsList | { error: string }>();
  // Saved or deleted anywhere (a card, another window, the CLI): read again.
  const changed = useEventLog((s) => s.events.find((e) => e.box === box && /^secret\.(saved|deleted)$/.test(e.type))?.time);
  const load = useCallback(() => {
    if (!client) return;
    boxApi.secrets(client, box).then(
      (l) => setList(l),
      (err) => setList({ error: errorMessage(err) }),
    );
  }, [client, box]);
  useEffect(load, [load, changed]);

  if (!list) {
    return (
      <SettingsGroup title={box}>
        <SettingsRow label="Reading its secrets…" />
      </SettingsGroup>
    );
  }
  if ("error" in list) {
    return (
      <SettingsGroup title={box}>
        <div className="py-4">
          <BoxError box={box} error={list.error} what="secrets" />
        </div>
      </SettingsGroup>
    );
  }
  const secrets = list.secrets ?? [];
  const stores = list.stores ?? [];
  return (
    <div data-testid={`secrets-${box}`} className="space-y-6">
      <SettingsGroup title={box} description={secrets.length ? `${secrets.length} saved` : undefined}>
        {list.errors?.map((e) => (
          <p key={`${e.store}|${e.where ?? ""}`} data-testid="secrets-error" role="alert" className="py-3 text-destructive-foreground text-desc">
            Couldn't list {storeLine({ store: e.store, store_label: stores.find((s) => s.id === e.store)?.label ?? e.store, where: e.where })}: {e.error}
          </p>
        ))}
        {secrets.length === 0 ? (
          <SettingsRow label="No secrets yet" description="An agent asks with berthd secret request; what you save shows here." />
        ) : (
          secrets.map((s) => <SecretRow key={s.ref} box={box} s={s} onDeleted={load} />)
        )}
      </SettingsGroup>
      <WhereSaved box={box} stores={stores} settings={list.settings} onSaved={load} />
    </div>
  );
}

// SecretRow is one saved secret: its name and facts, and Delete.
function SecretRow({ box, s, onDeleted }: { box: string; s: SecretMeta; onDeleted(): void }) {
  const [asking, setAsking] = useState(false);
  // Who asked, by its work's name while the box still has it.
  const sessions = useStore((st) => st.boxes[box]?.sessions);
  const asker = s.session ? sessions?.find((x) => x.name === s.session) : undefined;
  const who = asker ? sessionName(asker, { sessions, agent: true }) : (s.session ?? "an agent");
  const prod = isProduction(s);
  const facts = [storeLine(s), `Expires: ${expiresLine(s.expires).toLowerCase()}`, s.created ? `Saved ${ago(s.created)}` : undefined].filter(Boolean).join(" · ");
  return (
    <div data-testid="secret-row" data-name={s.name} data-environment={s.environment} className="flex min-h-14 items-center gap-6 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-mono text-row">{s.name}</span>
          {s.environment && (
            <Badge variant={prod ? "warning" : "secondary"} size="sm" data-testid="secret-row-environment">
              {environmentLabel(s)}
            </Badge>
          )}
        </div>
        <div className={cn("mt-0.5 text-desc", prod ? "text-warning-foreground" : "text-muted-foreground")}>{facts}</div>
        {(s.session || s.reason) && (
          <div className="mt-0.5 text-muted-foreground text-meta">
            Asked by {who}
            {s.location && ` in ${s.location}`}
            {s.reason && <span className="text-foreground/80">: {s.reason}</span>}
          </div>
        )}
      </div>
      <Button size="xs" variant="outline" data-testid="secret-row-delete" aria-label={`Delete ${s.name}`} onClick={() => setAsking(true)}>
        <Trash2Icon />
        Delete
      </Button>
      <DeleteSecret box={box} s={s} open={asking} onOpenChange={setAsking} onDeleted={onDeleted} />
    </div>
  );
}

// DeleteSecret asks first; a production secret also wants its name typed,
// which goes to the box as confirm.
function DeleteSecret({ box, s, open, onOpenChange, onDeleted }: { box: string; s: SecretMeta; open: boolean; onOpenChange(o: boolean): void; onDeleted(): void }) {
  const client = useStore((st) => st.client);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) {
      setTyped("");
      setError(undefined);
    }
  }, [open]);
  const confirm = deleteConfirm(s, typed);
  const go = async () => {
    if (!client || confirm === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await boxApi.deleteSecret(client, box, s.ref, needsTypedName(s) ? confirm : undefined);
      onOpenChange(false);
      toastManager.add({ type: "success", title: `Deleted ${s.name}`, description: storeLine(s) });
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup data-testid="secret-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {s.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It goes from {storeLine(s)} on {box}. Agents that use <Code>{s.ref}</Code> can't read it any more.
            {needsTypedName(s) && " It is a production secret: type its name to delete it."}
          </AlertDialogDescription>
          {needsTypedName(s) && (
            <Input
              size="sm"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={s.name}
              aria-label={`Type ${s.name} to delete it`}
              data-testid="secret-delete-confirm"
              className="mt-2 font-mono text-mono"
            />
          )}
          {error && (
            <p role="alert" className="text-destructive-foreground text-desc">
              {error}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" data-testid="secret-delete" loading={busy} disabled={confirm === undefined} onClick={() => void go()}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const BOX_DEFAULT = "";

// WhereSaved is where a box saves the secrets agents ask for: its default
// store (and GCP project), and a project's own, which wins for its agents.
function WhereSaved({ box, stores, settings, onSaved }: { box: string; stores: SecretStore[]; settings: SecretSettings; onSaved(): void }) {
  const client = useStore((s) => s.client);
  const locations = useStore((s) => s.boxes[box]?.locations);
  const [draft, setDraft] = useState<SecretSettings>(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(clean(draft)) !== JSON.stringify(clean(settings));
  const options = stores.map((s) => ({ value: s.id, label: s.label }));
  const gcp = (id?: string) => id === "gcp";
  const setLocation = (name: string, patch: { store?: string; gcp_project?: string }) =>
    setDraft((d) => ({ ...d, locations: { ...d.locations, [name]: { ...d.locations?.[name], ...patch } } }));

  const save = async () => {
    if (!client) return;
    setBusy(true);
    try {
      await boxApi.putSecretSettings(client, box, cleared(clean(draft), settings));
      toastManager.add({ type: "success", title: `Saved where ${box} keeps secrets` });
      onSaved();
    } catch (err) {
      toastManager.add({ type: "error", title: `Secrets on ${box}`, description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title={`Where ${box} saves them`}
      description="A project's own choice wins for its agents; the rest go to the box's default."
      actions={
        <Button size="xs" variant="outline" data-testid={`secrets-settings-save-${box}`} disabled={!dirty || busy} loading={busy} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <SettingsRow label="Default store" description={gcp(draft.store) ? "The GCP project it saves to" : undefined}>
        {gcp(draft.store) && <Input size="sm" className="w-44 font-mono text-mono" value={draft.gcp_project ?? ""} onChange={(e) => setDraft((d) => ({ ...d, gcp_project: e.target.value }))} placeholder="GCP project" aria-label={`GCP project on ${box}`} />}
        <SimpleSelect size="sm" className="w-48" options={options} value={draft.store} onChange={(v) => setDraft((d) => ({ ...d, store: v }))} aria-label={`Default store on ${box}`} />
      </SettingsRow>
      {(locations ?? []).map((l) => {
        const own = draft.locations?.[l.name];
        return (
          <SettingsRow key={l.name} label={l.name} description={own?.store ? undefined : "The box's default"}>
            {gcp(own?.store) && <Input size="sm" className="w-44 font-mono text-mono" value={own?.gcp_project ?? ""} onChange={(e) => setLocation(l.name, { gcp_project: e.target.value })} placeholder="GCP project" aria-label={`GCP project for ${l.name} on ${box}`} />}
            <SimpleSelect size="sm" className="w-48" options={[{ value: BOX_DEFAULT, label: "Box default" }, ...options]} value={own?.store ?? BOX_DEFAULT} onChange={(v) => setLocation(l.name, { store: v || undefined, gcp_project: gcp(v) ? own?.gcp_project : undefined })} aria-label={`Store for ${l.name} on ${box}`} />
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}

// cleared adds an empty choice for each project that had one of its own
// and is back on the box's default: the box only changes the projects a
// save names.
function cleared(out: SecretSettings, was: SecretSettings): SecretSettings {
  const locations = { ...out.locations };
  for (const name of Object.keys(was.locations ?? {})) if (!locations[name]) locations[name] = {};
  return Object.keys(locations).length ? { ...out, locations } : out;
}

// clean drops a project's empty choice, so "Box default" is no entry, and
// a GCP project where the store isn't GCP.
function clean(s: SecretSettings): SecretSettings {
  const locations: NonNullable<SecretSettings["locations"]> = {};
  for (const [name, l] of Object.entries(s.locations ?? {})) {
    if (!l?.store) continue;
    locations[name] = l.store === "gcp" && l.gcp_project?.trim() ? { store: l.store, gcp_project: l.gcp_project.trim() } : { store: l.store };
  }
  const out: SecretSettings = { store: s.store };
  if (s.store === "gcp" && s.gcp_project?.trim()) out.gcp_project = s.gcp_project.trim();
  if (Object.keys(locations).length) out.locations = locations;
  return out;
}
