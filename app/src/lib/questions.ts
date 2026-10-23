import type { Client } from "@/lib/api";
import type { TranscriptItem } from "@/lib/transcript";

// Questions an agent asks with a form of its own: Claude Code's
// AskUserQuestion (one to four questions, each with its options, some
// taking several picks, each with room for the person's own words) and
// Codex's request_user_input. The box reads them from the agent's record
// (a "question" item) and, for Claude Code, fills in its form with keys
// from the whole answer set (POST …/answer, the "answer" capability),
// checking its screen after every key.

export interface Question {
  question: string;
  header?: string;
  // Takes several picks (checkboxes) rather than one (radios).
  multi?: boolean;
  options: { label: string; description?: string }[];
  // Codex's name for the question.
  id?: string;
}

// One question's answer: the options picked, by label, and the person's
// own words (Other).
export interface QuestionAnswer {
  picks: string[];
  other?: string;
}

export const answerQuestions = (c: Client, box: string, session: string, req: { tool: string; answers: QuestionAnswer[] }) =>
  c.box<{ answered: string[] }>(box, "POST", `sessions/${encodeURIComponent(session)}/answer`, req);

// shownAnswer is an answer as the agent shows it: the options picked, in
// their order, then the person's own words.
export function shownAnswer(q: Question, a: QuestionAnswer | undefined): string {
  if (!a) return "";
  const parts = q.options.filter((o) => a.picks.includes(o.label)).map((o) => o.label);
  const other = (a.other ?? "").replace(/\s+/g, " ").trim();
  if (other) parts.push(other);
  return parts.join(", ");
}

// complete says a question has its answer: one pick or the person's words
// for a single choice, at least one of either for several.
export function complete(q: Question, a: QuestionAnswer | undefined): boolean {
  if (!a) return false;
  const n = a.picks.length + ((a.other ?? "").trim() ? 1 : 0);
  return q.multi ? n > 0 : n === 1;
}

// answersText is every answer as plain text, one line each under its
// question's name, for the person to paste into the agent's own screen
// when the box couldn't fill in its form.
export function answersText(questions: Question[], answers: (QuestionAnswer | undefined)[]): string {
  return questions.map((q, i) => `${q.header || q.question.split("\n")[0]}: ${shownAnswer(q, answers[i]) || "—"}`).join("\n");
}

// lastQuestion is the form of questions the agent asked last, unless the
// person has spoken since. Another agent's word after it (a helper back
// from the background, its hand-back) is no answer.
export function lastQuestion(items: TranscriptItem[]): Extract<TranscriptItem, { kind: "question" }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "question") return it;
    if (it.kind === "user") return undefined;
  }
}

// What a waiting agent offers the chat to answer it with.
export interface Waiting {
  // Runs structured (lib/structured): it has no screen of its own.
  structured: boolean;
  // A form of questions from its record, and whether the box fills it in.
  form: boolean;
  answerable: boolean;
  // Its screen shows a form no one number answers.
  screenForm: boolean;
  // The options read (its screen's, or its ask's), and whether they are
  // still being read.
  choices: number;
  reading: boolean;
  // Its hooks or its driver said what it asks.
  asked: boolean;
  // The question card drawn, not yet answered: its options, and whether
  // its hooks described it.
  card?: { choices: number; hooks: boolean };
  // An option picked that asks for words, which the reply box types.
  wantsWords: boolean;
}

// atMenu says the reply box waits for a pick above: Enter there would pick
// for the agent. A structured agent has no screen to answer at, so only
// something to pick here holds it; with nothing, the reply is the answer
// (its box says no to the ask and gives the agent the words).
export function atMenu(w: Waiting): boolean {
  if (w.wantsWords) return false;
  const card = w.card?.choices ?? 0;
  if (w.structured) return w.answerable || w.reading || w.choices > 0 || card > 0;
  return w.form || w.screenForm || w.choices > 0 || w.asked || card > 0 || !!w.card?.hooks;
}
