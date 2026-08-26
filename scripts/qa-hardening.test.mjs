import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

test("worker python compiles", (t) => {
  const path = existsSync("/workspace/storage/worker.py") ? "/workspace/storage/worker.py" : "";
  if (!path) {
    t.skip("worker.py not bootstrapped");
    return;
  }
  const r = spawnSync("python3", ["-m", "py_compile", path], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
