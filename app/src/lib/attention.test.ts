import assert from "node:assert/strict";
import { test } from "node:test";

import type { Client } from "@/lib/api";

import { makeAttentionApi } from "./attention.ts";

// A client that records the box calls and answers from a script.
function fakeClient(answer: (method: string, path: string) => unknown) {
  const calls: { box: string; method: string; path: string; body: unknown }[] = [];
  const client = {
    box: async (box: string, method: string, path: string, body?: unknown) => {
      calls.push({ box, method, path, body });
      return answer(method, path);
    },
  } as unknown as Client;
  return { client, calls };
}

const item = { key: "devl/shop/wait", revision: 2, kind: "mark", status: "open", created: "", updated: "" };

test("a key goes to the box path-escaped, slashes and all", async () => {
  const { client, calls } = fakeClient(() => item);
  const api = makeAttentionApi(client);
  await api.update("devl", "devl/shop/wait#3", { snoozed_until: "2026-11-07T08:00:00Z", revision: 1 });
  await api.get("devl", "devl/shop/wait#3");
  assert.deepEqual(
    calls.map((c) => [c.box, c.method, c.path]),
    [
      ["devl", "PATCH", "attention/devl%2Fshop%2Fwait%233"],
      ["devl", "GET", "attention/devl%2Fshop%2Fwait%233"],
    ],
  );
  assert.deepEqual(calls[0].body, { snoozed_until: "2026-11-07T08:00:00Z", revision: 1 });
});

test("list asks for one session's or the open items, and an empty answer is a list", async () => {
  const { client, calls } = fakeClient(() => null);
  const api = makeAttentionApi(client);
  assert.deepEqual(await api.list("devl", { session: "shop claude", open: true }), []);
  await api.list("devl");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["attention?session=shop+claude&open=1", "attention"],
  );
});

test("get is undefined for a key with no item, and other errors still reject", async () => {
  const notFound = Object.assign(new Error("no attention item with that key"), { status: 404, code: "not_found" });
  const offline = Object.assign(new Error("devl is offline"), { status: 502, code: "box_offline" });
  let next: Error = notFound;
  const { client } = fakeClient(() => {
    throw next;
  });
  const api = makeAttentionApi(client);
  assert.equal(await api.get("devl", "nope"), undefined);
  next = offline;
  await assert.rejects(api.get("devl", "nope"), /offline/);
});

test("post sends the ask as it is", async () => {
  const { client, calls } = fakeClient(() => item);
  await makeAttentionApi(client).post("devl", { session: "shop-claude", kind: "decision", title: "Which queue?", options: [{ label: "SQS" }], recommended: "SQS" });
  assert.deepEqual(calls[0], { box: "devl", method: "POST", path: "attention", body: { session: "shop-claude", kind: "decision", title: "Which queue?", options: [{ label: "SQS" }], recommended: "SQS" } });
});
