import { BanIcon, ChevronRightIcon, ImagePlusIcon, RefreshCwIcon, RotateCcwIcon, SparklesIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { type BuiltinKind, BUILTINS, builtin } from "@/components/art/chat-backgrounds";
import { useRendered } from "@/components/conversation/chat-background";
import { toastError } from "@/components/error-note";
import { Tip } from "@/components/tip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  BUILTIN_PRESET,
  type ChatBackground,
  DEFAULT_CHAT_BACKGROUND,
  EFFECTS,
  generatedBlob,
  type ImageGenerator,
  imageGenApi,
  instructionFor,
  keepImage,
  listImages,
  onImagesChanged,
  PICTURE_PRESET,
  removeImage,
  type StoredImageInfo,
} from "@/lib/chat-background";
import { DEFAULT_HEADER_PICTURE } from "@/lib/header-picture";
import { type ChatWidth, setChatBackground, setHeaderPicture, setPrefs, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Segmented } from "@/views/settings/controls";
import { ChatMiniature } from "@/views/settings/chat-miniature";
import { SettingsGroup, SettingsRow, useSettingsRow } from "@/views/settings/rows";

// Settings › Appearance › Chat background: what is behind conversations.
// Patterns and gradients are drawn in code in the theme's colours; scenes
// and pictures of your own (added or generated) are dithered into them. A
// preview shows a conversation over it, and every tile is drawn as it
// would be, with the current effects.

// ChatWidthSettings is how wide a conversation's column runs, in panes and
// in zen: code, tables and edits keep scrolling inside their own blocks.
export function ChatWidthSettings() {
  const width = usePrefs((p) => p.chatWidth);
  const drafts = usePrefs((p) => p.chatDrafts);
  return (
    <SettingsGroup title="Chat">
      <SettingsRow label="Width" description="How wide conversations run. Full takes the pane's width.">
        <Segmented
          value={width}
          options={[
            { value: "narrow", label: "Narrow" },
            { value: "default", label: "Default" },
            { value: "wide", label: "Wide" },
            { value: "xwide", label: "Extra wide" },
            { value: "full", label: "Full" },
          ]}
          onChange={(chatWidth: ChatWidth) => setPrefs({ chatWidth })}
        />
      </SettingsRow>
      <SettingsRow label="Show replies as they're written" description="Claude's reply grows in the chat as it writes, read from its terminal. Off: each reply appears once it's finished.">
        <Switch checked={drafts} onCheckedChange={(chatDrafts) => setPrefs({ chatDrafts })} aria-label="Show replies as they're written" />
      </SettingsRow>
    </SettingsGroup>
  );
}

const GROUPS: { kind: BuiltinKind; title: string }[] = [
  { kind: "pattern", title: "Patterns" },
  { kind: "gradient", title: "Gradients" },
  { kind: "scene", title: "Scenes" },
];

export function ChatBackgroundSettings() {
  const bg = usePrefs((p) => p.chatBackground);
  const [generating, setGenerating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const add = async (f: File) => {
    try {
      const image = await keepImage(f, { name: f.name }, picturesInUse());
      setChatBackground({ source: "image", image, ...PICTURE_PRESET });
    } catch (err) {
      toastError(err, { title: "Couldn't use that picture" });
    }
  };

  return (
    <section
      id="chat-background"
      className="scroll-mt-4"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
        if (f) void add(f);
      }}
    >
      <div className="mb-2 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-section text-foreground">Chat background</h2>
          <p className="mt-0.5 text-desc text-muted-foreground">Behind conversations, in your theme's colours. Quiet enough to read over.</p>
        </div>
        {bg.source !== "none" && (
          <Button size="xs" variant="ghost" onClick={() => setChatBackground({ ...DEFAULT_CHAT_BACKGROUND })}>
            <RotateCcwIcon />
            Reset
          </Button>
        )}
      </div>
      <div className={cn("overflow-hidden rounded-xl border bg-card/40 transition-shadow", dragging && "ring-2 ring-ring")}>
        <Preview bg={bg} />
        <div className="space-y-3 border-t p-3">
          {GROUPS.map((g) => (
            <TileRow key={g.kind} title={g.title}>
              {g.kind === "pattern" && (
                <Tile label="None" selected={bg.source === "none"} onClick={() => setChatBackground({ source: "none" })}>
                  <TileWords icon={<BanIcon />}>None</TileWords>
                </Tile>
              )}
              {BUILTINS.filter((b) => b.kind === g.kind).map((b) => (
                <Tile key={b.id} label={b.name} selected={bg.source === "builtin" && bg.builtin === b.id} onClick={() => setChatBackground({ source: "builtin", builtin: b.id, ...(bg.source === "image" ? BUILTIN_PRESET : {}) })}>
                  <Thumb bg={{ ...bg, ...(bg.source === "image" ? BUILTIN_PRESET : {}), source: "builtin", builtin: b.id }} />
                </Tile>
              ))}
            </TileRow>
          ))}
          <TileRow title="Custom">
            <OwnImages selected={bg.source === "image" ? bg.image?.id : undefined} />
            <Tile label="Add a picture of your own, or drop one here" onClick={() => file.current?.click()}>
              <TileWords icon={<ImagePlusIcon />}>Add…</TileWords>
            </Tile>
            <Tile label="Generate one from a prompt" selected={generating} onClick={() => setGenerating((g) => !g)}>
              <TileWords icon={<SparklesIcon />}>Generate</TileWords>
            </Tile>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void add(f);
              }}
            />
          </TileRow>
          {generating && <Generate onClose={() => setGenerating(false)} />}
        </div>
      </div>
      {bg.source !== "none" && <Effects bg={bg} />}
    </section>
  );
}

export function TileRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="flex items-start gap-3">
      <div className="w-[68px] shrink-0 pt-4 text-muted-foreground text-meta">{title}</div>
      <div className="flex min-w-0 flex-1 flex-wrap gap-2">{children}</div>
    </div>
  );
}

// Tile is one background to pick, as a small thumbnail with its name in a tip.
export function Tile({ label, selected, onClick, children, extra }: { label: string; selected?: boolean; onClick(): void; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="group relative">
      <Tip label={label}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={selected}
          onClick={onClick}
          className={cn(
            "flex h-12 w-[76px] items-center justify-center overflow-hidden rounded-lg border bg-background outline-none transition-[box-shadow,border-color] focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "border-ring ring-2 ring-ring/60" : "hover:border-foreground/25",
          )}
        >
          {children}
        </button>
      </Tip>
      {extra}
    </div>
  );
}

export function TileWords({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex flex-col items-center gap-1 text-tag text-muted-foreground [&_svg]:size-4">
      {icon}
      {children}
    </span>
  );
}

// Thumb draws a background as it would look, at a tile's size: the same
// drawing as the chat, at half scale and a stronger strength, so a quiet
// pattern still shows in 76 px.
function Thumb({ bg }: { bg: ChatBackground }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { drawn, pixelated } = useRendered(wrap, canvas, { ...bg, strength: Math.min(1, bg.strength + 0.3) }, 0.5);
  return (
    <span ref={wrap} className="relative block size-full">
      <canvas ref={canvas} className={cn("absolute inset-0 size-full transition-opacity", pixelated && "[image-rendering:pixelated]", drawn ? "opacity-100" : "opacity-0")} />
    </span>
  );
}

// useOwnImages is the pictures added or generated, newest first: the chat
// background's and the header picture's alike.
export function useOwnImages() {
  const [images, setImages] = useState<StoredImageInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void listImages()
        .then((all) => alive && setImages(all.map(({ blob: _blob, ...info }) => info)))
        .catch(() => undefined);
    load();
    const off = onImagesChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return images;
}

// picturesInUse are the pictures of your own chosen now, which keeping a
// new one never pushes out.
export function picturesInUse() {
  const { chatBackground: bg, headerPicture: hp } = usePrefs.getState();
  return [bg.source === "image" ? bg.image?.id : undefined, hp.source === "image" ? hp.image?.id : undefined];
}

// forgetPicture removes a picture of your own; whatever showed it goes back
// to its default: no chat background, the harbour atop a new chat.
export async function forgetPicture(img: StoredImageInfo) {
  await removeImage(img.id);
  const { chatBackground: bg, headerPicture: hp } = usePrefs.getState();
  if (bg.source === "image" && bg.image?.id === img.id) setChatBackground({ source: "none", image: undefined });
  if (hp.source === "image" && hp.image?.id === img.id) setHeaderPicture({ ...DEFAULT_HEADER_PICTURE, image: undefined });
}

// OwnImages are the pictures added or generated, newest first, each drawn
// as it would be and with a way to forget it.
function OwnImages({ selected }: { selected?: string }) {
  const bg = usePrefs((p) => p.chatBackground);
  const images = useOwnImages();
  // A picture not chosen yet is shown as it would land: Shipyard's preset.
  return images.map((img) => (
    <Tile
      key={img.id}
      label={img.prompt ? `Generated: ${img.prompt}` : img.name}
      selected={selected === img.id}
      onClick={() => setChatBackground(selected === img.id ? {} : { source: "image", image: img, ...(bg.source === "image" ? {} : PICTURE_PRESET) })}
      extra={<RemovePicture img={img} />}
    >
      <Thumb bg={{ ...bg, ...(bg.source === "image" ? {} : PICTURE_PRESET), source: "image", image: img }} />
    </Tile>
  ));
}

// RemovePicture is a picture tile's ×, shown on hover or focus.
export function RemovePicture({ img }: { img: StoredImageInfo }) {
  return (
    <Tip label="Remove this picture">
      <Button
        size="icon-xs"
        variant="secondary"
        aria-label={`Remove ${img.prompt ? "the generated picture" : img.name}`}
        onClick={() => void forgetPicture(img)}
        className="absolute -top-1.5 -right-1.5 size-5 rounded-full opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      >
        <XIcon className="size-3" />
      </Button>
    </Tip>
  );
}

// Preview is a conversation in miniature over the background, as it
// renders in the chat: the same drawing, scaled.
function Preview({ bg }: { bg: ChatBackground }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const on = bg.source !== "none" && (bg.source !== "image" || !!bg.image);
  return (
    <div ref={wrap} className="relative isolate h-[250px] overflow-hidden bg-background" aria-label="Preview" role="img">
      {on && <PreviewLayer wrap={wrap} canvas={canvas} bg={bg} />}
      <ChatMiniature />
    </div>
  );
}

function PreviewLayer({ wrap, canvas, bg }: { wrap: React.RefObject<HTMLDivElement | null>; canvas: React.RefObject<HTMLCanvasElement | null>; bg: ChatBackground }) {
  // The preview is about 60% of a pane, so the design is too.
  const { drawn, sheet, pixelated } = useRendered(wrap, canvas, bg, 0.6);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10" style={{ "--chat-sheet": `${Math.round(sheet * 100)}%` } as CSSProperties}>
      <canvas ref={canvas} className={cn("absolute inset-0 size-full transition-opacity duration-300", pixelated && "[image-rendering:pixelated]", drawn ? "opacity-100" : "opacity-0")} />
      <div data-glass={bg.original || undefined} className={cn("cb-sheet cb-sheet-preview absolute inset-y-0 left-1/2 w-[68%] -translate-x-1/2 transition-opacity", drawn ? "opacity-100" : "opacity-0")} />
    </div>
  );
}

// Effects: strength, dither and tone; a picture's Advanced has showing it
// as it is, and how it fits.
function Effects({ bg }: { bg: ChatBackground }) {
  const custom = EFFECTS.some((k) => bg[k] !== DEFAULT_CHAT_BACKGROUND[k]);
  const picture = bg.source === "image" || (bg.source === "builtin" && builtin(bg.builtin).kind === "scene");
  const asIs = picture && bg.original;
  return (
    <div className="mt-4">
      <SettingsGroup
        title="Effects"
        actions={
          custom ? (
            <Button size="xs" variant="ghost" onClick={() => setChatBackground(Object.fromEntries(EFFECTS.map((k) => [k, DEFAULT_CHAT_BACKGROUND[k]])))}>
              Reset effects
            </Button>
          ) : undefined
        }
      >
        <SettingsRow label="Strength" description="How far it rises from the page, in the margins. Behind the conversation it always fades to a whisper.">
          <Amount value={bg.strength} max={1} onChange={(strength) => setChatBackground({ strength })} />
        </SettingsRow>
        <SettingsRow label="Dither" description={asIs ? "Off while the picture is shown as it is." : "Dots, like the harbour on a new agent: fine or coarse, or smooth."} className={cn(asIs && "opacity-60")}>
          <Segmented
            value={bg.dither}
            options={[
              { value: "fine", label: "Fine" },
              { value: "coarse", label: "Coarse" },
              { value: "off", label: "Smooth" },
            ]}
            onChange={(dither) => setChatBackground({ dither })}
          />
        </SettingsRow>
        <SettingsRow label="Tone" description={asIs ? "Off while the picture is shown as it is." : "Colour keeps a hint of its hues; Ink draws it in your theme's text colour."} className={cn(asIs && "opacity-60")}>
          <Segmented
            value={bg.tone}
            options={[
              { value: "colour", label: "Colour" },
              { value: "ink", label: "Ink" },
            ]}
            onChange={(tone) => setChatBackground({ tone })}
          />
        </SettingsRow>
      </SettingsGroup>
      {picture && <Advanced bg={bg} />}
    </div>
  );
}

function Advanced({ bg }: { bg: ChatBackground }) {
  const [open, setOpen] = useState(bg.original || bg.fit !== "cover" || bg.position !== "center");
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
      <CollapsibleTrigger className="flex items-center gap-1 rounded-md px-1 py-0.5 font-medium text-desc text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Advanced
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-2 divide-y divide-border/70 overflow-hidden rounded-xl border bg-card/40">
          <SettingsRow label="Show the picture as it is" description="No dither or toning. The conversation gets frosted glass behind it, as much as the picture needs.">
            <Switch checked={bg.original} onCheckedChange={(original) => setChatBackground({ original })} />
          </SettingsRow>
          {bg.source === "image" && (
            <SettingsRow label="Fit" description="Fill crops the picture to the pane; Fit shows all of it.">
              <Segmented
                value={bg.fit}
                options={[
                  { value: "cover", label: "Fill" },
                  { value: "contain", label: "Fit" },
                ]}
                onChange={(fit) => setChatBackground({ fit })}
              />
              <Segmented
                value={bg.position}
                label="Position"
                options={[
                  { value: "top", label: "Top" },
                  { value: "center", label: "Center" },
                  { value: "bottom", label: "Bottom" },
                ]}
                onChange={(position) => setChatBackground({ position })}
              />
            </SettingsRow>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

// Amount is a slider with its value beside it, a percentage unless told.
function Amount({ value, onChange, min = 0, max, step = 0.05, format = (v) => `${Math.round(v * 100)}%` }: { value: number; onChange(v: number): void; min?: number; max: number; step?: number; format?: (v: number) => string }) {
  const row = useSettingsRow();
  return (
    <div className="flex w-56 items-center gap-3">
      <Slider value={value} min={min} max={max} step={step} onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} aria-labelledby={row?.labelledBy} className="flex-1" />
      <span className="w-11 text-right text-muted-foreground text-meta tabular-nums">{format(value)}</span>
    </div>
  );
}

const IDEAS = ["A lighthouse in thick fog", "Tide pools seen from above", "A quiet marina at dusk, lamps on", "Rain on a harbour at night"];

// Generate makes a background from a prompt with an image generator on
// this computer, through the laptop agent. It says what will run, and runs
// it only when Generate is pressed.
function Generate({ onClose }: { onClose(): void }) {
  const client = useStore((s) => s.client);
  const [gens, setGens] = useState<ImageGenerator[] | "loading" | Error>("loading");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string>();
  const check = () => {
    if (!client) return setGens(new Error("Shipyard isn't connected to its agent on this computer."));
    setGens("loading");
    imageGenApi.list(client).then(setGens, (err: unknown) => setGens(err instanceof Error ? err : new Error(String(err))));
  };
  // Looks once, when opened (and again on Check again).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(check, [client]);
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [busy]);

  const gen = Array.isArray(gens) ? gens[0] : undefined;
  const ready = !!gen?.installed && gen.signed_in;
  const go = async () => {
    if (!client || !ready || !prompt.trim()) return;
    setBusy(Date.now());
    setNow(Date.now());
    setError(undefined);
    try {
      const img = await imageGenApi.generate(client, prompt.trim(), gen.id);
      const image = await keepImage(generatedBlob(img), { name: `${gen.name}: ${img.prompt}`, prompt: img.prompt }, picturesInUse());
      setChatBackground({ source: "image", image, ...PICTURE_PRESET });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };
  const shown = gen ? gen.command.map((a) => (a === "{prompt}" ? JSON.stringify(instructionFor(prompt.trim() || "…")) : a)).join(" ") : "";

  return (
    <div className="mt-3 rounded-lg border bg-background p-3">
      <div className="mb-2 flex items-center gap-2">
        <SparklesIcon className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-row">Generate a background</span>
        <Tip label="Close">
          <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
            <XIcon />
          </Button>
        </Tip>
      </div>
      {gens === "loading" ? (
        <div className="flex items-center gap-2 py-2 text-muted-foreground text-meta">
          <Spinner className="size-3.5" /> Looking for an image generator on this computer…
        </div>
      ) : gens instanceof Error || !gen || !ready ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{gens instanceof Error ? "Can't look for an image generator" : !gen ? "No image generator found" : !gen.installed ? "Codex isn't installed" : "Codex isn't signed in"}</AlertTitle>
          <AlertDescription>
            <p>{gens instanceof Error ? gens.message : (gen?.note ?? "Shipyard generates backgrounds with Codex's CLI.")} Meanwhile, you can add a picture of your own.</p>
            <Button size="xs" variant="outline" className="mt-2 w-fit" onClick={check}>
              <RefreshCwIcon />
              Check again
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void go();
              }
            }}
            maxLength={1000}
            disabled={!!busy}
            placeholder="Describe the picture, such as a harbour at dusk with the lamps coming on"
            aria-label="Describe the picture"
            size="sm"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {IDEAS.map((i) => (
              <Button key={i} size="xs" variant="outline" disabled={!!busy} onClick={() => setPrompt(i)} className="font-normal text-muted-foreground">
                {i}
              </Button>
            ))}
          </div>
          <div className="mt-3 text-muted-foreground text-meta">
            Generate runs this on this computer, with your Codex account. Codex works read-only in an empty folder; only your prompt is sent.
          </div>
          <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg [overflow-wrap:anywhere] bg-muted px-2.5 py-2 font-mono text-tag text-foreground/85">{shown}</pre>
          {error && (
            <Alert variant="error" className="mt-2">
              <TriangleAlertIcon />
              <AlertTitle>Couldn't generate it</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" disabled={!prompt.trim() || !!busy} loading={!!busy} onClick={() => void go()}>
              <SparklesIcon />
              Generate
            </Button>
            {busy ? <span className="text-muted-foreground text-meta tabular-nums">{gen.name} is drawing it, {Math.max(0, Math.round((now - busy) / 1000))} s; it usually takes 30 to 60 s.</span> : <span className="text-muted-foreground text-meta">It's kept on this computer, with the pictures above.</span>}
          </div>
        </>
      )}
    </div>
  );
}
