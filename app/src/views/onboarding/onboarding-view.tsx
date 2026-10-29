import "@/views/onboarding/onboarding.css";

import { useEffect, useRef, useState } from "react";

import { Scene, type SceneName } from "@/components/art/scenes";
import { Button } from "@/components/ui/button";
import { useKeepFocusIn } from "@/lib/focus-home";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AddBoxFlow, type AddBoxStage } from "@/views/onboarding/add-box-flow";
import { AgentStep } from "@/views/onboarding/agent-step";
import { JoinStep } from "@/views/onboarding/join-step";
import { finishOnboarding, markOnboardingStarted } from "@/views/onboarding/onboarding-state";
import { RepoStep } from "@/views/onboarding/repo-step";
import { prefetchTailnets } from "@/views/onboarding/tailnet";
import { WelcomeStep } from "@/views/onboarding/welcome-step";
import { ThisMacStep } from "@/views/onboarding/this-mac-step";
import { offerLocalBox, useLocalBox } from "@/lib/local-box";

// join is a second computer joining the boxes of the first, in place of box;
// mac is this Mac becoming the box, the quick way in.
type Step = { kind: "welcome" } | { kind: "mac" } | { kind: "box" } | { kind: "join" } | { kind: "repo"; box: string } | { kind: "agent"; box: string; location: string; sample?: boolean };

const ORDER: Step["kind"][] = ["welcome", "box", "repo", "agent"];

// Each step has its own harbour scene, in one place above the progress, so
// the title below never moves. Connecting a box changes it as it goes.
const BOX_SCENES: Record<AddBoxStage, SceneName> = { start: "arriving", working: "lighthouse", tailnet: "signal", paired: "moored" };
function sceneFor(step: Step["kind"], stage: AddBoxStage): SceneName {
  if (step === "welcome") return "dawn"; // an empty harbour at first light
  if (step === "box" || step === "join" || step === "mac") return BOX_SCENES[stage];
  if (step === "repo") return "first-crate"; // the first thing on the quay
  return "setting-out"; // the first piece of work under sail
}

// OnboardingView takes a new account from nothing to a running agent, one
// calm step at a time: by default this Mac as the box, the sample project
// on it, and the composer with a first task to send, in about a minute; a
// remote box is one click away. It fills the main area until finished.
export function OnboardingView() {
  const hasBoxes = useStore((s) => (s.status?.boxes.length ?? 0) > 0);
  const [step, setStep] = useState<Step>({ kind: "welcome" });
  const [boxStage, setBoxStage] = useState<AddBoxStage>("start");
  const scene = sceneFor(step.kind, boxStage);
  // Whether this computer can be a box, for the welcome's first choice.
  const local = useLocalBox();
  const thisMac = local.ready ? offerLocalBox(local.status) || !!local.status?.box : undefined;

  // Past the welcome, onboarding stays until finished (onboarding-state.ts).
  useEffect(() => {
    if (step.kind !== "welcome") markOnboardingStarted();
  }, [step.kind]);
  // Ask about tailnets now, so Connect a box is laid out with the answer.
  const client = useStore((s) => s.client);
  useEffect(() => void prefetchTailnets(client), [client]);
  // Each step, and each part of one, replaces what had the keyboard: it
  // goes to the new step's first field or control, never to <body>.
  const area = useRef<HTMLDivElement>(null);
  useKeepFocusIn(area);

  const finish = () => {
    finishOnboarding();
    useStore.getState().setView({ kind: "workspace" });
  };

  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-pane">
      {/* Anchored at the top, as the launcher is: steps differ in height, and
          centring them would move each title as the step changes. */}
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col px-6 pt-[18vh] pb-16">
        {/* One height whether or not Skip setup is there, so it never moves
            the step below it. */}
        <div className="relative mb-10 flex h-6 items-center">
          {/* Out of the flow, so the scene never moves the step. */}
          <div aria-hidden className="pointer-events-none absolute bottom-full left-0 mb-6 -ml-1">
            <Scene key={scene} name={scene} width={152} className="onboarding-scene" />
          </div>
          <Progress at={step.kind === "join" || step.kind === "mac" ? "box" : step.kind} />
          {/* Skipping makes sense once there is a box to work on. */}
          {hasBoxes && (
            <Button size="xs" variant="ghost" className="-mr-2 ml-auto text-muted-foreground" onClick={finish}>
              Skip setup
            </Button>
          )}
        </div>
        <div ref={area} className="contents">
          <div key={step.kind} className="onboarding-step">
            {step.kind === "welcome" && <WelcomeStep local={thisMac} onThisMac={() => setStep({ kind: "mac" })} onRemote={() => setStep({ kind: "box" })} onJoin={() => setStep({ kind: "join" })} />}
            {step.kind === "mac" && local.status && (
              <ThisMacStep status={local.status} onStage={setBoxStage} onDone={(box) => setStep({ kind: "repo", box })} onRemote={() => setStep({ kind: "box" })} onBack={() => setStep({ kind: "welcome" })} />
            )}
            {/* Its boxes have their projects already: joining ends setup. */}
            {step.kind === "join" && <JoinStep onStage={setBoxStage} onExit={() => setStep({ kind: "welcome" })} onDone={finish} />}
            {step.kind === "box" && (
              <AddBoxFlow
                variant="page"
                intro={{ title: "Connect a box", description: "Any VPS or dev machine. Shipyard runs one small daemon there, berthd; your code and agents stay as they are." }}
                onStage={setBoxStage}
                onDone={(box) => setStep({ kind: "repo", box })}
                onExit={() => setStep({ kind: "welcome" })}
              />
            )}
            {step.kind === "repo" && <RepoStep box={step.box} onDone={(location, sample) => setStep({ kind: "agent", box: step.box, location, sample })} />}
            {step.kind === "agent" && <AgentStep box={step.box} location={step.location} sample={step.sample} onFinish={finish} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Progress({ at }: { at: Step["kind"] }) {
  const i = ORDER.indexOf(at);
  return (
    <div className="flex items-center gap-1.5" role="img" aria-label={`Step ${i + 1} of ${ORDER.length}`}>
      {ORDER.map((k, n) => (
        <span key={k} className={cn("h-1 rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none", n === i ? "w-6 bg-foreground" : n < i ? "w-3 bg-foreground/50" : "w-3 bg-foreground/15")} />
      ))}
    </div>
  );
}
