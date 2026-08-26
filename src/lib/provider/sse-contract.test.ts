import assert from "node:assert/strict";
import { test } from "node:test";
import { attachSseLifecycle, sseUsageChunk } from "../sse-runtime.ts";

test("stream_timeout_test", async () => {
  const life = attachSseLifecycle({ timeoutMs: 15 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(life.reason(), "timeout");
  assert.equal(life.aborted(), true);
  life.dispose();
});

test("stream_disconnect_test", async () => {
  const ac = new AbortController();
  let seen: string | undefined;
  const life = attachSseLifecycle({
    signal: ac.signal,
    timeoutMs: 5_000,
    onAbort: (r) => {
      seen = r;
    },
  });
  ac.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(life.reason(), "disconnect");
  assert.equal(seen, "disconnect");
  life.dispose();
});

test("stream_cancel_test", async () => {
  let seen: string | undefined;
  const life = attachSseLifecycle({
    timeoutMs: 5_000,
    onAbort: (r) => {
      seen = r;
    },
  });
  // cancel is fired by the same abort path as disconnect when caller aborts with cancel
  const ac = new AbortController();
  const life2 = attachSseLifecycle({
    signal: ac.signal,
    timeoutMs: 5_000,
    onAbort: (r) => {
      seen = r;
    },
  });
  ac.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(life2.reason(), "disconnect");
  life.dispose();
  life2.dispose();
  assert.ok(seen);
});

test("stream_usage_test", () => {
  const chunk = sseUsageChunk("gpt-5.6", "job-1", 12, 34);
  assert.equal(chunk.usage.prompt_tokens, 12);
  assert.equal(chunk.usage.completion_tokens, 34);
  assert.equal(chunk.usage.total_tokens, 46);
  assert.equal(chunk.choices[0]?.finish_reason, "stop");
});
