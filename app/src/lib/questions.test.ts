// node --experimental-strip-types --test src/lib/questions.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { TranscriptItem } from "./transcript.ts";
import { answersText, atMenu, lastQuestion, type Question, type Waiting } from "./questions.ts";

const qs: Question[] = [
  { question: "How should acme roll out the new checkout?\n1. The old flow stays behind a flag.", header: "Rollout", options: [{ label: "Flag first" }, { label: "All at once" }] },
  { question: "Which checks run first?", header: "Checks", multi: true, options: [{ label: "Unit tests" }, { label: "E2E" }] },
  { question: "Anything else before we start?", options: [{ label: "Nothing" }] },
];

test("copied answers are one line each, under the question's name", () => {
  const text = answersText(qs, [{ picks: [], other: "Flag first, but  staff only\nuntil Monday." }, { picks: ["E2E", "Unit tests"], other: "smoke" }, undefined]);
  assert.equal(text, ["Rollout: Flag first, but staff only until Monday.", "Checks: Unit tests, E2E, smoke", "Anything else before we start?: —"].join("\n"));
});

test("a question without a header is named by its first line", () => {
  assert.equal(answersText([{ ...qs[0], header: undefined }], [{ picks: ["Flag first"] }]), "How should acme roll out the new checkout?: Flag first");
});

const asked: TranscriptItem = { kind: "question", id: "q", tool: "toolu_q", questions: qs };
const prompt: TranscriptItem = { kind: "user", id: "u", text: "Draft the acme release notes" };
const back: TranscriptItem = { kind: "ping", id: "p", msg: { from: { id: "a1", name: "Tally the changes", kind: "helper" }, status: "done" } };
const handedBack: TranscriptItem = { kind: "agent-message", id: "m", msg: { from: { id: "a2", name: "Take the screenshots", kind: "helper" }, intent: "report", body: "Six screenshots." } };

// The form the agent waits on, as the chat reads it.
const openQuestion = (items: TranscriptItem[]) => {
  const q = lastQuestion(items);
  return q?.done ? undefined : q;
};

test("a question stays open while the agent's helpers report back, until the person speaks", () => {
  assert.equal(openQuestion([prompt, asked]), asked);
  // One helper back after it, then another's hand-back.
  assert.equal(openQuestion([prompt, asked, back]), asked);
  assert.equal(openQuestion([prompt, asked, back, handedBack]), asked);
  // A helper back before it changes nothing.
  assert.equal(openQuestion([prompt, back, asked]), asked);
  // The person answered in words, or the form was answered.
  assert.equal(openQuestion([prompt, asked, back, { ...prompt, id: "u2" }]), undefined);
  assert.equal(openQuestion([prompt, { ...asked, done: true }, back]), undefined);
  // Asked before the person's last prompt: answered by it.
  assert.equal(openQuestion([asked, prompt]), undefined);
  assert.equal(openQuestion([]), undefined);
  // Answered, it is still the last one asked: the box's wait for it ends a
  // moment later.
  const answered = { ...asked, done: true };
  assert.equal(lastQuestion([prompt, answered, back]), answered);
  assert.equal(lastQuestion([answered, prompt]), undefined);
});

const waiting: Waiting = { structured: false, form: false, answerable: false, screenForm: false, choices: 0, reading: false, asked: false, wantsWords: false };

test("a structured agent's ask holds the reply box only while there is something to pick", () => {
  const s = { ...waiting, structured: true, asked: true };
  // Nothing to pick (a question whose form isn't read, a permission whose
  // options aren't): the reply answers it.
  assert.equal(atMenu({ ...s, card: { choices: 0, hooks: true } }), false);
  assert.equal(atMenu({ ...s, form: true, card: { choices: 0, hooks: true } }), false);
  // A form the box fills in, options to pick, or options still being read.
  assert.equal(atMenu({ ...s, form: true, answerable: true }), true);
  assert.equal(atMenu({ ...s, choices: 3, card: { choices: 3, hooks: true } }), true);
  assert.equal(atMenu({ ...s, reading: true, card: { choices: 0, hooks: true } }), true);
  // An option that wants words.
  assert.equal(atMenu({ ...s, choices: 3, wantsWords: true }), false);
});

test("an agent in its terminal keeps its ask's hold on the reply box: its own screen answers it", () => {
  assert.equal(atMenu({ ...waiting, asked: true, card: { choices: 0, hooks: true } }), true);
  assert.equal(atMenu({ ...waiting, form: true }), true);
  assert.equal(atMenu({ ...waiting, screenForm: true }), true);
  assert.equal(atMenu({ ...waiting, choices: 2, card: { choices: 2, hooks: false } }), true);
  assert.equal(atMenu(waiting), false);
  assert.equal(atMenu({ ...waiting, asked: true, wantsWords: true }), false);
});
