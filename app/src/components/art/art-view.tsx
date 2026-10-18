import "./art.css";

import { Suspense, useMemo } from "react";

import { kindOf, type ViewSize } from "@/components/art/kinds";
import { useActiveTheme } from "@/hooks/use-theme";
import { type Art, type ArtVersion, latest, useArtBody } from "@/lib/art/model";
import { chartVars } from "@/lib/art/theme";
import { cn } from "@/lib/utils";

// ArtView is one version of an artifact at a size: a thumbnail (a card,
// the board) or the whole of a tab. Its kind's viewer (kinds.tsx) is
// loaded the first time one is drawn, never at start-up.
export function ArtView({ art, version, size, height, className }: { art: Art; version?: ArtVersion; size: ViewSize; height?: number; className?: string }) {
  const theme = useActiveTheme();
  const vars = useMemo(() => chartVars(theme), [theme]);
  const v = version ?? latest(art);
  const { body, error } = useArtBody(art, v?.n);
  const spec = kindOf(art.kind);
  const wait = <div className="animate-pulse rounded-md bg-muted/50" style={{ height: height ?? (size === "thumb" ? 120 : 240) }} />;
  return (
    <div className={cn("art-scope relative min-h-0", className)} style={vars as React.CSSProperties} data-art-kind={art.kind} data-art-size={size}>
      {error ? (
        <div className="flex items-center justify-center rounded-md border border-dashed p-3 text-muted-foreground text-meta" style={{ height: height ?? (size === "thumb" ? 120 : 160) }}>
          Couldn't read v{v?.n}: {error}
        </div>
      ) : body === undefined || !v ? (
        wait
      ) : (
        <Suspense fallback={wait}>
          <spec.View art={art} version={v} body={body} size={size} height={height} />
        </Suspense>
      )}
    </div>
  );
}
