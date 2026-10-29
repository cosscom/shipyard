import type { Client } from "@/lib/api";
import type { QuestionAnswer } from "../../../packages/core/src/questions.ts";

export * from "../../../packages/core/src/questions.ts";

// The box fills in Claude Code's form with keys from the whole answer set
// (the "answer" capability).
export const answerQuestions = (c: Client, box: string, session: string, req: { tool: string; answers: QuestionAnswer[] }) =>
  c.box<{ answered: string[] }>(box, "POST", `sessions/${encodeURIComponent(session)}/answer`, req);
