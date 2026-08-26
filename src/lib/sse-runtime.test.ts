import assert from "node:assert/strict";
import { test } from "node:test";
import { attachSseLifecycle, sseUsageChunk } from "./sse-runtime.ts";
import { nextSseDelta } from "./job-events.ts";

test("nextSseDelta only appends new suffix", () => {
  const a = "这张图属于宠物海报。";
  assert.equal(nextSseDelta("", a), a);
  assert.equal(nextSseDelta(a, a + " 7.6/10"), " 7.6/10");
  assert.equal(nextSseDelta(a, a), "");
  assert.equal(nextSseDelta(a, "| 维度 | 评分 |\\n" + a), "");
});

test("SSE timeout fires", async () => {
  const life = attachSseLifecycle({ timeoutMs: 20 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(life.reason(), "timeout");
  life.dispose();
});

test("SSE disconnect from AbortSignal", async () => {
  const ac = new AbortController();
  const life = attachSseLifecycle({ signal: ac.signal, timeoutMs: 5_000 });
  ac.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(life.reason(), "disconnect");
  life.dispose();
});

test("usage chunk is present on finish", () => {
  const chunk = sseUsageChunk("gpt-5.6", "abc", 10, 20);
  assert.equal(chunk.usage.total_tokens, 30);
  assert.equal(chunk.relay.phase, "usage");
  assert.equal(chunk.choices[0]?.finish_reason, "stop");
});
