// Reading agents' screens: the lines that say what they are doing, and the
// numbered options they ask about. Pure, so anything can use them.

// Agents draw chrome under their output: an input box, a prompt, hints.
// None of it says what the agent is doing, so the tail skips it.
const RULE = /^[\s─━│┃╭╮╰╯═┌┐└┘├┤┬┴┼▔▁-]+$/;
const CHROME = [
  /^[❯>›$#%]\s*$/,
  /^[❯>›]\s+(Try "|$)/,
  /^\s*(⏵⏵|⏸|\? for shortcuts|esc to interrupt|bypass permissions|auto mode|accept edits|plan mode)/i,
  /·\s*\/effort\s*$/,
  /^\s*[●◐◑]\s*(low|medium|high|max)\s*·/i,
];

// With blanks, the empty lines between paragraphs stay (one for a run of
// them, none at either end), so a reader can tell paragraphs apart.
export function meaningfulTail(screen: string, count: number, { blanks = false }: { blanks?: boolean } = {}): string[] {
  const lines: string[] = [];
  for (const raw of screen.split("\n")) {
    const l = raw.replace(/\s+$/, "");
    if (!l.trim()) {
      if (blanks && lines.length && lines.at(-1) !== "") lines.push("");
      continue;
    }
    if (!RULE.test(l) && !CHROME.some((re) => re.test(l.trim()))) lines.push(l);
  }
  while (lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-count);
  while (tail[0] === "") tail.shift();
  // Drop the indentation the lines share, so narrow cards show words.
  const indent = Math.min(...tail.filter(Boolean).map((l) => l.length - l.trimStart().length));
  return tail.map((l) => l.slice(indent));
}

export interface Choice {
  key: string;
  label: string;
  // The option as the agent words it, when label is shorter.
  title?: string;
}

// permissionChoices matches a permission menu's numbered options to the
// three answers a person gives: Allow, Always allow (when the agent offers
// it, e.g. "Yes, and don't ask again for ls commands"), and Deny. The key
// stays the option's own number, so answering types what the agent shows.
export function permissionChoices(choices: Choice[]): Choice[] | undefined {
  const always = choices.find((c) => /don.t ask again|always|allow all|this session/i.test(c.label));
  const allow = choices.find((c) => c !== always && /^(yes|allow|approve|proceed)\b/i.test(c.label));
  const deny = choices.find((c) => /^(no|deny|reject)\b/i.test(c.label));
  if (!allow || !deny) return undefined;
  return [
    { key: allow.key, label: "Allow", title: allow.label },
    ...(always ? [{ key: always.key, label: "Always allow", title: always.label }] : []),
    { key: deny.key, label: "Deny", title: deny.label },
  ];
}

// choicesIn reads the numbered options an agent is asking about, such as
// Claude Code's "❯ 1. Yes / 2. No, and tell Claude what to do differently".
export function choicesIn(screen: string): Choice[] {
  // A form of questions isn't answered by one number: each picks for the
  // question on show and moves on, or ticks a box.
  if (questionFormIn(screen)) return [];
  return menuIn(screen).choices;
}

// menuIn reads the numbered options in a screen's last lines, the screen's
// lines, and which of them holds option 1 (-1 with no menu).
function menuIn(screen: string): { choices: Choice[]; lines: string[]; first: number } {
  // A pane taller than what the agent drew ends in blank lines.
  const lines = screen.trimEnd().split("\n");
  const out: Choice[] = [];
  let first = -1;
  for (let i = Math.max(0, lines.length - 14); i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:[❯›>]\s*)?(\d)[.)]\s+(\S.*)$/);
    if (!m || out.some((c) => c.key === m[1])) continue;
    if (!out.length) first = i;
    out.push({ key: m[1], label: m[2].trim() });
  }
  // A real menu counts up from 1.
  return out.length >= 2 && out[0].key === "1" ? { choices: out.slice(0, 4), lines, first } : { choices: [], lines, first: -1 };
}

// askIn reads what a waiting agent's screen asks: the numbered options of
// its menu, the line above the first as the question, and whether it is a
// form of questions no one number answers. At its own prompt it asks
// nothing (a list in its last message is no menu), and the question is
// never its chrome (a rule, its footer's "/rc") or the prompt the person
// typed ("❯ /rc"), which end the search.
export function askIn(screen: string): { detail: string; choices: Choice[]; form: boolean } {
  const form = questionFormIn(screen);
  const none = { detail: "", choices: [], form };
  if (form || screenAt(undefined, screen) === "prompt") return none;
  const { choices, lines, first } = menuIn(screen);
  if (!choices.length) return none;
  for (let i = first - 1; i >= 0; i--) {
    const l = lines[i].replace(/^[│|╭╰\s]+|[│|╮╯\s]+$/g, "");
    if (!l) continue;
    const chrome = RULE.test(l) || /^[❯>›]\s/.test(l) || CHROME.some((re) => re.test(l));
    return { detail: chrome ? "" : l, choices, form };
  }
  return { ...none, choices };
}

// questionFormIn says the screen's foot shows Claude Code's form of
// questions with steps: its tab row ("←  ☐ Colour  ☐ Toppings  ✔ Submit
// →"), drawn for several questions or one taking several picks. One
// question with one pick shows a single "☐ Drink" and answers by number.
export function questionFormIn(screen: string): boolean {
  return screen
    .trimEnd()
    .split("\n")
    .slice(-40)
    .some((l) => /^\s*←\s+[☐☒]/.test(l) || (/[☐☒]/.test(l) && /✔\s*Submit/.test(l)));
}

// What an agent's screen shows at its foot: its own prompt, waiting for
// words ("prompt"); a screen of its own that only keys can answer, such as
// /model's picker, /config, a trust dialog ("interactive"); or neither for
// sure ("unknown"). Claude Code draws its prompt between two rules; Codex a
// "›" line over its footer. Its own screens end in key hints ("Esc to
// cancel", "Enter to confirm", "↑/↓ to navigate") or numbered options.
// Claude Code 2.1 follows its "❯" with a no-break space, which \s takes.
const PROMPT_RULE = /^\s*[─━]{8,}\s*$/;
const KEY_HINT = /(esc to (cancel|close|go back|exit|clear|dismiss)|enter to (confirm|select|continue|change|set|submit|save|toggle)|press enter|space to (select|toggle)|↑\/↓|←\/→|to navigate|to switch|type to (filter|search))/i;

export function screenAt(agent: string | undefined, screen: string): "prompt" | "interactive" | "unknown" {
  const lines = screen.replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const tail = lines.slice(-16);
  const hinted = tail.filter((l) => l.trim()).slice(-4).some((l) => KEY_HINT.test(l));
  let prompt = false;
  if (agent === "codex") {
    // The input line sits within the last few lines, over the footer.
    const last = tail.filter((l) => l.trim()).slice(-4);
    prompt = last.some((l) => /^›(\s|$)/.test(l)) && !hinted;
  } else {
    for (let i = 1; i < tail.length - 1 && !prompt; i++) {
      if (!/^\s*[❯>!#](\s|$)/.test(tail[i]) || !PROMPT_RULE.test(tail[i - 1])) continue;
      prompt = tail.slice(i + 1, i + 10).some((l) => PROMPT_RULE.test(l));
    }
  }
  if (prompt) return "prompt";
  if (hinted || choicesIn(screen).length) return "interactive";
  return "unknown";
}
