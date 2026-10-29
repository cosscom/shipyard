import { CircleAlertIcon, FileTextIcon, ImageIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Tip } from "@/components/tip";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { type AttachTarget, attachable, isImage, localPaths, MAX_ATTACHMENT, named, onThisComputer, pastedFiles, shownName, shrinkImage, uploadAttachment, uploadLocalFile } from "@/lib/attachments";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// A file on its way to the box, or there: the composer shows it as a chip
// until the prompt goes.
export interface PendingAttachment {
  id: string;
  name: string;
  type: string;
  // Bytes, as it goes up (after shrinking).
  size: number;
  // An object URL, for an image's thumbnail.
  preview?: string;
  // shrinking: a pasted screenshot being made smaller first.
  state: "shrinking" | "uploading" | "ready" | "error";
  // How much has gone, 0 to 1, for a file from the app (a path on this
  // computer goes up through the laptop agent, which doesn't say).
  progress?: number;
  // The size before shrinking, when it was shrunk.
  original?: number;
  path?: string;
  error?: string;
}

let seq = 0;

// A pasted screenshot is made smaller before it goes (lib/attachments); a
// dropped file may be the real asset, so it goes as it is.
const shrinks = (f: File, pasted: boolean) => pasted && isImage(f.type) && f.type !== "image/gif";

// useAttachments keeps a composer's attachments: a paste or a drop of files
// uploads them to the target's worktree at once, and paths lists where the
// ready ones are for the prompt. A paste without files (text, HTML, a URL)
// is left to the field. Each upload shows how far it has got; one that
// fails can be retried, and taking a chip out stops its upload.
//
// A composer whose target can change before it sends (the project or box of
// a new task, the agents picked for a prompt) sends its files again to the
// new one, so their paths are where the agent will look. Until there is a
// target, a file waits for it when one is on its way (waiting: the
// project's checkout is still loading, say); otherwise without says why a
// file can't go, when one is dropped or pasted.
export function useAttachments(target: AttachTarget | undefined, { without, waiting }: { without?: string; waiting?: boolean } = {}) {
  const client = useStore((s) => s.client);
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const address = useStore((s) => (target ? s.status?.boxes.find((b) => b.name === target.box)?.address : undefined));
  const live = useRef(items);
  live.current = items;
  // What each unfinished chip is doing: how to try it again, and how to
  // stop it.
  const jobs = useRef(new Map<string, { retry(): void; abort?: AbortController }>());
  // What each chip was made from, to send it again to another target.
  const sources = useRef(new Map<string, File | string>());
  useEffect(
    () => () => {
      for (const j of jobs.current.values()) j.abort?.abort();
      for (const it of live.current) if (it.preview) URL.revokeObjectURL(it.preview);
    },
    [],
  );
  const patch = (id: string, p: Partial<PendingAttachment>) => setItems((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const send = (id: string, f: File) => {
    if (!client || !target) return;
    sources.current.set(id, f);
    const abort = new AbortController();
    jobs.current.set(id, { retry: () => send(id, f), abort });
    patch(id, { state: "uploading", progress: 0, error: undefined });
    let shown = 0;
    uploadAttachment(client, target, f, {
      signal: abort.signal,
      onProgress: (sent, total) => {
        const p = total ? sent / total : 0;
        // A step a percent or more, so a fast upload doesn't re-render on
        // every chunk.
        if (p - shown < 0.01 && p < 1) return;
        shown = p;
        patch(id, { progress: p });
      },
    }).then(
      (a) => {
        if (jobs.current.get(id)?.abort !== abort) return;
        jobs.current.delete(id);
        patch(id, { state: "ready", progress: 1, path: a.path, size: a.size });
      },
      (err: unknown) => {
        if (abort.signal.aborted || jobs.current.get(id)?.abort !== abort) return;
        patch(id, { state: "error", error: errorMessage(err) });
      },
    );
  };

  // pasted: the files came from a paste, so screenshots among them shrink.
  const add = useCallback(
    (files: File[], pasted = false) => {
      if (!client || (!target && !waiting)) return;
      // A pasted screenshot over the limit may fit once it is shrunk.
      // (Not one waiting for a target: it goes as it is.)
      const ok = files.filter((f) => attachable(f) && (f.size <= MAX_ATTACHMENT || (!!target && shrinks(f, pasted))));
      const refused = files.filter((f) => !ok.includes(f));
      if (refused.length) {
        const big = refused.some((f) => attachable(f));
        toastManager.add({
          type: "warning",
          title: refused.length === 1 ? `Couldn't attach ${refused[0].name || "the file"}` : `Couldn't attach ${refused.length} files`,
          description: big ? "Attachments can be up to 20 MB." : "Images (PNG, JPEG, GIF, WebP), PDFs and text files can be attached.",
        });
      }
      for (const file of ok) {
        const f = named(file);
        const id = `att${++seq}`;
        const shrink = shrinks(f, pasted);
        const item: PendingAttachment = { id, name: f.name, type: f.type, size: f.size, preview: isImage(f.type) ? URL.createObjectURL(f) : undefined, state: shrink ? "shrinking" : "uploading", progress: 0 };
        setItems((l) => [...l, item]);
        // No target yet: it goes when there is one (the effect below).
        if (!target) {
          sources.current.set(id, f);
          jobs.current.set(id, { retry: () => {} });
          patch(id, { state: "uploading", progress: undefined });
          continue;
        }
        if (!shrink) {
          send(id, f);
          continue;
        }
        jobs.current.set(id, { retry: () => {} });
        void shrinkImage(f).then((g) => {
          // Taken out while it shrank.
          if (!jobs.current.has(id)) return;
          if (g !== f) patch(id, { name: g.name, type: g.type, size: g.size, original: f.size });
          send(id, g);
        });
      }
    },
    // send reads the same client and target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, target, waiting],
  );

  // sendLocal has the laptop agent upload a file on this computer. missing,
  // on the first try, is told when the path isn't a file here, and the
  // chip goes; any other failure stays on the chip, to retry.
  const sendLocal = (id: string, path: string, missing?: (oldAgent: boolean) => void) => {
    if (!client || !target) return;
    const job = { retry: () => sendLocal(id, path) };
    jobs.current.set(id, job);
    sources.current.set(id, path);
    patch(id, { state: "uploading", error: undefined });
    uploadLocalFile(client, target, path).then(
      (a) => {
        if (jobs.current.get(id) !== job) return;
        jobs.current.delete(id);
        patch(id, { name: shownName(a.name), size: a.size, state: "ready", path: a.path });
      },
      (err: unknown) => {
        if (jobs.current.get(id) !== job) return;
        const notHere = err instanceof ApiError && err.code === "attach_local" && /^no file at/.test(err.message);
        // An agent from before attach-local: the path goes as text, and
        // the person hears why the box may not see it.
        const oldAgent = err instanceof ApiError && err.status === 404 && !err.code;
        if (missing && (notHere || oldAgent)) {
          jobs.current.delete(id);
          sources.current.delete(id);
          setItems((l) => l.filter((x) => x.id !== id));
          missing(oldAgent);
        } else patch(id, { state: "error", error: errorMessage(err) });
      },
    );
  };

  // Paths to files on this computer, pasted as text, go up through the
  // laptop agent. A path that isn't a file here (one copied from the box's
  // own output, say) is pasted as the text it was.
  const addLocal = (paths: string[], asText: () => void) => {
    if (!client || !target) return;
    let missed = 0;
    for (const path of paths) {
      const id = `att${++seq}`;
      const name = path.split("/").pop() ?? path;
      const type = /\.pdf$/i.test(name) ? "application/pdf" : `image/${(name.split(".").pop() ?? "png").toLowerCase().replace("jpg", "jpeg")}`;
      setItems((l) => [...l, { id, name, type, size: 0, state: "uploading" }]);
      sendLocal(id, path, (oldAgent) => {
        if (oldAgent && !missed) toastManager.add({ type: "warning", title: "Pasted the path as text", description: "Restart the Shipyard agent to upload files from this computer; the box can't read a path here." });
        if (++missed === paths.length) asText();
      });
    }
  };

  // Another target: what was sent goes again, to where the agent will be.
  const targetKey = target ? JSON.stringify(target) : "";
  const lastKey = useRef(targetKey);
  useEffect(() => {
    if (targetKey === lastKey.current) return;
    lastKey.current = targetKey;
    if (!targetKey) return;
    for (const it of live.current) {
      const src = sources.current.get(it.id);
      if (src === undefined) continue;
      jobs.current.get(it.id)?.abort?.abort();
      if (typeof src === "string") sendLocal(it.id, src);
      else send(it.id, src);
    }
    // send and sendLocal are this render's, with the new target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  // Nowhere to send a file yet: say why, once a drop or a paste brings one.
  const refuse = () => toastManager.add({ type: "warning", title: "Can't attach files here yet", description: without });

  const onPaste = (e: React.ClipboardEvent) => {
    const files = pastedFiles(e.clipboardData);
    if (!target && waiting && files.length) {
      e.preventDefault();
      add(files, true);
      return;
    }
    if (!target) {
      if (files.length && without) {
        e.preventDefault();
        refuse();
      }
      return;
    }
    if (files.length) {
      e.preventDefault();
      add(files, true);
      return;
    }
    if (onThisComputer(address)) return;
    const text = e.clipboardData.getData("text/plain");
    const paths = localPaths(text);
    if (!paths.length) return;
    e.preventDefault();
    const field = e.currentTarget as HTMLElement;
    addLocal(paths, () => {
      field.focus();
      document.execCommand("insertText", false, text);
    });
  };
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e) || (!target && !waiting && !without)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      setDragging(false);
      const files = pastedFiles(e.dataTransfer);
      if (!files.length || (!target && !waiting && !without)) return;
      e.preventDefault();
      if (target || waiting) add(files);
      else refuse();
    },
  };
  const remove = (id: string) => {
    jobs.current.get(id)?.abort?.abort();
    jobs.current.delete(id);
    sources.current.delete(id);
    setItems((l) => {
      const gone = l.find((x) => x.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return l.filter((x) => x.id !== id);
    });
  };
  const retry = (id: string) => jobs.current.get(id)?.retry();
  const clear = () => {
    for (const j of jobs.current.values()) j.abort?.abort();
    jobs.current.clear();
    sources.current.clear();
    setItems((l) => {
      for (const x of l) if (x.preview) URL.revokeObjectURL(x.preview);
      return [];
    });
  };
  // The handlers stay the same functions and call this render's: what
  // they read (the client, the target) is always the latest.
  const latest = useRef({ onPaste, dropProps, remove, retry, clear, add });
  latest.current = { onPaste, dropProps, remove, retry, clear, add };
  const stable = useMemo(
    () => ({
      onPaste: (e: React.ClipboardEvent) => latest.current.onPaste(e),
      dropProps: {
        onDragOver: (e: React.DragEvent) => latest.current.dropProps.onDragOver(e),
        onDragLeave: (e: React.DragEvent) => latest.current.dropProps.onDragLeave(e),
        onDrop: (e: React.DragEvent) => latest.current.dropProps.onDrop(e),
      },
      remove: (id: string) => latest.current.remove(id),
      retry: (id: string) => latest.current.retry(id),
      clear: () => latest.current.clear(),
      add: (files: File[], pasted?: boolean) => latest.current.add(files, pasted),
    }),
    [],
  );
  // The same object until what it shows changes: a composer drawn only
  // when its props change, or a form reading it from context, takes it as
  // one.
  return useMemo(() => {
    const paths = readyPaths(items);
    const uploading = items.some(going);
    const failed = items.some((x) => x.state === "error");
    return { items, paths, uploading, failed, blocker: blockerOf(items), dragging, ...stable };
  }, [items, dragging, stable]);
}

export type Attachments = ReturnType<typeof useAttachments>;

const going = (x: PendingAttachment) => x.state === "uploading" || x.state === "shrinking";

// blockerOf is what holds back a prompt (or an answer) these go with, in
// words for a placeholder or a tip: an upload still going, or one failed.
export function blockerOf(items: PendingAttachment[]): string | undefined {
  const up = items.filter(going);
  if (up.length) {
    const total = up.reduce((n, x) => n + x.size, 0);
    const sent = up.reduce((n, x) => n + x.size * (x.progress ?? 0), 0);
    const pct = total && up.every((x) => x.progress !== undefined) ? ` (${Math.floor((sent / total) * 100)}%)` : "";
    return `Uploading ${up.length === 1 ? (isImage(up[0].type) ? "the image" : "the file") : `${up.length} files`}${pct}`;
  }
  if (items.some((x) => x.state === "error")) return "An attachment didn't upload: retry or remove it";
}

// readyPaths is where the uploaded ones are on the box.
export const readyPaths = (items: PendingAttachment[]) => items.flatMap((x) => (x.state === "ready" && x.path ? [x.path] : []));

const size = (n: number) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${Math.round(n / 1024)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);

// ProgressRing is how much of an upload has gone, round a thumbnail.
function ProgressRing({ value, className }: { value: number; className?: string }) {
  const c = 2 * Math.PI * 8;
  return (
    <svg viewBox="0 0 20 20" className={cn("-rotate-90", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label="Uploaded">
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth="2.5" />
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.02, value))} className="transition-[stroke-dashoffset] duration-200" />
    </svg>
  );
}

// What a chip's second line says.
function status(it: PendingAttachment): string {
  if (it.state === "shrinking") return "Shrinking…";
  if (it.state === "uploading") return it.progress === undefined ? "Uploading…" : `${Math.floor(it.progress * 100)}% of ${size(it.size)}`;
  if (it.state === "error") return "Didn't upload";
  return it.original ? `${size(it.size)}, was ${size(it.original)}` : size(it.size);
}

// AttachmentChips shows a composer's attachments: a thumbnail (or an icon),
// the name, and how its upload is going, each with a way to take it out
// and, when an upload fails, to try again.
export function AttachmentChips({ items, onRemove, onRetry, className }: { items: PendingAttachment[]; onRemove(id: string): void; onRetry?(id: string): void; className?: string }) {
  if (!items.length) return null;
  return (
    <ul aria-label="Attachments" className={cn("flex flex-wrap gap-2", className)}>
      {items.map((it) => {
        const busy = it.state === "uploading" || it.state === "shrinking";
        return (
          <li key={it.id} data-testid="attachment-chip" data-state={it.state} className="group/chip relative min-w-0 cursor-default">
            <Tip
              label={
                <span className="flex flex-col gap-0.5">
                  <span className="break-all">{it.name}</span>
                  <span className={cn("text-muted-foreground", it.state === "error" && "text-destructive-foreground")}>
                    {it.state === "shrinking"
                      ? "Making the screenshot smaller before it goes…"
                      : it.state === "uploading"
                        ? `Uploading to the box${it.progress === undefined ? "…" : `: ${size(Math.round(it.size * it.progress))} of ${size(it.size)}`}`
                        : it.state === "error"
                          ? it.error
                          : `${it.original ? `${size(it.size)} (shrunk from ${size(it.original)})` : size(it.size)} · goes with the prompt as its path`}
                  </span>
                </span>
              }
            >
              <div
                className={cn(
                  "flex h-11 max-w-56 items-center gap-2 rounded-lg border bg-muted/48 py-1 ps-1 pe-2.5 dark:bg-muted/40",
                  it.state === "error" && "border-destructive/40 bg-destructive/6 dark:bg-destructive/10",
                )}
              >
                <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background text-muted-foreground">
                  {it.preview ? (
                    <img src={it.preview} alt="" className="size-full object-cover" />
                  ) : it.type.startsWith("image/") ? (
                    <ImageIcon className="size-4" />
                  ) : (
                    <FileTextIcon className="size-4" />
                  )}
                  {busy && (
                    <span className={cn("absolute inset-0 flex items-center justify-center", it.preview ? "bg-black/48 text-white" : "bg-background text-foreground")}>
                      {it.state === "uploading" && it.progress !== undefined ? <ProgressRing value={it.progress} className="size-5" /> : <Spinner className="size-4" />}
                    </span>
                  )}
                  {it.state === "error" && (
                    <span className="absolute inset-0 flex items-center justify-center bg-background/72">
                      <CircleAlertIcon className="size-4 text-destructive" />
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-foreground text-label">{it.name}</span>
                  <span className={cn("flex items-center gap-1 truncate text-tag text-muted-foreground tabular-nums", it.state === "error" && "text-destructive-foreground")}>
                    {status(it)}
                    {it.state === "error" && onRetry && (
                      <>
                        <span aria-hidden>·</span>
                        <button
                          type="button"
                          onClick={() => onRetry(it.id)}
                          className="inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline decoration-foreground/24 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <RotateCwIcon className="size-3" />
                          Retry
                        </button>
                      </>
                    )}
                  </span>
                </span>
              </div>
            </Tip>
            <button
              type="button"
              aria-label={busy ? `Stop uploading ${it.name}` : `Remove ${it.name}`}
              onClick={() => onRemove(it.id)}
              className={cn(
                "absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-xs outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/chip:opacity-100",
                it.state === "error" && "opacity-100",
              )}
            >
              <XIcon className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
