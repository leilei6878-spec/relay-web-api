import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_INVOKE_TIMEOUT_MS, invokeTimeoutMessage, LEONARDO_API_WAIT_MS, LEONARDO_JOB_TIMEOUT_MS } from "./image-timeout.ts";

test("Leonardo timeout budget keeps API and admin waits outside the worker deadline", () => {
  assert.ok(LEONARDO_JOB_TIMEOUT_MS > LEONARDO_API_WAIT_MS);
  assert.equal(LEONARDO_JOB_TIMEOUT_MS - LEONARDO_API_WAIT_MS, 10_000);
  assert.ok(ADMIN_INVOKE_TIMEOUT_MS > LEONARDO_JOB_TIMEOUT_MS);
});

test("invoke timeout message distinguishes text generation from image edit", () => {
  assert.match(invokeTimeoutMessage("/v1/images/generations", { prompt: "apple" }), /文生图/);
  assert.match(invokeTimeoutMessage("/v1/images/generations", { prompt: "apple", images: ["data:image/png;base64,AA"] }), /图生图/);
  assert.match(invokeTimeoutMessage("/v1/images/edits", { prompt: "apple" }), /图生图/);
  assert.match(invokeTimeoutMessage("/v1/chat/completions", {}), /对话/);
});
