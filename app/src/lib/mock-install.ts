import type { AgentChoice, GuidedInstallRequest, InstallHandlers, InstallPlan, InstallPlanStep, InstallStepState, SshFailure, TerminalConnection } from "@/lib/api";

// The guided install in mock mode (?mock=1): the plan as the agent gives it
// before connecting, and a terminal that plays `berth add ssh` on a fresh
// Ubuntu box, waiting for Enter and for sudo's password as the real one
// does. A word in the host picks a path, as mockSshFailure does for logins:
// "flaky" fails the tmux and git step once (Retry from it then works),
// "nosudo" fails it with the command to run by hand.

type Deps = {
  addBox(name: string, address: string, network?: string): void;
  sshFailure(host: string, trusted?: string): SshFailure | undefined;
  boxIP(host: string): string;
};

let deps: Deps | undefined;

export function initMockInstall(d: Deps) {
  deps = d;
}

export const MOCK_AGENTS: AgentChoice[] = [
  { id: "claude", name: "Claude Code", command: "claude", default: true, offered: true, install: "curl -fsSL https://claude.ai/install.sh | bash", verified: "Anthropic's native installer checks the build it downloads against its checksum" },
  { id: "codex", name: "Codex", command: "codex", offered: true, install: "codex 0.160.1 from github.com/openai/codex/releases → ~/.local/bin/codex", verified: "pinned to 0.160.1 and checked against its sha256" },
  { id: "cursor", name: "Cursor Agent", command: "cursor-agent", offered: true, install: "curl -fsS https://cursor.com/install | bash", verified: "Cursor's installer, over HTTPS; Cursor publishes no checksums for it" },
  { id: "opencode", name: "OpenCode", command: "opencode", offered: true, install: "curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path", verified: "OpenCode's installer, over HTTPS; it publishes no checksums for it" },
  { id: "grok", name: "Grok CLI", command: "grok", offered: true, install: "curl -fsSL https://x.ai/cli/install.sh | bash", verified: "xAI's installer, over HTTPS; xAI publishes no checksums for it" },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    offered: false,
    install: "npm install -g @google/gemini-cli",
    why: "it installs with npm and needs Node.js 20 or newer, which Shipyard doesn't install; install Node, then run the command",
  },
];

function names(ids: string[]) {
  const n = ids.map((id) => MOCK_AGENTS.find((a) => a.id === id)?.name ?? id);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

// mockInstallPlan is guided.Plan with no probe, as GET /v1/ssh/install-plan.
export function mockInstallPlan(host: string, agents: string[]): InstallPlan {
  const user = host.includes("@") ? host.slice(0, host.lastIndexOf("@")) : "$USER";
  const steps: InstallPlanStep[] = [
    { id: "connect", title: `Connect to ${host}`, where: "laptop", detail: "Over SSH, with your own keys and agent, this once. After this Shipyard never needs SSH for the box.", commands: [`ssh ${host}`] },
    {
      id: "berthd",
      title: "Install berthd",
      where: "box",
      detail: "Shipyard's daemon, in ~/.local/bin, running as your own user service. No root.",
      commands: ["upload berthd-linux-<arch> → ~/.local/bin/berthd", "~/.local/bin/berthd install --no-tools --no-integrations --keep-listen"],
    },
    {
      id: "linger",
      title: "Keep berthd running after you log out",
      where: "box",
      sudo: true,
      when: "only if the box needs root for it",
      detail: "systemd stops a user's services at logout unless lingering is on for them.",
      commands: [`sudo loginctl enable-linger ${user}`],
    },
    {
      id: "tools",
      title: "tmux and git",
      where: "box",
      sudo: true,
      when: "only if git is missing",
      detail: "Every terminal and agent runs in tmux, and worktrees are git's.",
      commands: ["upload Shipyard's tmux (tmux-linux-<arch>) → ~/.local/bin/tmux   (only if tmux is missing)", "sudo apt-get install -y -q git   (or dnf, pacman…; only if git is missing)"],
    },
  ];
  if (agents.length)
    steps.push({
      id: "agents",
      title: names(agents),
      where: "box",
      detail: "Into ~/.local/bin, without sudo. Signing in stays yours: each agent asks the first time it starts.",
      commands: [`~/.local/bin/berthd agents install ${agents.join(" ")}`, ...agents.map((id) => `  ${MOCK_AGENTS.find((a) => a.id === id)?.name}: ${MOCK_AGENTS.find((a) => a.id === id)?.install}`)],
    });
  steps.push(
    { id: "integrations", title: "Agent integrations", where: "box", detail: "Hooks that tell Shipyard when an agent is working, done or needs you, and Shipyard's skills.", commands: ["~/.local/bin/berthd integrations install present"] },
    { id: "pair", title: "Pair with this computer", where: "laptop", detail: "The laptop and the box pin each other's keys; from then on they talk directly.", commands: ["~/.local/bin/berthd pair", "berth pair <the link it prints>"] },
  );
  return { steps, agents: MOCK_AGENTS, tmux: { bundled: true } };
}

// Hosts whose tmux and git step has failed once, so Retry gets through.
const failedOnce = new Set<string>();

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const X = "\x1b[0m";

export function mockInstallTerminal(req: GuidedInstallRequest, _cols: number, _rows: number, h: InstallHandlers): TerminalConnection {
  let closed = false;
  let input = "";
  let waiter: ((line: string) => void) | undefined;
  let echo = true;
  const timers = new Set<number>();
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => {
        timers.delete(t);
        closed ? reject(new Error("closed")) : resolve();
      }, ms);
      timers.add(t);
    });
  const out = (s: string) => !closed && h.onData(s.replace(/\n/g, "\r\n"));
  const step = (id: string, state: InstallStepState, message?: string) => !closed && h.onEvent({ type: "step", step: id, state, message });
  // Lines typed before anything reads them wait, as a terminal's input does.
  const typed: string[] = [];
  const readLine = () =>
    new Promise<string>((resolve) => {
      const line = typed.shift();
      if (line !== undefined) resolve(line);
      else waiter = resolve;
    });
  const host = req.host;
  const where = host.split("@").pop() ?? host;
  const user = host.includes("@") ? host.slice(0, host.lastIndexOf("@")) : "me";
  const order = ["connect", "berthd", "linger", "tools", "agents", "integrations", "pair"];
  const from = Math.max(0, order.indexOf(req.from ?? "connect"));
  const pending = (id: string) => order.indexOf(id) >= from;
  const exit = (code: number) => {
    if (closed) return;
    h.onEvent({ type: "exit", code });
  };

  const play = async () => {
    await wait(150);
    h.onOpen();
    step("connect", "start");
    out(`    Using 1Password's SSH agent\n`);
    await wait(500);
    const failure = deps?.sshFailure(host, req.trust_host_key);
    if (failure) {
      h.onEvent({ type: "failure", ssh: failure });
      step("connect", "fail", failure.message);
      out(`berth: ${failure.message}\n`);
      exit(1);
      return;
    }
    if (req.trust_host_key) out(`    Trusted ${where}'s host key (${req.trust_host_key}).\n`);
    step("connect", "done", `${user}@${where}, linux/arm64`);
    if (!req.guided) return quiet();
    out(`\n${B}Shipyard will set this box up:${X}\n`);
    out(` 1. Install berthd\n      ${D}upload berthd-linux-arm64 → ~/.local/bin/berthd${X}\n`);
    out(` 2. Keep berthd running after you log out${Y}  [sudo]${X}\n      ${D}sudo loginctl enable-linger ${user}${X}\n`);
    out(` 3. tmux and git${Y}  [sudo]${X}\n      ${D}upload tmux-linux-arm64 → ~/.local/bin/tmux   (Shipyard's own build: no sudo)${X}\n      ${D}sudo apt-get update -q${X}\n      ${D}sudo apt-get install -y -q git${X}\n`);
    if (req.agents.length) out(` 4. ${names(req.agents)}\n      ${D}~/.local/bin/berthd agents install ${req.agents.join(" ")}${X}\n`);
    out(`\n2 steps need root (Keep berthd running after you log out; tmux and git): sudo asks for your password on the box, in this terminal.\nBerth never sees it or keeps it.\n`);
    if (from === 0) {
      out(`\n${B}Press Enter to start, or Ctrl-C to stop.${X} `);
      await readLine();
    }
    out("\n");

    for (const id of order.slice(1, from)) step(id, "skip", "done before");

    if (pending("berthd")) {
      step("berthd", "start");
      out(`    Uploading berthd-linux-arm64 (11 MB) to ~/.local/bin/berthd\n`);
      await wait(700);
      out(`\n${B}==> berthd, as your user service${X}\n    Installed /home/${user}/.config/systemd/user/berthd.service; berthd is serving on 0.0.0.0:7444.\n`);
      await wait(400);
      step("berthd", "done");
    }
    if (pending("linger")) {
      step("linger", "start");
      out(`\n${B}==> Keeping berthd running after you log out${X}\n`);
      out(`    This needs root: sudo asks for ${user}'s password on this box.\n    Type it and press Enter. It goes to sudo here; Shipyard never sees it or keeps it.\n`);
      out(`[sudo] password for ${user}: `);
      echo = false;
      await readLine();
      echo = true;
      out("\n");
      await wait(300);
      out(`    Lingering is on: berthd keeps running when you log out.\n`);
      step("linger", "done");
    }
    if (pending("tools")) {
      step("tools", "start");
      out(`    Uploading Shipyard's tmux for linux/arm64 (1 MB) to ~/.local/bin/tmux\n`);
      out(`\n${B}==> tmux and git${X}\n    tmux: Shipyard's own build, tmux 3.7c, in /home/${user}/.local/bin (no sudo needed)\n    Installing git with apt-get\n`);
      await wait(400);
      for (const l of ["Hit:1 http://ports.ubuntu.com/ubuntu-ports noble InRelease", "Get:2 http://ports.ubuntu.com/ubuntu-ports noble-updates InRelease [126 kB]", "Reading package lists..."]) {
        out(`${l}\n`);
        await wait(220);
      }
      if (/flaky/.test(host) && !failedOnce.has(host)) {
        failedOnce.add(host);
        out(`${R}E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 2211 (unattended-upgr)${X}\n`);
        step("tools", "cmd", "sudo apt-get install -y -q git");
        step("tools", "fail", "Installing git with apt-get didn't finish; the terminal says why");
        out(`\n${R}Stopped at this step: Installing git with apt-get didn't finish; the terminal says why${X}\n`);
        out(`berth: Installing git with apt-get didn't finish; the terminal says why\n`);
        exit(1);
        return;
      }
      if (/nosudo/.test(host)) {
        const cmd = "sudo apt-get update -q && sudo apt-get install -y -q git";
        step("tools", "cmd", cmd);
        step("tools", "fail", "Installing git needs root, and sudo asks for a password, which Shipyard can't type without a terminal.");
        out(`\n${R}Installing git needs root, and sudo asks for a password, which Shipyard can't type without a terminal.${X}\nRun this on the box, then set it up again:\n  ${cmd}\n`);
        exit(1);
        return;
      }
      for (const l of ["Setting up git-man (1:2.43.0-1ubuntu7.3) ...", "Setting up git (1:2.43.0-1ubuntu7.3) ..."]) {
        out(`${l}\n`);
        await wait(260);
      }
      out(`    git: git version 2.43.0\n`);
      step("tools", "done");
    }
    if (pending("agents") && req.agents.length) {
      step("agents", "start");
      out(`\n${B}==> Agent CLIs: ${names(req.agents)}${X}\n`);
      for (const id of req.agents) {
        if (id === "claude") {
          out("Running Claude Code's installer (https://claude.ai/install.sh)\nSetting up Claude Code...\n");
          await wait(700);
          out(`${G}✔${X} Claude Code successfully installed!\n  Version: 2.3.1\n  Location: ~/.local/bin/claude\nClaude Code installed: /home/${user}/.local/bin/claude\n`);
        } else if (id === "codex") {
          out("Downloading Codex 0.160.1 (https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-aarch64-unknown-linux-musl.tar.gz)\n");
          await wait(900);
          out(`Checked against its sha256 (f54dc5852042…)\nCodex installed: /home/${user}/.local/bin/codex\n`);
        } else {
          await wait(500);
          out(`${names([id])} installed: /home/${user}/.local/bin/${MOCK_AGENTS.find((a) => a.id === id)?.command}\n`);
        }
      }
      step("agents", "done");
    }
    if (pending("integrations")) {
      step("integrations", "start");
      out(`\n${B}==> Agent integrations${X}\n`);
      await wait(400);
      if (req.agents.includes("claude")) out(`    Claude Code: hooks and 7 skills in ~/.claude\n`);
      if (req.agents.includes("codex")) out(`    Codex: hooks in ~/.codex; 7 skills in ~/.agents/skills, which every Codex account reads\n`);
      step("integrations", "done");
    }
    step("pair", "start");
    await wait(600);
    const name = req.name || where.split(".")[0];
    const ip = deps?.boxIP(where) ?? "100.64.0.11";
    deps?.addBox(name, `${ip}:7444`, req.network);
    step("pair", "done", name);
    out(`\nReady: paired with ${name} at ${ip}:7444. SSH is no longer needed for this box.\n`);
    exit(0);
  };
  // quiet is the default add (no --guided): no plan, no Enter; only a step
  // that needs sudo's password asks. "nogit" in the host: git is missing
  // (its step asks for the password); "rootlinger": lingering needs root
  // and nothing else does (asked about first, skippable); both together
  // share one terminal, so sudo asks once.
  const quiet = async () => {
    const nogit = /nogit/.test(host);
    const rootLinger = /rootlinger/.test(host);
    let told = false;
    const password = async (id: string) => {
      if (!told) {
        step(id, "sudo");
        out(`    This needs root: sudo asks for ${user}'s password on this box.\n    Type it and press Enter. It goes to sudo here; Shipyard never sees it or keeps it.\n`);
        out(`[sudo] password for ${user}: `);
        echo = false;
        await readLine();
        echo = true;
        out("\n");
        told = true;
      }
    };
    if (pending("berthd")) {
      step("berthd", "start");
      out(`    Uploading berthd-linux-arm64 (11 MB) to ~/.local/bin/berthd\n`);
      await wait(600);
      out(`\n${B}==> berthd, as your user service${X}\n    Installed /home/${user}/.config/systemd/user/berthd.service; berthd is serving on 100.64.0.11:7444.\n`);
      step("berthd", "done");
    }
    let linger = pending("linger");
    if (linger && !rootLinger) {
      step("linger", "start");
      await wait(250);
      step("linger", "done", "on, without sudo");
      linger = false;
    }
    if (linger && rootLinger && !nogit) {
      step("linger", "ask", `Keep berthd running after you log out? It needs root: sudo asks for ${user}'s password on the box. Skip it, and berthd stops when your last login there ends.`);
      out(`\n${B}Keep berthd running after you log out? [Y/n]${X} `);
      const a = (await readLine()).trim().toLowerCase();
      if (a === "n" || a === "no") {
        step("linger", "skip", `skipped: berthd stops when you log out. To keep it running, run sudo loginctl enable-linger ${user} on the box`);
        linger = false;
      }
    }
    if (linger) {
      step("linger", "start");
      out(`\n${B}==> Keeping berthd running after you log out${X}\n`);
      await password("linger");
      await wait(300);
      out(`    Lingering is on: berthd keeps running when you log out.\n`);
      step("linger", "done");
    }
    if (pending("tools")) {
      step("tools", "start");
      out(`    Uploading Shipyard's tmux for linux/arm64 (1 MB) to ~/.local/bin/tmux\n\n${B}==> tmux and git${X}\n    tmux: Shipyard's own build, tmux 3.7c (no sudo needed)\n`);
      if (nogit) {
        out("    Installing git with apt-get\n");
        await password("tools");
        for (const l of ["Reading package lists...", "Setting up git (1:2.43.0-1ubuntu7.3) ..."]) {
          out(`${l}\n`);
          await wait(250);
        }
      }
      out(`    git: git version 2.43.0\n`);
      step("tools", "done");
    }
    if (pending("agents") && req.agents.length) {
      step("agents", "start");
      out(`\n${B}==> Agent CLIs: ${names(req.agents)}${X}\n`);
      await wait(700);
      for (const id of req.agents) out(`${names([id])} installed: /home/${user}/.local/bin/${MOCK_AGENTS.find((a) => a.id === id)?.command}\n`);
      step("agents", "done");
    }
    if (pending("integrations")) {
      step("integrations", "start");
      await wait(300);
      step("integrations", "done");
    }
    step("pair", "start");
    await wait(500);
    const name = req.name || where.split(".")[0];
    const ip = deps?.boxIP(where) ?? "100.64.0.11";
    deps?.addBox(name, `${ip}:7444`, req.network);
    step("pair", "done", name);
    out(`\nReady: paired with ${name} at ${ip}:7444. SSH is no longer needed for this box.\n`);
    exit(0);
  };
  play().catch(() => {});

  return {
    send(data) {
      const s = typeof data === "string" ? data : new TextDecoder().decode(data);
      for (const c of s) {
        if (c === "\r" || c === "\n") {
          const w = waiter;
          waiter = undefined;
          const line = input;
          input = "";
          if (echo) out("\n");
          if (w) w(line);
          else typed.push(line);
        } else if (c === "\x7f") {
          input = input.slice(0, -1);
        } else if (c === "\x03") {
          out("^C\n");
          exit(130);
        } else {
          input += c;
          if (echo) out(c);
        }
      }
    },
    resize() {},
    close() {
      closed = true;
      for (const t of timers) window.clearTimeout(t);
      h.onClose(true);
    },
  };
}

// The agents on a mock box, and adding them from its settings.
const boxAgents: Record<string, Set<string>> = {};

export function mockBoxAgents(box: string) {
  const have = (boxAgents[box] ??= new Set(box === "devl" ? ["claude", "codex"] : ["claude"]));
  return MOCK_AGENTS.map((a) => ({ ...a, installed: have.has(a.id), path: have.has(a.id) ? `/home/me/.local/bin/${a.command}` : undefined }));
}

export async function mockInstallAgents(box: string, agents: string[], onValue: (v: unknown) => void, wait: (ms: number) => Promise<void>) {
  const have = (boxAgents[box] ??= new Set(["claude"]));
  for (const id of agents) {
    const a = MOCK_AGENTS.find((x) => x.id === id);
    onValue({ step: { step: `agent-${id}`, state: "start" } });
    if (have.has(id)) {
      onValue({ line: `${a?.name} is already installed (/home/me/.local/bin/${a?.command})` });
      onValue({ step: { step: `agent-${id}`, state: "skip", message: `/home/me/.local/bin/${a?.command}` } });
      continue;
    }
    onValue({ line: id === "codex" ? "Downloading Codex 0.160.1 (https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-x86_64-unknown-linux-musl.tar.gz)" : `Running ${a?.name}'s installer` });
    await wait(900);
    if (id === "codex") onValue({ line: "Checked against its sha256 (9226581be592…)" });
    onValue({ line: `${a?.name} installed: /home/me/.local/bin/${a?.command}` });
    have.add(id);
    onValue({ step: { step: `agent-${id}`, state: "done", message: `/home/me/.local/bin/${a?.command}` } });
  }
  onValue({ step: { step: "integrations", state: "start" } });
  await wait(400);
  onValue({ line: "Claude Code: hooks and 7 skills in ~/.claude" });
  onValue({ step: { step: "integrations", state: "done" } });
  onValue({ done: true });
}
