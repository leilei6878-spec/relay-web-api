import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySseOutcome,
  historyBadgeOk,
  phaseFromLogical,
  readSse,
} from "./sse-client.ts";

function sseResponse(chunks: unknown[], status = 200) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

test("sse partial then error is not success", async () => {
  const res = sseResponse([
    { choices: [{ delta: { content: "我是" } }], relay: { phase: "streaming" } },
    { error: { message: "RESULT_UNCERTAIN: assistant stream ended without confirmed completion" }, relay: { phase: "error" } },
  ]);
  const out = await readSse(res);
  assert.equal(out.transportStatus, 200);
  assert.equal(out.logicalStatus, "uncertain");
  assert.equal(out.completed, false);
  assert.equal(out.partialText, "我是");
  assert.equal(out.ssePartialBeforeError, true);
  assert.equal(historyBadgeOk(out.logicalStatus), false);
  assert.equal(phaseFromLogical(out.logicalStatus), "error");
});

test("sse partial then finalText done is success", async () => {
  const res = sseResponse([
    { choices: [{ delta: { content: "我是" } }], relay: { phase: "streaming" } },
    { choices: [{ delta: { content: " GPT-5.6。" } }], relay: { phase: "streaming" } },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      relay: { phase: "done", logicalStatus: "success", finalText: "我是 GPT-5.6。" },
    },
  ]);
  const out = await readSse(res);
  assert.equal(out.logicalStatus, "success");
  assert.equal(out.completed, true);
  assert.equal(out.text, "我是 GPT-5.6。");
  assert.equal(historyBadgeOk(out.logicalStatus), true);
  assert.equal(phaseFromLogical(out.logicalStatus), "done");
});

test("sse error without text is failure everywhere", () => {
  const out = classifySseOutcome({
    transportStatus: 200,
    text: "",
    error: { message: "WORKER_DEAD: 没有在线的网页执行器" },
    phase: "error",
  });
  assert.equal(out.logicalStatus, "error");
  assert.equal(out.completed, false);
  assert.equal(out.partialText, "");
  assert.equal(historyBadgeOk(out.logicalStatus), false);
  assert.equal(phaseFromLogical(out.logicalStatus), "error");
});

test("history restore of HTTP 200 logical error stays failed", () => {
  const out = classifySseOutcome({
    transportStatus: 200,
    text: "我是",
    error: { message: "RESULT_UNCERTAIN: truncated" },
    phase: "error",
  });
  assert.equal(out.transportStatus, 200);
  assert.notEqual(out.logicalStatus, "success");
  assert.equal(phaseFromLogical(out.logicalStatus), "error");
  assert.equal(historyBadgeOk(out.logicalStatus), false);
});

test("HTTP 200 with partial and no done is not success", () => {
  const out = classifySseOutcome({
    transportStatus: 200,
    text: "我是",
    phase: "streaming",
  });
  assert.equal(out.logicalStatus, "uncertain");
  assert.equal(out.completed, false);
  assert.match(out.error?.message || "", /UNCERTAIN/);
});
