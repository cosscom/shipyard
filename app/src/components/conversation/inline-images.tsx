import { ArrowUpRightIcon, ImageIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { type RefObject, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { useFileWorktree } from "@/components/conversation/file-links";
import { Spinner } from "@/components/ui/spinner";
import { readFile } from "@/lib/file-links";
import { fileName } from "@/lib/file-match";
import { parseRef } from "@/lib/file-refs";
import { filesApi, openFile } from "@/lib/files";
import { PaneContext } from "@/lib/pane-context";
import { useStore } from "@/lib/store";
import { focusPane } from "@/lib/workspaces";

// Markdown's images are inert slots (lib/chat-images.ts). Each visible reply
// fills its slots from its own worktree, through the same authenticated file
// route as a File tab. External URLs never reach an <img> in the webview.
interface Slot {
  key: number;
  el: HTMLElement;
  src: string;
  alt: string;
}

export function InlineImages({ body, html, draft }: { body: RefObject<HTMLElement | null>; html: string; draft: boolean }) {
  const [slots, setSlots] = useState<Slot[]>([]);
  useLayoutEffect(() => {
    const found = [...(body.current?.querySelectorAll<HTMLElement>("[data-chat-image]") ?? [])].map((el, key) => ({
      key,
      el,
      src: el.dataset.chatImage ?? "",
      alt: el.dataset.chatImageAlt ?? "",
    }));
    setSlots((was) => (was.length || found.length ? found : was));
  }, [body, html]);
  return slots.map((slot) => createPortal(<Picture src={slot.src} alt={slot.alt} draft={draft} />, slot.el, `${slot.key}:${slot.src}`));
}

type ImageState = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "unavailable" };

function Picture({ src, alt, draft }: { src: string; alt: string; draft: boolean }) {
  const worktree = useFileWorktree();
  const pane = useContext(PaneContext);
  const client = useStore((s) => s.client);
  const path = useMemo(() => parseRef(src, worktree?.path)?.path, [src, worktree?.path]);
  const [state, setState] = useState<ImageState>({ kind: "loading" });
  const [source, setSource] = useState(false);
  useEffect(() => {
    if (draft || !worktree || !client || !path) return;
    let live = true;
    let url: string | undefined;
    setState({ kind: "loading" });
    void readFile(worktree, path)
      .then(async (file) => {
        if (!file.image || file.too_large) throw new Error("not a worktree image");
        const blob = await filesApi.image(client, worktree, path);
        url = URL.createObjectURL(blob);
        if (live) setState({ kind: "ready", url });
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (live) setState({ kind: "unavailable" });
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, worktree, path, draft]);

  const written = `![${alt}](${src})`;
  if (draft || !worktree || !path || state.kind === "unavailable")
    return <span className="cv-image-source" data-testid="chat-image-source">{written}</span>;

  const open = (e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (pane) focusPane(pane.wsKey, pane.tab, pane.pane);
    openFile(path, e.altKey ? "split" : e.metaKey || e.ctrlKey ? "external" : "tab");
  };
  return (
    <span role="group" aria-label={alt || fileName(path)} data-testid="chat-worktree-image" data-path={path} className="my-3 block max-w-xl overflow-hidden rounded-lg border bg-card shadow-xs/5">
      {source ? (
        <span className="block overflow-x-auto p-3 font-mono text-mono text-muted-foreground">{written}</span>
      ) : state.kind === "ready" ? (
        <button type="button" aria-label={`Open ${alt || fileName(path)}`} onClick={open} className="flex max-h-80 w-full items-center justify-center overflow-hidden bg-[repeating-conic-gradient(color-mix(in_oklab,var(--muted)_70%,transparent)_0%_25%,transparent_0%_50%)] bg-size-[16px_16px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <img src={state.url} alt={alt || fileName(path)} className="max-h-80 max-w-full object-contain" />
        </button>
      ) : (
        <span className="flex h-40 items-center justify-center text-muted-foreground"><Spinner className="size-4" /></span>
      )}
      <span className="flex min-h-8 items-center gap-2 border-t px-2.5 py-1 text-meta">
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{alt || fileName(path)}</span>
        <button type="button" onClick={() => setSource((v) => !v)} className="rounded px-1.5 py-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{source ? "Image" : "Source"}</button>
        <button type="button" onClick={open} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Open <ArrowUpRightIcon className="size-3" /></button>
      </span>
    </span>
  );
}
