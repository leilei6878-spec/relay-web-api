import assert from "node:assert/strict";
import { test } from "node:test";
import { queueAdmissionError } from "./queue-admission.ts";
import { withQueueAdmission } from "./queue-admission.ts";
import { resetCoordForTests } from "./coord.ts";

const env = {
  RELAY_QUEUE_CAP: "10",
  RELAY_PROVIDER_QUEUE_CAP: "8",
  RELAY_CHAT_QUEUE_CAP: "6",
  RELAY_IMAGE_QUEUE_CAP: "4",
  RELAY_KEY_QUEUE_CAP: "2",
} as NodeJS.ProcessEnv;

test("queue admission reports global/provider/capability/key scopes", () => {
  assert.match(queueAdmissionError({ global: 10, provider: 0, capability: 0, key: 0 }, "chatgpt", true, env) || "", /scope=global/);
  assert.match(queueAdmissionError({ global: 1, provider: 8, capability: 0, key: 0 }, "gemini", true, env) || "", /scope=provider/);
  assert.match(queueAdmissionError({ global: 1, provider: 1, capability: 4, key: 0 }, "leonardo", true, env) || "", /scope=capability/);
  assert.match(queueAdmissionError({ global: 1, provider: 1, capability: 1, key: 2 }, "chatgpt", true, env) || "", /scope=key/);
  assert.equal(queueAdmissionError({ global: 1, provider: 1, capability: 1, key: 99 }, "chatgpt", false, env), null);
});

test("distributed admission lock never inserts past the cap", async () => {
  resetCoordForTests();
  let active = 0;
  const capped = { ...env, RELAY_QUEUE_CAP: "3", RELAY_PROVIDER_QUEUE_CAP: "3", RELAY_CHAT_QUEUE_CAP: "3", RELAY_KEY_QUEUE_CAP: "3" };
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      withQueueAdmission({
        platform: "chatgpt",
        hasKey: true,
        env: capped,
        readCounts: async () => ({ global: active, provider: active, capability: active, key: active }),
        insert: async () => {
          active += 1;
          return index;
        },
      }),
    ),
  );
  assert.equal(active, 3);
  assert.equal(results.filter((result) => result.inserted !== null).length, 3);
  assert.equal(results.filter((result) => result.error?.includes("QUEUE_FULL")).length, 7);
});
