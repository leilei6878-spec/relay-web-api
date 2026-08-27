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

test("successful SSE preserves requested and actual model truth", async () => {
  const res = sseResponse([
    { choices: [{ delta: { content: "ok" } }], relay: { phase: "streaming" } },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      relay: {
        phase: "done",
        logicalStatus: "success",
        finalText: "ok",
        requested_model: "chatgpt-web-auto",
        actual_model: "unknown",
        actual_model_label: "ChatGPT",
        model_verified: false,
        requested_profile: "auto",
        actual_profile: "unknown",
        profile_verified: false,
      },
    },
  ]);
  const out = await readSse(res);
  assert.equal(out.logicalStatus, "success");
  assert.equal(out.requestedModel, "chatgpt-web-auto");
  assert.equal(out.actualModel, "unknown");
  assert.equal(out.actualModelLabel, "ChatGPT");
  assert.equal(out.modelVerified, false);
  assert.equal(out.requestedProfile, "auto");
  assert.equal(out.actualProfile, "unknown");
  assert.equal(out.profileVerified, false);
});

test("explicit logical error overrides contradictory done and stop", async () => {
  const res = sseResponse([
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      relay: {
        phase: "done",
        logicalStatus: "error",
        partialText: "仅有部分结果",
      },
    },
  ]);
  const out = await readSse(res);
  assert.equal(out.logicalStatus, "error");
  assert.equal(out.completed, false);
  assert.equal(out.phase, "error");
  assert.equal(out.finishReason, "error");
  assert.equal(out.text, "仅有部分结果");
  assert.equal(out.partialText, "仅有部分结果");
  assert.equal(out.ssePartialBeforeError, true);
});

test("terminal logical uncertainty preserves relay partial text without deltas", async () => {
  const res = sseResponse([
    {
      error: { message: "worker disconnected" },
      choices: [{ delta: {}, finish_reason: "stop" }],
      relay: {
        phase: "done",
        logicalStatus: "uncertain",
        partialText: "terminal-only partial",
      },
    },
  ]);
  const out = await readSse(res);
  assert.equal(out.logicalStatus, "uncertain");
  assert.equal(out.completed, false);
  assert.equal(out.partialText, "terminal-only partial");
  assert.equal(out.text, "terminal-only partial");
  assert.equal(out.finishReason, "uncertain");
});

test("explicit logical cancellation overrides done classification", () => {
  const out = classifySseOutcome({
    transportStatus: 200,
    text: "partial",
    phase: "done",
    finishReason: "stop",
    logicalStatus: "cancelled",
  });
  assert.equal(out.logicalStatus, "cancelled");
  assert.equal(out.completed, false);
  assert.equal(out.phase, "error");
  assert.equal(out.finishReason, "cancelled");
  assert.equal(historyBadgeOk(out.logicalStatus), false);
});
