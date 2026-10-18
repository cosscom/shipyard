import { LibraryIcon, PencilIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { QueueOffer, offlineOffer, queueLabel } from "@/components/queue/queue-offer";
import { LIBRARY_SCREEN, PromptPreview, PromptRow, VariableFields, openLibrary, useTargetLabel, withDefaults } from "@/components/prompts/shared";
import { SimpleSelect } from "@/components/simple-select";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { StepHeader } from "@/components/step-header";
import { Dialog, DialogFooter, DialogPanel, DialogPopup } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { useAllSessions } from "@/hooks/use-agent-counts";
import { agentOf, sessionName } from "@/lib/derive";
import { plainError } from "@/lib/errors";
import { send } from "@/lib/orchestrate";
import { type SendFailure, enqueue, sendFailure, targetName } from "@/lib/queue";
import {
  askedVariables,
  closePromptPicker,
  fill,
  focusedSession,
  matches,
  openBroadcast,
  type PickerDraft,
  promptsFor,
  type SavedPrompt,
  sessionProject,
  sessionValues,
  type Target,
  usePromptUi,
  usePrompts,
} from "@/lib/prompts";
import { useStore } from "@/lib/store";
import { useRegistry } from "@/plugins/registry";
import { describeAgent, startedAt } from "@/views/dashboard/names";
import { ErrorText } from "@/components/error-note";

const sep = "\u0000";

// PromptPicker sends one saved prompt to one session: pick it, fill its
// variables, see exactly what will be typed, send. In insert mode it hands
// the filled text back instead (the Send prompt dialog uses that).
export function PromptPicker() {
  const d = usePromptUi((s) => s.picker);
  return (
    <Dialog open={!!d} onOpenChange={(open) => !open && closePromptPicker()}>
      {/* Anchored at the top: the list filters and the fill step is taller, and a centred dialog would move its title. */}
      <DialogPopup anchored className="sm:max-w-[36rem]" showCloseButton={false}>
        {d && <Body key={`${d.box}:${d.session}:${d.promptId}:${!!d.onInsert}`} d={d} />}
      </DialogPopup>
    </Dialog>
  );
}

function Body({ d }: { d: PickerDraft }) {
  const prompts = usePrompts((s) => s.prompts);
  const [target, setTarget] = useState<Target | undefined>(() => (d.box && d.session ? { box: d.box, session: d.session } : d.onInsert ? undefined : focusedSession()));
  const [picked, setPicked] = useState<SavedPrompt | undefined>(() => prompts.find((p) => p.id === d.promptId));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const insert = !!d.onInsert;

  useEffect(() => {
    void usePrompts.getState().load();
  }, []);

  const project = target ? sessionProject(target.box, target.session) : undefined;
  const list = useMemo(() => promptsFor(prompts, project).filter((p) => matches(p, query)), [prompts, project, query]);
  const current = list[Math.min(active, list.length - 1)];

  if (picked) return <Fill d={d} prompt={picked} target={target} setTarget={setTarget} onBack={() => setPicked(undefined)} />;

  return (
    <>
      <StepHeader title={insert ? "Insert a saved prompt" : "Send a saved prompt"} aside={target && !insert && <TargetChip target={target} className="ml-0.5" />} description="Pick a prompt from your library." hideDescription />
      <div className="px-5 pb-2">
        <Input
          autoFocus
          value={query}
          placeholder="Search prompts and tags…"
          aria-label="Search prompts"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, list.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && current) {
              e.preventDefault();
              setPicked(current);
            }
          }}
        />
      </div>
      <div className="max-h-[min(24rem,55vh)] overflow-y-auto px-3 pb-2">
        <div role="listbox" aria-label="Saved prompts" className="flex flex-col gap-px">
          {list.map((p, i) => (
            <PromptRow key={p.id} p={p} active={p === current} onHover={() => setActive(i)} onPick={() => setPicked(p)} />
          ))}
          {list.length === 0 && <p className="px-2.5 py-6 text-center text-muted-foreground text-body">{query ? "No prompt matches." : "No saved prompts yet."}</p>}
        </div>
      </div>
      <DialogFooter className="items-center px-5 py-3 sm:justify-between">
        <LibraryButton />
        <div className="flex items-center gap-2">
          {!insert && (
            <Button type="button" variant="ghost" size="sm" onClick={() => openBroadcast({ promptId: current?.id, targets: target ? [target] : undefined })}>
              <UsersIcon />
              Send to several…
            </Button>
          )}
          <span className="flex items-center gap-1 text-muted-foreground text-meta">
            <Kbd>↵</Kbd> to choose
          </span>
        </div>
      </DialogFooter>
    </>
  );
}

function LibraryButton() {
  const has = useRegistry((s) => s.screens.some((c) => c.item.id === LIBRARY_SCREEN));
  if (!has) return <span />;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => {
        closePromptPicker();
        openLibrary();
      }}
    >
      <LibraryIcon />
      Library
    </Button>
  );
}

function Fill({ d, prompt, target, setTarget, onBack }: { d: PickerDraft; prompt: SavedPrompt; target?: Target; setTarget(t?: Target): void; onBack(): void }) {
  const insert = !!d.onInsert;
  const vars = useMemo(() => askedVariables(prompt), [prompt]);
  const [values, setValues] = useState<Record<string, string>>({});
  // Once edited by hand, the text is what goes, whatever the fields say.
  const [edited, setEdited] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A send to a box that is away offers to queue the prompt instead; the
  // offer follows the chosen session's box.
  const [failure, setFailure] = useState<{ box: string; f: SendFailure }>();
  const offer = target && !insert ? (failure?.box === target.box ? failure.f : offlineOffer(target.box)) : undefined;
  // Subscribing keeps built-ins current while sessions and worktrees load.
  useStore((s) => (target ? s.boxes[target.box] : undefined));
  const builtins = target ? sessionValues(target.box, target.session) : {};
  const all = { ...builtins, ...withDefaults(vars, values) };
  const text = edited ?? fill(prompt.body, all);
  const ready = !!text.trim() && (insert || !!target);
  // With nothing to fill in, the button has focus, so Enter sends.
  const nothingToFill = !vars.length && (insert || !!d.session);

  const submit = async (force?: "send") => {
    if (!ready || busy) return;
    if (insert) {
      d.onInsert?.(text);
      usePrompts.getState().used([prompt.id]);
      closePromptPicker();
      return;
    }
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      if (offer && force !== "send") {
        await enqueue({ box: target.box, session: target.session, text });
      } else {
        await send(target.box, target.session, text);
        toastManager.add({ title: `Sent “${prompt.title}”`, description: targetName(target.box, target.session), type: "success" });
      }
      usePrompts.getState().used([prompt.id]);
      closePromptPicker();
    } catch (err) {
      const f = sendFailure(err, target.box);
      setFailure(f && { box: target.box, f });
      if (!f) setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <StepHeader
        title={prompt.title}
        onBack={onBack}
        backLabel="Back to prompts"
        aside={target && !insert && d.session && <TargetChip target={target} className="ml-0.5" />}
        description="Fill in the prompt's variables, then send it."
        hideDescription
      />

      <DialogPanel className="flex flex-col gap-4 px-5 pb-5">
        {!insert && !d.session && (
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="font-medium text-desc">Send to</span>
            <SessionSelect value={target} onChange={setTarget} />
          </label>
        )}
        <VariableFields vars={vars} values={values} autoFocus onChange={(name, v) => setValues((s) => ({ ...s, [name]: v }))} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-2 font-medium text-desc">
            {edited == null ? "Preview" : "Text"}
            {edited == null ? (
              <Button type="button" size="xs" variant="ghost" className="ml-auto h-6 text-muted-foreground" onClick={() => setEdited(text)}>
                <PencilIcon />
                Edit text
              </Button>
            ) : (
              <Button type="button" size="xs" variant="ghost" className="ml-auto h-6 text-muted-foreground" onClick={() => setEdited(undefined)}>
                Reset to the prompt
              </Button>
            )}
          </span>
          {edited == null ? (
            <PromptPreview body={prompt.body} values={all} className="max-h-64 overflow-y-auto" />
          ) : (
            <Textarea autoFocus rows={7} value={edited} onChange={(e) => setEdited(e.target.value)} />
          )}
          {!target && !insert && <span className="text-muted-foreground text-meta">Built-in variables like {"{{branch}}"} fill in once you choose a session.</span>}
        </div>
        {offer && target && <QueueOffer failure={offer} box={target.box} />}
        {error && <ErrorText className="text-destructive text-body" text={error} />}
      </DialogPanel>

      <DialogFooter className="items-center px-5 py-3">
        <Button type="button" variant="ghost" onClick={closePromptPicker}>
          Cancel
        </Button>
        {offer && (
          <Button type="button" variant="outline" disabled={!ready || busy} onClick={() => void submit("send")}>
            Try sending again
          </Button>
        )}
        <Button type="submit" loading={busy} disabled={!ready} autoFocus={nothingToFill}>
          {insert ? "Insert" : offer && target ? queueLabel(offer, target.box) : "Send"}
          <Kbd className="-me-1 bg-primary-foreground/16 text-primary-foreground/80">⌘↵</Kbd>
        </Button>
      </DialogFooter>
    </form>
  );
}

export function TargetChip({ target, className }: { target: Target; className?: string }) {
  const { session, short, detail } = useTargetLabel(target.box, target.session);
  return (
    <Tip label={`${detail} · session ${target.session}`}>
      <span className={`inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border bg-muted/72 px-2 text-desc ${className ?? ""}`}>
        <AgentIcon agent={session && agentOf(session)} className="size-3" />
        <span className="truncate">{short}</span>
        <span className="shrink-0 text-muted-foreground">{target.box}</span>
      </span>
    </Tip>
  );
}

// SessionSelect chooses one agent session on any box.
function SessionSelect({ value, onChange }: { value?: Target; onChange(t?: Target): void }) {
  const all = useAllSessions();
  const boxes = useStore((s) => s.boxes);
  const options = all
    .filter((e) => e.state !== "exited" && agentOf(e.session))
    .map(({ box, session }) => {
      const data = boxes[box];
      const name = sessionName(session, { sessions: data?.sessions, locations: data?.locations, place: true });
      // Several of one agent in a worktree: when each started tells them apart.
      const crowded = describeAgent(session, data?.sessions, data?.locations).crowded;
      return { value: `${box}${sep}${session.name}`, label: `${name}${crowded ? `, started ${startedAt(session.created)}` : ""} — ${box}` };
    });
  return (
    <SimpleSelect
      options={options}
      value={value ? `${value.box}${sep}${value.session}` : ""}
      placeholder={options.length ? "Choose an agent…" : "No agents running"}
      disabled={!options.length}
      onChange={(v) => {
        const [box, session] = v.split(sep);
        onChange(box && session ? { box, session } : undefined);
      }}
    />
  );
}
