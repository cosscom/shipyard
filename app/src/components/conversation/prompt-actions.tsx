import { GitBranchIcon, PencilIcon, Undo2Icon } from "lucide-react";
import { createContext, useContext, useState } from "react";

import { AttachmentChips, useAttachments } from "@/components/conversation/attachments";
import { toastError } from "@/components/error-note";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { isMock } from "@/hooks/use-berth-connection";
import { withAttachments } from "@/lib/attachments";
import { historyApi, meta, putDraft, setCut } from "@/lib/history";
import { useStore } from "@/lib/store";
import { findSession, focusPane } from "@/lib/workspaces";
import type { TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// A sent prompt's three actions, under it while the pointer is on it:
// edit and resend (its words back in the reply box), fork from here (a new
// session with the conversation up to it), and rewind to here (the agent's
// own /rewind, back to before it). Only a chat that knows its session
// offers them, and fork and rewind only what Claude Code can do.

export interface PromptContext {
  box: string;
  session: string;
  // Claude Code with a box that serves history: fork and rewind work.
  claude: boolean;
  // The agent is idle: a rewind can drive its screen.
  idle: boolean;
  who: string;
  // Every item, older turns included: which of equal prompts this is.
  // Read when asked, so the context doesn't change (and every prompt draw
  // again) as the chat grows.
  items(): TranscriptItem[];
}

export const PromptActionsContext = createContext<PromptContext | null>(null);

export function PromptActions({ it }: { it: Extract<TranscriptItem, { kind: "user" }> }) {
  const ctx = useContext(PromptActionsContext);
  const [dialog, setDialog] = useState<"fork" | "rewind">();
  if (!ctx) return null;
  const m = meta(it);
  // A prompt still on its way has no entry in the agent's record yet.
  const recorded = (!!m.uuid || isMock()) && !it.id.startsWith("sent:");
  const canFork = ctx.claude && recorded;
  const canRewind = ctx.claude && recorded;
  return (
    <div className={cn("hs-acts mb-1 flex shrink-0 items-center gap-0.5 text-muted-foreground", dialog && "pointer-events-none")} data-open={dialog ? "" : undefined}>
      <Tip label="Edit and resend">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Edit and resend"
          onClick={() => {
            putDraft(ctx.box, ctx.session, it.text);
          }}
        >
          <PencilIcon />
        </Button>
      </Tip>
      {canFork && (
        <Tip label="Fork from here">
          <Button size="icon-xs" variant="ghost" aria-label="Fork from here" onClick={() => setDialog("fork")}>
            <GitBranchIcon />
          </Button>
        </Tip>
      )}
      {canRewind && (
        <Tip label={ctx.idle ? "Rewind to here" : `Rewind once ${ctx.who} is idle`}>
          <Button size="icon-xs" variant="ghost" aria-label="Rewind to here" disabled={!ctx.idle} onClick={() => setDialog("rewind")}>
            <Undo2Icon />
          </Button>
        </Tip>
      )}
      {dialog === "fork" && <ForkDialog ctx={ctx} it={it} onClose={() => setDialog(undefined)} />}
      {dialog === "rewind" && <RewindDialog ctx={ctx} it={it} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

const title = (text: string) => {
  const line = text.trim().split("\n")[0];
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
};

function ForkDialog({ ctx, it, onClose }: { ctx: PromptContext; it: Extract<TranscriptItem, { kind: "user" }>; onClose(): void }) {
  const [text, setText] = useState(it.text);
  const [busy, setBusy] = useState(false);
  // The fork works in this worktree: files dropped or pasted go up there.
  const files = useAttachments({ box: ctx.box, session: ctx.session });
  const fork = async () => {
    const client = useStore.getState().client;
    if (!client || files.blocker) return;
    setBusy(true);
    try {
      const s = await historyApi.fork(client, ctx.box, ctx.session, { at: meta(it).parent ?? (isMock() ? `id:${it.id}` : undefined), text: withAttachments(text.trim(), files.paths) || undefined, title: `Fork of ${title(it.text)}`, open: "tab" });
      toastManager.add({ type: "success", title: "Forked", description: `A new ${ctx.who} with the conversation up to this message, in its own tab.` });
      onClose();
      // The box opens it as a tab beside this one; asked for here, it comes
      // to the front.
      for (let i = 0; i < 40; i++) {
        const hit = findSession(ctx.box, s.name);
        if (hit) {
          focusPane(hit.key, hit.tab, hit.pane.id);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (err) {
      toastError(err, { title: "Couldn't fork", box: ctx.box });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Fork from here</DialogTitle>
          <DialogDescription>
            A new {ctx.who} in this worktree, with everything said before this message. It starts with the message below; change it to try another way. This conversation is left as it is.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel {...files.dropProps} className={cn(files.dragging && "outline-2 outline-ring/60 outline-dashed -outline-offset-4")}>
          <AttachmentChips items={files.items} onRemove={files.remove} onRetry={files.retry} className="mb-2" />
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={files.onPaste}
            aria-label="The fork's first message"
            className="max-h-60 min-h-24"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void fork();
              }
            }}
          />
          <p className="mt-2 text-muted-foreground text-meta">Leave it empty to open the fork without sending anything.</p>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button loading={busy} disabled={!!files.blocker} onClick={() => void fork()}>
            <GitBranchIcon />
            Fork
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RewindDialog({ ctx, it, onClose }: { ctx: PromptContext; it: Extract<TranscriptItem, { kind: "user" }>; onClose(): void }) {
  const [restore, setRestore] = useState<"conversation" | "both">("conversation");
  const [busy, setBusy] = useState(false);
  const rewind = async () => {
    const client = useStore.getState().client;
    if (!client) return;
    // Which of the prompts reading the same this is, counting back.
    const items = ctx.items();
    const i = items.findIndex((x) => x.id === it.id);
    const nth = items.slice(i + 1).filter((x) => x.kind === "user" && x.text.trim() === it.text.trim()).length;
    setBusy(true);
    try {
      const r = await historyApi.rewind(client, ctx.box, ctx.session, { text: it.text, nth, restore });
      setCut(ctx.box, ctx.session, meta(it).uuid);
      putDraft(ctx.box, ctx.session, r.text || it.text);
      toastManager.add({
        type: "success",
        title: "Rewound",
        description:
          restore === "both" && r.restored === "conversation"
            ? `No files had changed since then, so only the conversation went back. Edit the message and send it again.`
            : `${ctx.who} is back to before this message${r.restored === "both" ? ", files included" : ""}. Edit it and send it again.`,
      });
      onClose();
    } catch (err) {
      toastError(err, { title: "Couldn't rewind", box: ctx.box });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rewind to before this message?</DialogTitle>
          <DialogDescription>
            {ctx.who} forgets this message and everything after it, using its own /rewind. The message comes back to the reply box to edit and send again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RadioGroup value={restore} onValueChange={(v) => setRestore(v as "conversation" | "both")} aria-label="What to rewind">
            <label className="flex cursor-pointer items-start gap-2.5">
              <Radio value="conversation" className="mt-0.5" />
              <span className="flex flex-col">
                <span className="text-row">The conversation</span>
                <span className="text-muted-foreground text-meta">Files stay as they are now.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5">
              <Radio value="both" className="mt-0.5" />
              <span className="flex flex-col">
                <span className="text-row">The conversation and the code</span>
                <span className="text-muted-foreground text-meta">Undo the edits {ctx.who} made since this message as well.</span>
              </span>
            </label>
          </RadioGroup>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button loading={busy} onClick={() => void rewind()}>
            <Undo2Icon />
            Rewind
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
