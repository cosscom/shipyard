import type { IncomingMessage, ServerResponse } from "node:http";

import { fromEnv, MAX_BODY, relay } from "./relay.ts";

// The Vercel function: Node's request turned into a web Request for the
// relay, and its Response written back. build.mjs bundles this file.

let handle: ReturnType<typeof relay> | undefined;

export default async function (req: IncomingMessage, res: ServerResponse) {
  try {
    handle ??= relay(fromEnv(process.env));
  } catch (err) {
    console.error(`relay misconfigured: ${(err as Error).message}`);
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "the relay isn't set up" }));
    return;
  }
  // Read a little past the limit, so the relay can tell a body is too big.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY + 1) break;
    chunks.push(c as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  const request = new Request(`https://${req.headers.host ?? "push.berthd.app"}${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  // Vercel sets x-forwarded-for to the caller's address, first.
  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const response = await handle(request, ip);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
