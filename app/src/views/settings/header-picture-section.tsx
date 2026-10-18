import { BanIcon, CheckIcon, ImagePlusIcon, RotateCcwIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { HeaderBand, useHeaderPicture } from "@/components/art/header-band";
import { toastError } from "@/components/error-note";
import { Button } from "@/components/ui/button";
import { keepImage } from "@/lib/chat-background";
import { DEFAULT_HEADER_PICTURE, type HeaderPicture, PLATES } from "@/lib/header-picture";
import { setHeaderPicture, usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { picturesInUse, RemovePicture, useOwnImages } from "@/views/settings/chat-background-section";
import { Segmented } from "@/views/settings/controls";
import { SettingsGroup, SettingsRow } from "@/views/settings/rows";

// Settings › Appearance › Header picture: the painting across the top of a
// new chat, an empty worktree and Home (lib/header-picture.ts). The
// harbour, a plate, a picture of your own (kept with the chat background's,
// chosen apart from it), or none. Every tile is drawn as the band draws it,
// so in a dark theme the paintings show their night.

const HARBOUR_CHOICE: HeaderPicture = { ...DEFAULT_HEADER_PICTURE };

export function HeaderPictureSettings() {
  const hp = usePrefs((p) => p.headerPicture);
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const images = useOwnImages();
  const custom = hp.source !== "builtin" || hp.builtin !== DEFAULT_HEADER_PICTURE.builtin;

  const add = async (f: File) => {
    try {
      const image = await keepImage(f, { name: f.name }, picturesInUse());
      setHeaderPicture({ source: "image", image, position: "center" });
    } catch (err) {
      toastError(err, { title: "Couldn't use that picture" });
    }
  };
  const builtin = (id: HeaderPicture["builtin"]) => hp.source === "builtin" && hp.builtin === id;

  return (
    <section
      id="header-picture"
      data-testid="header-picture-settings"
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
      <div className="mb-3.5 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-section text-foreground">Header picture</h2>
          <p className="mt-[5px] text-desc text-muted-foreground">The painting across the top of Home and a new chat. It dims itself in dark themes.</p>
        </div>
        {custom && (
          <Button size="xs" variant="ghost" onClick={() => setHeaderPicture({ ...DEFAULT_HEADER_PICTURE, image: undefined })}>
            <RotateCcwIcon />
            Reset
          </Button>
        )}
      </div>
      <div className={cn("space-y-5 rounded-xl transition-shadow", dragging && "ring-2 ring-ring ring-offset-4 ring-offset-background")}>
        <div role="group" aria-label="Paintings" className="grid grid-cols-4 gap-x-3 gap-y-3.5 max-[1100px]:grid-cols-3">
          <PictureTile label="Harbour, by the time of day" name="Harbour" selected={builtin("harbour")} onClick={() => setHeaderPicture({ source: "builtin", builtin: "harbour" })}>
            <Thumb choice={HARBOUR_CHOICE} />
          </PictureTile>
          {PLATES.map((p) => (
            <PictureTile key={p.id} label={p.name} selected={builtin(p.id)} onClick={() => setHeaderPicture({ source: "builtin", builtin: p.id })}>
              <Thumb choice={{ ...DEFAULT_HEADER_PICTURE, builtin: p.id }} />
            </PictureTile>
          ))}
          <PictureTile label="None" selected={hp.source === "none"} onClick={() => setHeaderPicture({ source: "none" })} dashed>
            <BanIcon className="size-4 text-muted-foreground" />
          </PictureTile>
        </div>
        <div role="group" aria-label="Custom" className="grid grid-cols-4 gap-x-3 gap-y-3.5 max-[1100px]:grid-cols-3">
          {images.map((img) => (
            <PictureTile
              key={img.id}
              label={img.prompt ? `Generated: ${img.prompt}` : img.name}
              name={img.prompt ? "Generated" : img.name}
              selected={hp.source === "image" && hp.image?.id === img.id}
              onClick={() => setHeaderPicture({ source: "image", image: img })}
              extra={<RemovePicture img={img} />}
            >
              <Thumb choice={{ ...hp, source: "image", image: img }} />
            </PictureTile>
          ))}
          <PictureTile label="Add a picture of your own, or drop one here" name="Your own picture" onClick={() => file.current?.click()} dashed>
            <ImagePlusIcon className="size-4 text-muted-foreground" />
          </PictureTile>
          <input
              ref={file}
              type="file"
              aria-label="Header picture file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void add(f);
              }}
            />
        </div>
      </div>
      {hp.source === "image" && hp.image && (
        <div className="mt-4">
          <SettingsGroup title="Your picture">
            <SettingsRow label="Position" description="Which part of the picture shows across the band.">
              <Segmented
                value={hp.position}
                options={[
                  { value: "top", label: "Top" },
                  { value: "center", label: "Center" },
                  { value: "bottom", label: "Bottom" },
                ]}
                onChange={(position) => setHeaderPicture({ position })}
              />
            </SettingsRow>
          </SettingsGroup>
        </div>
      )}
    </section>
  );
}

// Thumb draws a choice as the band would, at a tile's size: finer dots and
// no dissolve, so the painting reads in 76 px.
function Thumb({ choice }: { choice: HeaderPicture }) {
  const picture = useHeaderPicture(choice);
  if (!picture) return null;
  return <HeaderBand picture={picture} position={0.45} fade={0} cell={1} className="size-full" />;
}

// PictureTile is one picture to choose: its thumbnail, as the band draws
// it, with its name and a check under it, like the theme cards above.
function PictureTile({ label, name, selected, dashed, onClick, extra, children }: { label: string; name?: string; selected?: boolean; dashed?: boolean; onClick(): void; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="group relative flex flex-col gap-2">
      <button type="button" aria-label={label} aria-pressed={!!selected} onClick={onClick} className="group flex flex-col gap-2 text-left outline-none">
        <span
          className={cn(
            "flex h-[88px] w-full items-center justify-center overflow-hidden rounded-xl border bg-background transition-[box-shadow,border-color] group-focus-visible:ring-2 group-focus-visible:ring-ring",
            dashed && "border-dashed",
            selected ? "border-transparent ring-2 ring-foreground ring-offset-2 ring-offset-background" : "group-hover:border-foreground/25",
          )}
        >
          {children}
        </span>
        <span className="flex items-center gap-2 px-0.5 text-desc">
          <span className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}>{name ?? label}</span>
          {selected && <CheckIcon className="size-3.5 shrink-0" />}
        </span>
      </button>
      {extra}
    </div>
  );
}
