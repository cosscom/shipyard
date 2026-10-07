import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";

// Agents report needs-you, working and done through hooks in their own
// settings on the box. berthd install puts them there for the agent CLIs it
// finds; one installed on the box since has none. The first time the app
// starts such an agent on a box, it offers to install them (GET and POST
// integrations on the box API, as `berthd integrations install` does).

interface IntegrationTool {
  id: string;
  name: string;
  command: string;
  present: boolean;
  hooked: boolean;
}

interface IntegrationsReport {
  tools?: IntegrationTool[];
  output?: string;
}

// The commands Shipyard has hooks for, by the tool they install for.
const TOOLS: Record<string, string> = { claude: "claude", codex: "codex", "cursor-agent": "cursor", cursor: "cursor", grok: "grok" };

// hookToolFor is the tool an agent preset ID or command line needs hooks for.
export function hookToolFor(agentOrCommand: string): string | undefined {
  const word = agentOrCommand.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  return TOOLS[word];
}

// Asked about once per box and tool, ever: kept on this computer.
const ASKED = "berth.hooks.asked";
const asked = new Set<string>(load<string[]>(ASKED, []));
const remember = (k: string) => {
  asked.add(k);
  save(ASKED, [...asked].slice(-200));
};

// How long to wait for the agent's first turn before deciding.
const FIRST_TURN_MS = 3 * 60_000;

// offerAgentHooks warns, once per box and tool, that the box can't tell
// when this kind of agent needs you, with a button that installs its hooks
// (POST integrations/install, as `berthd integrations install` does). It
// only says so once it is true: the box reports no hooks for it, and the
// agent's first turn ended (or a few minutes went by) without one hook
// event arriving for its session. Boxes whose berthd predates the
// integrations API are left alone.
export async function offerAgentHooks(box: string, agentOrCommand: string, session?: string) {
  const tool = hookToolFor(agentOrCommand);
  const client = useStore.getState().client;
  const key = `${box}:${tool}`;
  if (!tool || !client || asked.has(key)) return;
  const report = async () => {
    try {
      return (await client.box<IntegrationsReport>(box, "GET", "integrations"))?.tools?.find((x) => x.id === tool);
    } catch {
      return undefined;
    }
  };
  const first = await report();
  if (!first) return;
  if (first.hooked) {
    remember(key);
    return;
  }
  if (session) {
    // Wait for the agent's first turn to end, or for a hook to speak for it.
    const heard = await new Promise<boolean>((resolve) => {
      const s0 = () => useStore.getState().boxes[box]?.sessions?.find((x) => x.name === session);
      const check = () => {
        const s = s0();
        if (s?.fidelity === "hooks") return done(true);
        if (s && (s.agent_state === "finished" || s.agent_state === "waiting" || s.exited)) return done(false);
      };
      const timer = window.setTimeout(() => done(false), FIRST_TURN_MS);
      const unsub = useStore.subscribe(check);
      function done(v: boolean) {
        window.clearTimeout(timer);
        unsub();
        resolve(v);
      }
      check();
    });
    if (heard) {
      remember(key);
      return;
    }
    await useStore.getState().refreshBox(box, ["sessions"]);
    if (useStore.getState().boxes[box]?.sessions?.find((x) => x.name === session)?.fidelity === "hooks") {
      remember(key);
      return;
    }
  }
  // Someone may have installed them meanwhile.
  const t = await report();
  if (!t || t.hooked || asked.has(key)) return;
  remember(key);
  const id = toastManager.add({
    title: `Shipyard can't see when ${t.name} needs you on ${box}`,
    description: `${t.name}'s hooks aren't installed there, so its agents show no working, done or needs-you state. Installing takes a second and keeps your agents running.`,
    type: "warning",
    // Stays until answered: 0 turns off the timer.
    timeout: 0,
    actionProps: {
      children: "Install hooks",
      onClick: () => {
        toastManager.close(id);
        void installHooks(box, t);
      },
    },
  });
}

async function installHooks(box: string, t: IntegrationTool) {
  const client = useStore.getState().client;
  if (!client) return;
  try {
    await client.box<IntegrationsReport>(box, "POST", "integrations/install", { tool: t.id });
    toastManager.add({ title: `Installed ${t.name}'s hooks on ${box}`, description: `${t.name} agents you start from now on show when they're working, done or need you.`, type: "success" });
  } catch (err) {
    toastManager.add({ title: `Couldn't install ${t.name}'s hooks on ${box}`, description: `${errorMessage(err)}. On the box: berthd integrations install ${t.id}`, type: "error" });
  }
}
