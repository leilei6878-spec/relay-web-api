import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_INVOKE_TIMEOUT_MS, LEONARDO_API_WAIT_MS, LEONARDO_JOB_TIMEOUT_MS } from "./image-timeout.ts";

test("Leonardo timeout budget keeps API and admin waits outside the worker deadline", () => {
  assert.ok(LEONARDO_JOB_TIMEOUT_MS > LEONARDO_API_WAIT_MS);
  assert.equal(LEONARDO_JOB_TIMEOUT_MS - LEONARDO_API_WAIT_MS, 10_000);
  assert.ok(ADMIN_INVOKE_TIMEOUT_MS > LEONARDO_JOB_TIMEOUT_MS);
});
