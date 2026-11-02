import { ApiError } from "@/lib/api";

// Errors in plain English. What the box, git, tmux or the network said is
// rarely what the person needs to read: explain turns an error (or its
// text) into a short title, one sentence, and the one next step that helps.
// The original words are kept as details, shown behind "Details", never as
// the main message. Codes come from the box and the laptop agent
// ({error, code}; internal/box/errcodes.go); text patterns cover older
// boxes and errors that never had a code.

export type NextStep = "start-again" | "update-box" | "retry" | "reconnect" | "show-terminal";

export const STEP_LABEL: Record<NextStep, string> = {
  "start-again": "Start again",
  "update-box": "Update box",
  retry: "Retry",
  reconnect: "Reconnect",
  "show-terminal": "Show terminal",
};

export interface Explained {
  title: string;
  message: string;
  step?: NextStep;
  // details is what was actually said, when the message is not it.
  details?: string;
  code?: string;
  box?: string;
}

const RAW = [
  /^(tmux|git|exec|open|read|write|dial|lstat|stat|mkdir|remove|rename|json|fork|ssh|scp|rsync|npm|pnpm|yarn|go|bash|sh|zsh|systemctl|launchctl|chdir|fatal|error|warning)\b[: ]/i,
  /\b(errno|EOF|exit status|syscall|panic|goroutine|ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/,
  /^[a-z]+(\.[a-z]+)+: /, // net/http: …, os.Rename: …
  /^\d{3} [A-Z]/, // "404 Not Found"
];

// looksRaw is text a program wrote for another program.
export function looksRaw(text: string): boolean {
  return RAW.some((r) => r.test(text.trim()));
}

// looksCommand is text that is a command to type ("sudo apt-get install -y
// git"): it is never made into a sentence, which would capitalise it into
// something that no longer runs.
export function looksCommand(text: string): boolean {
  const t = text.trim();
  return /^(sudo|curl|apt(-get)?|dnf|yum|brew|berthd?|ssh|git|tmux|npm|pnpm|export|loginctl|systemctl)\s/.test(t) || /^[a-z][\w.-]*\s+(-{1,2}[\w-]+|&&)/.test(t);
}

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return t;
  if (looksCommand(t)) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…)]$/.test(first) ? first : `${first}.`;
};

function rawOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// explain is the plain-English version of err. box names the box it came
// from, when the caller knows.
export function explain(err: unknown, ctx: { box?: string } = {}): Explained {
  const raw = rawOf(err).trim();
  // An error that reached here only as text (description: errorMessage(err))
  // still has its code and box from the ApiError it came from.
  const api = err instanceof ApiError ? err : ApiError.recent.get(raw);
  const code = api?.code;
  const status = api?.status;
  const box = ctx.box ?? api?.box ?? boxIn(raw);
  const on = box ? ` on ${box}` : "";
  const it = box ?? "the box";
  const out = (title: string, message: string, step?: NextStep): Explained => ({ title, message, step, details: raw && raw !== message ? raw : undefined, code, box });

  // An agent whose program has ended.
  if (code === "session_exited" || /pane has exited|pane is dead|program has ended|session has exited/i.test(raw))
    return out("The agent has ended", "Its program closed, so it can't take a message. Start it again to carry on.", "start-again");
  // An agent started again that exited at once: its own words say why.
  if (code === "agent_failed" || /exited as it started \(code -?\d+\)/.test(raw)) return out("It couldn't start again", "It exited as soon as it started. Details has what it said.");
  if (code === "agent_waiting" || /is waiting for someone to answer it/.test(raw))
    return out("It's waiting for an answer", "Answer its question first, so a message doesn't pick an option by accident.", "show-terminal");
  // The box runs a berthd too old for what was asked.
  if (code === "box_outdated" || code === "unsupported" || /^404 page not found$|doesn't have this yet|too old to|needs a newer berthd/i.test(raw))
    return out(`${box ?? "This box"} needs an update`, "It runs an older berthd that doesn't have this yet. Updating keeps its agents running.", "update-box");
  // A box without tmux answers 503 too: it is there, but can't run agents.
  if (code === "tmux_missing" || /tmux is not installed/.test(raw)) return out(`tmux isn't installed${on}`, "Shipyard runs agents inside tmux. Install it on the box, then try again.", "retry");
  // The plugin listing (Settings → Plugins → Browse), which the agent reads
  // from the web: these come before the boxes' 502, which they are not.
  if (code === "registry_unreachable") return out("Can't reach the plugin listing", "Shipyard couldn't reach the plugin listing. This computer may be offline; try again in a moment.", "retry");
  if (code === "registry_invalid") return out("The plugin listing can't be read", "The plugin listing isn't one Shipyard can read. Details has what it said.");
  if (code === "plugin_mismatch") return out("The download didn't match the listing", "What was downloaded isn't what the listing describes, so nothing was installed. Try again in a moment.", "retry");
  if (code === "plugin_invalid") return out("That plugin can't be installed", "The listing describes it wrongly, so Shipyard left it alone. Details has what's wrong.");
  if (code === "listing_changed") return out("The listing changed", "It has another version than the one shown here. Look at it again, then install.");
  if (code === "plugin_by_hand") return out("That folder is your own", "A plugin with this id is in ~/.berth/plugins that the listing didn't install, or that changed since. Replace it from Browse, or remove the folder yourself.");
  // A plugin's helper (internal/agent/helpers.go): the agent downloads its
  // program and hands it to a box, and the box relays requests to it. These
  // are 502s that say nothing about whether the box can be reached.
  if (code === "helper_download") return out("Couldn't download the plugin's program", "Shipyard couldn't fetch it from the address the plugin gives, so nothing was installed. Try again in a moment.", "retry");
  if (code === "helper_mismatch") return out("The download didn't match the plugin", "What was downloaded isn't the program the plugin's checksum names, so nothing was installed.");
  if (code === "helper_unreachable") return out("The plugin's program isn't answering", `It is installed${on} but didn't answer. Shipyard starts it again on its own; try again in a moment.`, "retry");
  // A read that got no answer in time (lib/net.ts): the link is slow or
  // has just dropped; the agent says which once it has checked.
  if (code === "box_timeout" || status === 504)
    return out(`${box ?? "The box"} isn't answering`, "The connection may be slow or down. Shipyard keeps trying; try again in a moment.", "retry");
  // The laptop can't get through.
  if (code === "box_unreachable" || status === 502 || status === 503 || /dial tcp|i\/o timeout|connection refused|no route to host|network is unreachable|connection reset|broken pipe|context deadline exceeded|is offline|unexpected EOF|^EOF$/i.test(raw))
    return out(`Can't reach ${it}`, "It may be asleep or offline. Shipyard reconnects on its own when it's back.", "reconnect");
  if (/failed to fetch|networkerror|load failed|no agent token/i.test(raw))
    return out("Can't reach Shipyard's agent", "The app lost its connection to the agent on this computer. It reconnects on its own.", "reconnect");
  if (code === "box_unknown" || /^no paired box named/.test(raw)) return out("That box isn't paired", "Shipyard doesn't know a box by that name any more. Add it again from Settings → Boxes.");
  if (code === "too_many" || status === 429) return out("Too many tries", "Wait a minute, then try again.", "retry");
  if (code === "refused" || /hook stopped/.test(raw)) {
    const said = raw.split(": ").slice(1).join(": ").trim();
    return out("A hook said no", said && !looksRaw(said) ? sentence(said) : "A before: hook on the box stopped this. Details has what it said.");
  }
  if (code === "not_found" || /^no (session|worktree|location|share|unit|turn|run|flow) with that/.test(raw)) {
    const what = /^no (\w+)/.exec(raw)?.[1];
    return out(what ? `That ${what} is gone` : "It's gone", "It may have been removed or stopped from somewhere else.", "retry");
  }

  // A worktree someone locked (git worktree lock): the box leaves it, and
  // says how to unlock it, which Details keeps whole.
  if (/ is locked \(git worktree lock/.test(raw)) {
    const why = /with the reason "([^"]*)"/.exec(raw)?.[1];
    return out("It's locked", `Someone locked it with git worktree lock${why ? ` ("${why}")` : ""}, so Shipyard left it as it is. Details has how to unlock it.`);
  }
  // git, in its own words.
  if (code === "git_failed" || /^git |fatal: /.test(raw)) {
    if (/uncommitted|contains modified|untracked|modified files|would be overwritten/i.test(raw)) return out("It has uncommitted changes", "Commit or stash them first, or choose to remove it anyway.");
    if (/already exists|already checked out|is already used by worktree/i.test(raw)) return out("That name is taken", "A branch or worktree with that name already exists. Pick another name.");
    if (/not a git repository/i.test(raw)) return out("That folder isn't a git repository", "Choose a folder with a .git in it, or clone the repository first.");
    if (/invalid reference|unknown revision|couldn't find remote ref|did not match any/i.test(raw)) return out("That branch doesn't exist", "Check its name, or fetch the repository first.", "retry");
    if (/conflict/i.test(raw)) return out("Git found conflicts", "Resolve them in the worktree's terminal, then try again.", "show-terminal");
    if (/could not read from remote|permission denied \(publickey\)|authentication failed/i.test(raw)) return out("Git couldn't sign in", "The box has no access to that remote. Add its key or token on the box, then try again.", "retry");
    return out("Git couldn't do that", "Details has git's own words.", "retry");
  }
  // A program the box ran.
  if (code === "command_failed" || /^tmux |^exec: |exit status \d|command not found|executable file not found/.test(raw)) {
    if (/command not found|executable file not found|no such file or directory/i.test(raw)) {
      const prog = /exec: "([^"]+)"|([\w.-]+): command not found/.exec(raw);
      return out(`A program is missing${on}`, `${prog ? `${prog[1] ?? prog[2]} isn't` : "Something it needs isn't"} installed there. Install it, then try again.`, "retry");
    }
    return out(`${box ?? "The box"} couldn't run that`, "Details has what it said.", "retry");
  }
  if (status === 401) return out("Shipyard's agent didn't accept the app", "Restart Shipyard to connect again.", "reconnect");
  if (looksRaw(raw)) return out("Something went wrong", `Shipyard couldn't finish that${on}.`, "retry");
  return { title: "Something went wrong", message: sentence(raw) || "Shipyard couldn't finish that.", code, box };
}

// The friendly sentence for each raw text, for the inline errors that keep
// only text in state: <ErrorText> finds its details here.
const detailsByMessage = new Map<string, string>();

// plainError is explain's one sentence, for an error shown inline.
export function plainError(err: unknown, ctx?: { box?: string }): string {
  const e = explain(err, ctx);
  const text = e.message === "Details has git's own words." || e.message === "Details has what it said." || e.message === "It exited as soon as it started. Details has what it said." ? `${e.title}. ${e.message}` : e.message;
  if (e.details) {
    detailsByMessage.delete(text);
    detailsByMessage.set(text, e.details);
    if (detailsByMessage.size > 40) detailsByMessage.delete(detailsByMessage.keys().next().value!);
  }
  return text;
}

export const detailsFor = (text: string | undefined) => (text ? detailsByMessage.get(text) : undefined);

// boxIn finds a box's name at the start of a message such as "devl runs an
// older berthd…" or "devl is offline".
function boxIn(raw: string): string | undefined {
  return /^([A-Za-z0-9][\w.-]{0,40}) (?:runs an older berthd|is offline|did not come back)/.exec(raw)?.[1];
}
