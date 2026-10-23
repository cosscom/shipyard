import type { Attachment, BerthApi } from "@berth/plugin";

import type { Client } from "@/lib/api";

// Attachments are files pasted or dropped for an agent: a screenshot, a PDF,
// a log. Agents run on a box, so the file goes up to the box first (into the
// worktree's .berth/attachments, which git ignores) and the agent is given
// its path there, the way Claude Code takes an image in a prompt: "What's in
// this image? /path/to/shot.png". In its own terminal, a pasted image is
// typed as that path, which Claude Code shows as [Image #1].
//
// What else a paste can hold is left to the field: text (however long) and a
// Shipyard URL paste as they are, and rich text pastes as plain text, as a
// textarea and a terminal only take text. A file copied in Finder uploads
// too: its path names a file on this computer, which the box can't read.

// MAX_ATTACHMENT is the most the box takes, in bytes.
export const MAX_ATTACHMENT = 20 << 20;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const TEXT_EXT = /\.(txt|md|log|csv|tsv|json|ya?ml|toml|xml|html|css|jsx?|tsx?|go|py|rb|rs|java|kt|swift|c|h|cpp|sh|sql|diff|patch)$/i;

// Where an attachment goes: a running session's worktree, or a worktree an
// agent is about to start in.
export type AttachTarget = { box: string; session: string } | { box: string; location: string; worktree: string };

export type { Attachment };

export const isImage = (type: string) => IMAGE_TYPES.includes(type);

// attachable says whether the box takes a file: an image, a PDF or text.
export function attachable(f: File): boolean {
  return isImage(f.type) || f.type === "application/pdf" || f.type.startsWith("text/") || TEXT_EXT.test(f.name);
}

// pastedFiles is the files in a paste or a drop, if any. A screenshot copied
// to the clipboard comes as one image file; an image copied in a browser as
// a file plus HTML (the file wins).
export function pastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (files.length) return files;
  return [...data.items].flatMap((it) => (it.kind === "file" ? [it.getAsFile()].filter((f): f is File => !!f) : []));
}

// A pasted image has no useful name ("image.png"); it is named for when,
// and a second one in the same second is told apart: pasted-101502-2.png.
let lastStamp = "";
let sameStamp = 0;
export function fileName(f: File): string {
  if (f.name && f.name !== "image.png" && f.name !== "blob") return f.name;
  const ext = f.type === "image/jpeg" ? "jpg" : (f.type.split("/")[1] ?? "png");
  const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
  sameStamp = stamp === lastStamp ? sameStamp + 1 : 1;
  lastStamp = stamp;
  return `pasted-${stamp}${sameStamp > 1 ? `-${sameStamp}` : ""}.${ext}`;
}

// named is the file under the name it goes up as, so it is named once.
export const named = (f: File): File => {
  const name = fileName(f);
  return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified });
};

// A pasted screenshot is shrunk before it goes up: a retina one is several
// MB of PNG, slow over a laptop's upstream, and the agent downsizes an image
// to about 1568 px on its long edge anyway. Dropped files go as they are, as
// they may be the real asset. GIFs (which may move) are left alone.
const SHRINKABLE = ["image/png", "image/jpeg", "image/webp"];
const SHRINK_OVER = 1 << 20;
const MAX_EDGE = 2000;

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function canvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function encode(c: Canvas, type: string, quality: number): Promise<Blob | null> {
  if ("convertToBlob" in c) return c.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => c.toBlob(resolve, type, quality));
}

// shrinkImage is a pasted image at most 2000 px on its long edge, as WebP
// (JPEG where the browser can't write WebP, as Safari can't), when it is
// over 1 MB or larger than that; anything else, or a result no smaller, is
// the file as it was.
export async function shrinkImage(f: File): Promise<File> {
  if (!SHRINKABLE.includes(f.type) || typeof createImageBitmap !== "function") return f;
  let bmp: ImageBitmap | undefined;
  try {
    bmp = await createImageBitmap(f);
    const long = Math.max(bmp.width, bmp.height);
    if (f.size <= SHRINK_OVER && long <= MAX_EDGE) return f;
    const scale = Math.min(1, MAX_EDGE / long);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = canvas(w, h);
    const g = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!g) return f;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, 0, 0, w, h);
    let out = await encode(c, "image/webp", 0.9);
    if (out?.type !== "image/webp") {
      // JPEG has no transparency: a window's shadow goes on white, not black.
      g.globalCompositeOperation = "destination-over";
      g.fillStyle = "#fff";
      g.fillRect(0, 0, w, h);
      out = await encode(c, "image/jpeg", 0.9);
    }
    if (!out || out.size >= f.size || (out.type !== "image/webp" && out.type !== "image/jpeg")) return f;
    const ext = out.type === "image/webp" ? "webp" : "jpg";
    return new File([out], fileName(f).replace(/\.[^.]+$/, "") + `.${ext}`, { type: out.type, lastModified: f.lastModified });
  } catch {
    // An image the browser can't decode goes up as it is.
    return f;
  } finally {
    bmp?.close();
  }
}

export interface UploadOptions {
  // sent and total are bytes of the file.
  onProgress?(sent: number, total: number): void;
  signal?: AbortSignal;
}

// uploadAttachment sends a file to the box, as its raw bytes, and resolves
// to where it is.
export async function uploadAttachment(client: Client, target: AttachTarget, f: File, o: UploadOptions = {}): Promise<Attachment> {
  if (f.size > MAX_ATTACHMENT) throw new Error(`${f.name || "The file"} is ${Math.round(f.size / 2 ** 20)} MB; attachments can be up to 20 MB.`);
  const route =
    "session" in target
      ? `sessions/${encodeURIComponent(target.session)}/attachments`
      : `locations/${encodeURIComponent(target.location)}/worktrees/${encodeURIComponent(target.worktree)}/attachments`;
  // The box reads a JSON body as the old base64 form, so a .json file goes
  // as plain bytes.
  const body = /json/i.test(f.type) ? f.slice(0, f.size, "application/octet-stream") : f;
  return client.upload<Attachment>(target.box, `${route}?${new URLSearchParams({ name: fileName(f) })}`, body, o.onProgress, o.signal);
}

// withAttachments is a prompt with the attachments' paths after it, one to a
// line, as Claude Code reads them.
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text;
  return [text.trim(), paths.join("\n")].filter(Boolean).join("\n\n");
}


// A path pasted as text that names a file on this computer: a screenshot's
// /var/folders/…/Screenshot.png, "Copy as Pathname" in Finder, a file:// URL.
// An agent on a remote box can't read it, so it is uploaded like a pasted
// file, by the laptop agent (POST /v1/boxes/{box}/attach-local).
const LOCAL_PATH = /^(?:file:\/\/)?(?:~\/|\/(?:Users|var\/folders|private\/var|private\/tmp|tmp|Volumes)\/).+\.(?:png|jpe?g|gif|webp|pdf)$/i;

// localPaths is the laptop paths a paste is made of, or none when it is
// anything else (text that only mentions a path stays text).
export function localPaths(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^(['"])(.*)\1$/, "$2").replaceAll("\\ ", " "))
    .filter(Boolean);
  if (!lines.length || lines.length > 10 || !lines.every((l) => LOCAL_PATH.test(l))) return [];
  return lines.map((l) => (l.startsWith("file://") ? decodeURIComponent(l.slice(7)) : l));
}

// onThisComputer is true for a box that runs here (a loopback address), where
// a laptop path is the box's own and needs no upload.
export function onThisComputer(address?: string): boolean {
  return !!address && /^(127\.|localhost[:]|\[::1\])/.test(address);
}

// uploadLocalFile has the laptop agent read a file on this computer and
// upload it to the box; signal stops it, upload and all.
export function uploadLocalFile(client: Client, target: AttachTarget, path: string, signal?: AbortSignal): Promise<Attachment> {
  const { box, ...to } = target;
  return client.laptop<Attachment>("POST", `/v1/boxes/${encodeURIComponent(box)}/attach-local`, { path, ...to }, signal);
}

const LOCAL_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };

// attachApi is a plugin's api.attach: a file goes up the way the composer
// sends one (pasted: a screenshot shrinks first), a path on this computer
// through the laptop agent. On a box that runs here a path is the box's own,
// so it is the attachment as it is, unread (size 0). address is a box's.
export const attachApi =
  (client: Client, address: (box: string) => string | undefined): BerthApi["attach"] =>
  async (box, target, f, o = {}) => {
    const to = { ...target, box };
    if (typeof f !== "string") return uploadAttachment(client, to, o.pasted ? await shrinkImage(f) : f, o);
    if (!onThisComputer(address(box))) return uploadLocalFile(client, to, f, o.signal);
    const name = f.split("/").pop() ?? f;
    return { path: f, name, type: LOCAL_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "", size: 0 };
  };
