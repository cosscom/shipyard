import { lazy, Suspense, useEffect, useState } from "react";

import { Spinner } from "@/components/ui/spinner";

const TerminalView = lazy(() => import("@/components/workspace/terminal-view").then((m) => ({ default: m.TerminalView })));
const ConversationPane = lazy(() => import("@/components/conversation/conversation-pane").then((m) => ({ default: m.ConversationPane })));
const BrowserPane = lazy(() => import("@/components/browser-pane").then((m) => ({ default: m.BrowserPane })));
const HelperPane = lazy(() => import("@/components/conversation/helper-pane").then((m) => ({ default: m.HelperPane })));

interface SessionSurfaceProps {
  box: string;
  session: string;
  agent?: string;
  mode: "chat" | "terminal";
  visible?: boolean;
  focused?: boolean;
  onModeChange?(mode: "chat" | "terminal"): void;
}

// The app owns the attach and transcript code. Plugins can place either live
// view inside their layout without creating another terminal implementation.
export function SessionSurface({ box, session, agent, mode, visible = true, focused = false, onModeChange }: SessionSurfaceProps) {
  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-5" /></div>}>
        {mode === "chat" ? (
          <ConversationPane box={box} session={session} agent={agent} visible={visible} onShowTerminal={onModeChange ? () => onModeChange("terminal") : undefined} />
        ) : (
          <TerminalView box={box} session={session} agent={agent} wsKey="" tab="" pane={`plugin:${box}:${session}`} visible={visible} focused={focused} onFocus={() => {}} onClose={() => {}} />
        )}
      </Suspense>
    </div>
  );
}

// A subagent owns a transcript, but not a terminal. Reuse its read-only live
// pane so a canvas can show it beside its parent or another worktree.
export function HelperSurface({ box, session, helper, name, onClose }: { box: string; session: string; helper: string; name?: string; onClose(): void }) {
  const [resolved, setResolved] = useState({ id: helper, name });
  return <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
    <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-5" /></div>}>
      <HelperPane box={box} session={session} helper={resolved.id} title={resolved.name} onResolve={(id, title) => setResolved({ id, name: title })} onClose={onClose} />
    </Suspense>
  </div>;
}

interface BrowserSurfaceProps {
  id: string;
  url: string;
  worktree?: string;
  visible?: boolean;
  onNavigate?(url: string): void;
}

// Reuse the app's browser pane, including its native webview in the desktop
// app and its iframe fallback in the web demo.
export function BrowserSurface({ id, url, worktree, visible = true, onNavigate }: BrowserSurfaceProps) {
  const [current, setCurrent] = useState(url);
  useEffect(() => setCurrent(url), [url]);
  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-5" /></div>}>
        <BrowserPane id={`plugin-${id}`} url={current} worktree={worktree} visible={visible} preferFrame onNavigate={(next) => { setCurrent(next); onNavigate?.(next); }} />
      </Suspense>
    </div>
  );
}
