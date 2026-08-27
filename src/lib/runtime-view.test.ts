import assert from "node:assert/strict";
import { test } from "node:test";
import { onlineWorkerCount } from "./runtime-view.ts";

test("dashboard tolerates failed or partial runtime responses", () => {
  assert.equal(onlineWorkerCount(null), 0);
  assert.equal(onlineWorkerCount({}), 0);
  assert.equal(onlineWorkerCount({ workers: [{ online: true }, { online: false }, {}] }), 1);
});
