import type { TranscriptItem } from "@berth/core/transcript.ts";

import type { PhoneTranscript } from "./types";

// The box's answers, in order; the store reads its conversation with them.
const answers: PhoneTranscript[] = [];
const asked: { since: number; gen?: string }[] = [];
jest.mock("./api", () => ({
  can: () => true,
  phone: {
    transcript: jest.fn(async (_b: unknown, _s: string, since: number, gen?: string) => {
      asked.push({ since, gen });
      return answers.shift();
    }),
  },
}));
jest.mock("./storage", () => ({ loadBoxes: async () => [], saveBoxes: async () => undefined, toBox: (b: unknown) => b }));

import { convKey, useStore } from "./store";

const text = (id: string, t: string, off = 0): TranscriptItem => ({ kind: "text", id, text: t, ...(off ? { off } : {}) }) as TranscriptItem;
const key = convKey("devl", "acme");

beforeEach(() => {
  answers.length = 0;
  asked.length = 0;
  useStore.setState({ boxes: [{ id: "devl", name: "devl", url: "http://100.64.0.7:1379", token: "t" }], conversations: {} });
});

test("a conversation grows from where it was read, and replaces what the box sends again", async () => {
  answers.push(
    { source: "claude", items: [text("a", "Reading"), text("b", "Running tests…")], next: 2, gen: "g1", record: "r1" },
    { source: "claude", items: [text("b", "Tests pass."), text("c", "Done.")], next: 3, gen: "g1", record: "r1" },
  );
  await useStore.getState().readConversation("devl", "acme");
  await useStore.getState().readConversation("devl", "acme");
  expect(asked).toEqual([{ since: 0, gen: undefined }, { since: 2, gen: "g1" }]);
  expect(useStore.getState().conversations[key].items.map((i) => (i as { text: string }).text)).toEqual(["Reading", "Tests pass.", "Done."]);
});

test("a window read afresh keeps what came before it", async () => {
  answers.push(
    { source: "claude", items: [text("a", "old", 10), text("b", "kept", 20)], next: 2, gen: "g1", record: "r1" },
    { source: "claude", items: [text("b", "kept", 20), text("c", "new", 30)], next: 2, gen: "g2", reset: true, start: 20, record: "r1" },
  );
  await useStore.getState().readConversation("devl", "acme");
  await useStore.getState().readConversation("devl", "acme");
  expect(useStore.getState().conversations[key].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
});

test("another conversation in the same session starts the chat over", async () => {
  answers.push(
    { source: "claude", items: [text("a", "before /clear")], next: 1, gen: "g1", record: "r1" },
    { source: "claude", items: [text("x", "after /clear")], next: 1, gen: "g1", record: "r2" },
  );
  await useStore.getState().readConversation("devl", "acme");
  await useStore.getState().readConversation("devl", "acme");
  expect(useStore.getState().conversations[key].items.map((i) => i.id)).toEqual(["x"]);
});

test("a failed read keeps what was shown and says why", async () => {
  answers.push({ source: "claude", items: [text("a", "hi")], next: 1, record: "r1" });
  await useStore.getState().readConversation("devl", "acme");
  // An answer the box never gave: the mock returns undefined.
  await useStore.getState().readConversation("devl", "acme");
  const c = useStore.getState().conversations[key];
  expect(c.items.map((i) => i.id)).toEqual(["a"]);
  expect(c.error).toBeTruthy();
});
