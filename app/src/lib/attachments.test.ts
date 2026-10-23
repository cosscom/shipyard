import assert from "node:assert/strict";
import { test } from "node:test";

import type { Client } from "@/lib/api";

import { attachApi, localPaths, MAX_ATTACHMENT } from "./attachments.ts";

// A client that records what it was asked to upload and answers as the box,
// and as the laptop agent for a file on this computer.
function fakeClient() {
  const calls: { box: string; path: string; body: Blob; onProgress?: unknown; signal?: AbortSignal }[] = [];
  const laptop: { method: string; path: string; body: unknown; signal?: AbortSignal }[] = [];
  const client = {
    upload: async (box: string, path: string, body: Blob, onProgress?: unknown, signal?: AbortSignal) => {
      calls.push({ box, path, body, onProgress, signal });
      const name = new URLSearchParams(path.split("?")[1]).get("name") ?? "";
      return { path: `/home/me/acme/.berth/attachments/${name}`, name, type: body.type, size: body.size };
    },
    laptop: async (method: string, path: string, body: unknown, signal?: AbortSignal) => {
      laptop.push({ method, path, body, signal });
      return { path: "/home/me/acme/.berth/attachments/20261022-101502-shot.png", name: "20261022-101502-shot.png", type: "image/png", size: 9 };
    },
  } as unknown as Client;
  return { client, calls, laptop };
}

test("a plugin's attach uploads into a running session's worktree", async () => {
  const { client, calls } = fakeClient();
  const signal = new AbortController().signal;
  const onProgress = () => {};
  const a = await attachApi(client, () => "100.64.0.7:7544")("devl", { session: "acme web" }, new File(["hi"], "notes.md", { type: "text/markdown" }), { onProgress, signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].box, "devl");
  assert.equal(calls[0].path, "sessions/acme%20web/attachments?name=notes.md");
  assert.equal(calls[0].onProgress, onProgress);
  assert.equal(calls[0].signal, signal);
  assert.deepEqual(a, { path: "/home/me/acme/.berth/attachments/notes.md", name: "notes.md", type: "text/markdown", size: 2 });
});

test("a plugin's attach uploads into a worktree an agent is about to start in", async () => {
  const { client, calls } = fakeClient();
  await attachApi(client, () => "100.64.0.7:7544")("devl", { location: "acme", worktree: "fix/login" }, new File(["x"], "trace.log", { type: "text/plain" }));
  assert.equal(calls[0].path, "locations/acme/worktrees/fix%2Flogin/attachments?name=trace.log");
});

test("a pasted image is named for when it was pasted, and a .json file goes as plain bytes", async () => {
  const { client, calls } = fakeClient();
  await attachApi(client, () => "100.64.0.7:7544")("devl", { session: "s" }, new File(["png"], "image.png", { type: "image/png" }));
  assert.match(calls[0].path, /^sessions\/s\/attachments\?name=pasted-\d{6}(-\d+)?\.png$/);
  await attachApi(client, () => "100.64.0.7:7544")("devl", { session: "s" }, new File(["{}"], "data.json", { type: "application/json" }));
  assert.equal(calls[1].body.type, "application/octet-stream");
});

test("a plugin's attach refuses a file over 20 MB without uploading it", async () => {
  const { client, calls } = fakeClient();
  const big = new File([new Uint8Array(MAX_ATTACHMENT + 1)], "dump.log", { type: "text/plain" });
  await assert.rejects(attachApi(client, () => "100.64.0.7:7544")("devl", { session: "s" }, big), { message: "dump.log is 20 MB; attachments can be up to 20 MB." });
  assert.equal(calls.length, 0);
});

test("a path on this computer goes up through the laptop agent, to a session or a new worktree", async () => {
  const { client, calls, laptop } = fakeClient();
  const attach = attachApi(client, () => "100.64.0.7:7544");
  const a = await attach("devl", { session: "acme web" }, "/Users/me/Desktop/shot.png");
  await attach("devl", { location: "acme", worktree: "fix/login" }, "/var/folders/xy/T/shot.png");
  assert.equal(calls.length, 0);
  assert.deepEqual(laptop, [
    { method: "POST", path: "/v1/boxes/devl/attach-local", body: { path: "/Users/me/Desktop/shot.png", session: "acme web" }, signal: undefined },
    { method: "POST", path: "/v1/boxes/devl/attach-local", body: { path: "/var/folders/xy/T/shot.png", location: "acme", worktree: "fix/login" }, signal: undefined },
  ]);
  assert.equal(a.path, "/home/me/acme/.berth/attachments/20261022-101502-shot.png");
});

test("a path's upload goes with the signal that stops it", async () => {
  const { client, laptop } = fakeClient();
  const stop = new AbortController();
  await attachApi(client, () => "100.64.0.7:7544")("devl", { session: "s" }, "/Users/me/Desktop/shot.png", { signal: stop.signal });
  assert.equal(laptop[0].signal, stop.signal);
});

test("a path on a box that runs on this computer is the box's own: it resolves as it is, with no upload", async () => {
  const { client, calls, laptop } = fakeClient();
  const a = await attachApi(client, () => "127.0.0.1:7544")("local", { session: "s" }, "/Users/me/Desktop/Shot 1.png");
  assert.equal(calls.length + laptop.length, 0);
  assert.deepEqual(a, { path: "/Users/me/Desktop/Shot 1.png", name: "Shot 1.png", type: "image/png", size: 0 });
});

test("pasted only shrinks what the app shrinks: a text file goes as it is", async () => {
  const { client, calls } = fakeClient();
  await attachApi(client, () => undefined)("devl", { session: "s" }, new File(["log"], "trace.log", { type: "text/plain" }), { pasted: true });
  assert.equal(calls[0].path, "sessions/s/attachments?name=trace.log");
  assert.equal(calls[0].body.size, 3);
});

test("localPaths finds the laptop paths a paste is made of, and nothing in other text", () => {
  assert.deepEqual(localPaths("/Users/me/Desktop/Shot\\ 1.png\nfile:///var/folders/xy/T/a%20b.pdf"), ["/Users/me/Desktop/Shot 1.png", "/var/folders/xy/T/a b.pdf"]);
  assert.deepEqual(localPaths("see /Users/me/Desktop/shot.png"), []);
});
