// Runs the Usage plugin's box-side tests (plugins/usage/box/usage_test.py)
// with the app's, so CI checks usage.py too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const box = join(dirname(fileURLToPath(import.meta.url)), "../../../plugins/usage/box");
const python = spawnSync("python3", ["--version"]).status === 0;

test("usage.py reads Claude Code's /usage", { skip: !python && "no python3" }, () => {
  const r = spawnSync("python3", ["-m", "unittest", "-q", "usage_test.py"], { cwd: box, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
