import { ArrowUpLeftIcon, BotIcon, CloudOffIcon, EyeIcon, RefreshCwIcon, SearchXIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { StateGlyph } from "@/components/agent-glyph";
import { HelperChat, helperKey, matchHelper, useHelperInfo, useHelpers } from "@/components/conversation/subagent-view";
import { ErrorText } from "@/components/error-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { agentLabel, agentOf } from "@/lib/derive";
import { useStore } from "@/lib/store";
import { focusSession } from "@/lib/workspaces";

// HelperPane is a helper's own conversation as a tab (or a pane of a
// split): what the sheet shows, at full size. Read-only and live while the
// helper works. Its header names the agent that sent it out, a click away.
// It reads from the box each time it mounts, so it is there again after a
// restart; a helper the box no longer has, or a box that is away, says so.

const elapsed = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

interface Props {
  box: string;
  session: string;
  // Its id, or (opened from an older record) the call or the name.
  helper: string;
  title?: string;
  // Once found: its id and name, kept in the layout.
  onResolve(id: string, name: string): void;
  onClose(): void;
}

export function HelperPane({ box, session, helper, title, onResolve, onClose }: Props) {
  const client = useStore((s) => s.client);
  const offline = useStore((s) => !!s.status && s.status.boxes.find((b) => b.name === box)?.state !== "online");
  const parent = useStore((s) => s.boxes[box]?.sessions?.find((x) => x.name === session));
  const parentName = parent?.title?.trim() || (parent && agentOf(parent) ? agentLabel(agentOf(parent)!) : undefined);
  const { helpers, error, retry } = useHelpers(box, session, { enabled: !offline, retry: true });
  const h = matchHelper(helpers, helper);
  const name = h?.name ?? title ?? "Helper";

  // Known by its id from now on, and named in its tab.
  useEffect(() => {
    if (h && (h.id !== helper || h.name !== title)) onResolve(h.id, h.name);
  }, [h?.id, h?.name, helper, title]);
  useEffect(() => {
    if (!h) return;
    const k = helperKey(box, session, h.id);
    useHelperInfo.setState({ [k]: { name: h.name, state: h.state } });
  }, [box, session, h?.id, h?.name, h?.state]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (h?.state !== "running") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [h?.state]);

  const missing = !offline && helpers && !h;
  return (
    <div data-testid="helper" data-state={h ? h.state : offline ? "offline" : missing ? "missing" : error ? "error" : "loading"} className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="shrink-0 border-b px-6 pt-4 pb-3">
        <div className="mx-auto flex w-full max-w-(--berth-chat-w) flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-meta">
            <BotIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="shrink-0">Sent out by</span>
            <button
              type="button"
              data-testid="helper-parent"
              onClick={() => void focusSession(box, session)}
              className="inline-flex min-w-0 items-center gap-1 rounded font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{parentName ?? session}</span>
              <ArrowUpLeftIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            </button>
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <EyeIcon className="size-3" aria-hidden />
              Read-only
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="min-w-0 truncate text-heading">{name}</h2>
            {h && (
              <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-meta" data-testid="helper-state">
                <StateGlyph state={h.state === "running" ? "running" : "finished"} className="size-3" />
                {h.state === "running" ? `Working · ${elapsed(now - h.started)}` : `Back · took ${elapsed(h.updated - h.started)}`}
              </span>
            )}
            {h?.type && (
              <Badge variant="outline" className="shrink-0">
                {h.type}
              </Badge>
            )}
            {h?.background && (
              <Badge variant="secondary" className="shrink-0">
                In the background
              </Badge>
            )}
          </div>
        </div>
      </header>
      {offline ? (
        <Gone icon={<CloudOffIcon />} title={`${box} is offline`} description={`This helper's conversation is kept on ${box}. It shows here again once ${box} is back.`} onClose={onClose} />
      ) : missing ? (
        <Gone
          icon={<SearchXIcon />}
          title="This helper's record is gone"
          description={`${box} has no record of “${name}” any more. The agent may have been resumed or started again since, which keeps only its new helpers.`}
          onClose={onClose}
          onParent={parent ? () => void focusSession(box, session) : undefined}
        />
      ) : error && !helpers ? (
        <Gone icon={<RefreshCwIcon />} title="Couldn't read this helper" description={<ErrorText className="items-center" text={error} />} onClose={onClose} onRetry={retry} />
      ) : !h || !client ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground text-body">
          <Spinner className="mr-2 size-4" />
          Reading the helper…
        </div>
      ) : (
        <HelperChat key={h.id} box={box} session={session} h={h} wide />
      )}
    </div>
  );
}

function Gone({ icon, title, description, onClose, onParent, onRetry }: { icon: React.ReactNode; title: string; description: React.ReactNode; onClose(): void; onParent?: () => void; onRetry?: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            {onRetry && (
              <Button size="sm" onClick={onRetry}>
                <RefreshCwIcon />
                Retry
              </Button>
            )}
            {onParent && (
              <Button size="sm" onClick={onParent}>
                <ArrowUpLeftIcon />
                Open the chat
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onClose}>
              Close tab
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    </div>
  );
}
