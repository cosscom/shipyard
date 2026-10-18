import { AppWindowIcon, LockIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import type { ViewProps } from "@/components/art/kinds";
import { useActiveTheme } from "@/hooks/use-theme";
import { gist } from "@/lib/art/gist";
import { artOrigin } from "@/lib/art/origin";
import origin from "@/lib/art/origin.gen.json";
import { pageTheme, themeFragment } from "@/lib/art/theme";
import type { Theme } from "@/lib/api";
import { cn } from "@/lib/utils";

// A page: one HTML file an agent wrote, run on its own origin with no
// access to Shipyard or the network (internal/proxy/artifact.go). The app
// frames the proxy's shell, which frames the page; the theme goes in the
// URL's fragment (it never reaches a server) and, when it changes, as a
// message. Thumbnails are a poster, never a live page: a page runs only in
// a tab, so a busy one can't weigh on the chat or the board.

export default function PageView({ art, version, body, size, height }: ViewProps) {
  const theme = useActiveTheme();
  if (size === "thumb") return <Poster body={body} height={height ?? 120} title={art.title} />;
  const at = artOrigin(art.box, art.id);
  return at ? <Framed at={at} n={version.n} theme={theme} title={art.title} /> : <Srcdoc body={body} theme={theme} title={art.title} />;
}

function Framed({ at, n, theme, title }: { at: string; n: number; theme: Theme; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  // The address keeps the theme it opened with; later changes are messages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a theme change is a message, not a reload
  const frag = useMemo(() => themeFragment(theme), [n, at]);
  const src = `${at}/?v=${n}${frag}`;
  const post = () => ref.current?.contentWindow?.postMessage(pageTheme(theme), at);
  // biome-ignore lint/correctness/useExhaustiveDependencies: post reads the current theme
  useEffect(post, [theme, at]);
  return (
    <iframe
      ref={ref}
      key={src}
      title={title}
      src={src}
      // The shell needs its own origin (the page's frame-ancestors names
      // it); the page inside is sandboxed to an opaque one.
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      allow=""
      data-art-frame="origin"
      onLoad={post}
      className="block h-full min-h-[24rem] w-full rounded-md border-0 bg-transparent"
      style={{ colorScheme: theme.appearance }}
    />
  );
}

// Mock mode: the same policy in a <meta>, the theme inline, an opaque
// origin from the sandbox.
const metaPolicy = origin.pagePolicy
  .split("; ")
  .filter((d) => !/^(sandbox|frame-ancestors|webrtc)\b/.test(d))
  .map((d) => d.replace(/ http:\/\/ORIGIN\/_lib\//, ""))
  .join("; ");

function Srcdoc({ body, theme, title }: { body: string; theme: Theme; title: string }) {
  const doc = useMemo(() => {
    const t = pageTheme(theme);
    const css = `:root{${Object.entries(t.vars)
      .map(([k, v]) => `${k}:${v}`)
      .join(";")};color-scheme:${t.scheme}}`;
    const head = `<meta http-equiv="Content-Security-Policy" content="${metaPolicy}">${origin.pageHead.replace('content="dark"', `content="${t.scheme}"`)}<style id="berth-theme">${css}</style>`;
    return /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + head) : head + body;
  }, [body, theme]);
  return <iframe title={title} srcDoc={doc} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" data-art-frame="srcdoc" className="block h-full min-h-[24rem] w-full rounded-md border-0 bg-transparent" style={{ colorScheme: theme.appearance }} />;
}

function Poster({ body, height, title }: { body: string; height: number; title: string }) {
  const g = gist("page", "html", body);
  const words = useMemo(() => body.replace(/<title[\s\S]*?<\/title>|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ").replace(/\s+/g, " ").trim().slice(0, 220), [body]);
  return (
    <div className="pointer-events-none relative flex w-full flex-col gap-1.5 overflow-hidden rounded-md border bg-card p-2.5" style={{ height }} aria-hidden>
      <div className={cn("flex items-center gap-1.5 text-muted-foreground", height < 110 && "hidden")}>
        <AppWindowIcon className="size-3.5" />
        <span className="min-w-0 flex-1 truncate text-label text-foreground">{title}</span>
        <LockIcon className="size-3" />
      </div>
      {g && <div className={cn("text-section", height < 110 ? "truncate" : "line-clamp-2")}>{g.text}</div>}
      <div className={cn("text-tag text-muted-foreground", height < 110 ? "line-clamp-2" : "line-clamp-3")}>{words}</div>
      <div className="mt-auto flex gap-1">
        {[62, 40, 78].map((w) => (
          <span key={w} className="h-1.5 rounded-full bg-[color-mix(in_oklab,var(--chart-1)_45%,transparent)]" style={{ width: `${w / 3}%` }} />
        ))}
      </div>
    </div>
  );
}
