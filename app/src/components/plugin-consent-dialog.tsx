import { PuzzleIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { laptopApi } from "@/lib/api";
import { plainError } from "@/lib/errors";
import { heldNote, type PluginHelpers } from "@/lib/plugin-helpers";
import { useStore } from "@/lib/store";
import { answerConsent, helperPower, PLUGIN_POWERS, type PluginFiles, readPluginFiles, usePluginConsent } from "@/plugins/consent";
import { ErrorText } from "@/components/error-note";

// PluginConsentDialog asks before a plugin from ~/.berth/plugins first runs,
// and again whenever its code changes. Plugins are not sandboxed, so it says
// plainly what one can do, and allows exactly the files it showed.
export function PluginConsentDialog() {
  const request = usePluginConsent((s) => s.request);
  const plugin = request?.plugin;
  const [files, setFiles] = useState<PluginFiles>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // Where its program runs, for a plugin that changed while it was on: one
  // that names the same program had it left running while this asks.
  const [where, setWhere] = useState<PluginHelpers>();

  useEffect(() => {
    setFiles(undefined);
    setError(undefined);
    setWhere(undefined);
    const client = useStore.getState().client;
    if (!plugin || !client) return;
    let live = true;
    readPluginFiles(client, plugin)
      .then((f) => live && setFiles(f))
      .catch((err) => live && setError(plainError(err)));
    // An agent older than this has no such answer: then nothing is said.
    void laptopApi.pluginHelpers(client, plugin.id).then(
      (h) => live && setWhere(h),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [plugin]);

  const allow = async () => {
    const client = useStore.getState().client;
    if (!client || !plugin || !files) return;
    setSaving(true);
    try {
      await laptopApi.allowPlugin(client, plugin.id, files.hash);
      answerConsent(true);
    } catch (err) {
      setError(plainError(err));
    } finally {
      setSaving(false);
    }
  };

  const again = !!plugin?.allowed || !!plugin?.changed;
  const name = plugin?.name ?? plugin?.id ?? "";
  const held = files?.helper ? heldNote(files.helper.name, where) : undefined;

  return (
    <Dialog open={!!plugin} onOpenChange={(open) => !open && answerConsent(false)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PuzzleIcon className="size-4" />
            {again ? `${name} has changed` : `Allow ${name}?`}
          </DialogTitle>
          <DialogDescription>
            {again ? `Its code is different from the version you allowed, so it's off until you review it again.` : `This plugin isn't part of Shipyard.`} Plugins aren't sandboxed: once on, it runs inside Shipyard with the
            app's own access.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 px-5 pb-5">
          <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5">
            <div className="flex items-center gap-2 text-row">
              <TriangleAlertIcon className="size-4 shrink-0 text-warning" />
              It will be able to
            </div>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-9 text-body">
              {PLUGIN_POWERS.map((p) => (
                <li key={p}>{p}</li>
              ))}
              {files?.helper && <li data-testid="consent-helper">{helperPower(files.helper)}</li>}
            </ul>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
            <dt className="text-muted-foreground">Plugin</dt>
            <dd className="font-mono">
              {plugin?.id}
              {plugin?.version ? ` ${plugin.version}` : ""}
            </dd>
            <dt className="text-muted-foreground">Folder</dt>
            <dd className="truncate font-mono">~/.berth/plugins/{plugin?.id}</dd>
            <dt className="text-muted-foreground">Code</dt>
            <dd className="truncate font-mono">{files ? (files.mainPath ? `${files.mainPath} · ${(files.main.length / 1024).toFixed(1)} KB` : "none (hooks, themes or kits only)") : "Reading…"}</dd>
            <dt className="text-muted-foreground">Hash</dt>
            <dd className="truncate font-mono">{files ? files.hash.slice(0, 7 + 16) : "…"}</dd>
            {files?.helper && (
              <>
                <dt className="text-muted-foreground">Program</dt>
                <dd className="font-mono">
                  {files.helper.name}
                  {files.helper.version ? ` ${files.helper.version}` : ""}
                  <span className="font-sans text-muted-foreground"> · runs on a box, as you, once you turn it on there</span>
                </dd>
              </>
            )}
          </dl>
          {files && files.hooks.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-muted-foreground text-label">Hooks it runs on this computer</h4>
              <ul className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 font-mono text-mono">
                {files.hooks.map((h, i) => (
                  <li key={`${i}-${h.on}`} className="break-all">
                    <span className="text-muted-foreground">{h.on}</span> {h.run}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {held && (
            <p className="text-muted-foreground text-meta" data-testid="consent-helper-held">
              {held} Allowing this version keeps it running. To stop it instead, choose Stop it beside {name} in Settings → Plugins.
            </p>
          )}
          <p className="text-muted-foreground text-meta">Allow only plugins you trust. Shipyard asks again whenever the plugin's code changes, and you can turn it off in Settings → Plugins.</p>
          {error && <ErrorText className="text-destructive-foreground text-meta" text={error} />}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answerConsent(false)}>
            Not now
          </Button>
          <Button onClick={() => void allow()} loading={saving} disabled={!files}>
            Allow and turn on
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
