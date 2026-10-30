// node --experimental-strip-types --test src/lib/usage-py.test.ts (pnpm test)
// Runs usage.py's own tests (plugins/usage/box/usage_test.py) in the app's
// test run, so the box-side script is checked where CI checks everything else.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const box = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "usage", "box");
const python = spawnSync("python3", ["--version"]).status === 0;

test("usage.py reads Claude Code's /usage", { skip: !python && "no python3" }, () => {
  // A hung run fails the test rather than holding up the whole suite.
  const r = spawnSync("python3", ["-m", "unittest", "-q", "usage_test.py"], { cwd: box, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
