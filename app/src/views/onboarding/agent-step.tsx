import { TaskComposer } from "@/components/conversation/task-composer";
import { useBoxRequirements } from "@/components/requirements-card";
import { StepHeader } from "@/components/step-header";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useIsLocalBox } from "@/lib/local-box";
import { useStore } from "@/lib/store";
import { thisComputer } from "@/lib/platform";

// A first task the sample project can do in a minute or two, with a test.
export const SAMPLE_TASK = 'Add a /health endpoint to server.js that returns {"ok": true}, with a test';

// AgentStep ends onboarding with the composer, the one way to start work,
// on the project just added: for the sample, a first task already written,
// so Enter starts the first agent in a worktree of its own. A fresh Mac
// often lacks tmux or an agent CLI: the composer asks the box first and
// shows how to install what's missing, so nothing is created to fail.
export function AgentStep({ box, location, sample, onFinish }: { box: string; location: string; sample?: boolean; onFinish(): void }) {
  const agents = useStore((s) => s.boxes[box]?.info?.agents);
  const local = useIsLocalBox(box);
  // The box says what it lacks (tmux, an agent CLI) in the composer's card;
  // a box too old to say gets the old hint.
  const told = !!useBoxRequirements(box).req;
  const none = !told && agents && !agents.some((a) => a.command);
  return (
    <div>
      <StepHeader
        variant="page"
        title="Start your first agent"
        description={
          <>
            It works in a new worktree of <span className="text-foreground">{location}</span> on <span className="text-foreground">{local ? thisComputer("this Mac") : box}</span>, keeps going if you close Shipyard, and tells you
            when it needs you.{sample ? " The task below is a small one to start with; change it, or press Enter." : ""}
          </>
        }
      />
      <div className="mt-6">
        <TaskComposer draft={{ box, location, text: sample ? SAMPLE_TASK : undefined }} autoFocus onDone={onFinish} />
      </div>
      {none && <p className="mt-3 text-muted-foreground text-meta">No agent CLI on {local ? thisComputer("this Mac") : box} yet. Settings → Agents shows how to install Claude Code or Codex.</p>}
      <div className="mt-8 flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-meta">
          Later: <Kbd>⌘N</Kbd> new task · <Kbd>⌘K</Kbd> everything else
        </p>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onFinish}>
          I'll explore first
        </Button>
      </div>
    </div>
  );
}
