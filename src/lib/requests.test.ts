import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addAttempt,
  attemptsFor,
  completeRequest,
  createRelayRequest,
  finishAttempt,
  getRequest,
  resetRequestsForTests,
} from "./requests.ts";

test("failover adds attempts on the same client request", async () => {
  resetRequestsForTests();
  const { request } = await createRelayRequest({
    id: "R1",
    idempotencyKey: "k1",
    provider: "chatgpt",
    model: "gpt-5.6",
    keyId: "key-1",
  });
  const a1 = await addAttempt({ id: "A1", requestId: request.id, accountId: "acct-1", jobId: "j1" });
  await finishAttempt(a1.id, { ok: false, errorCode: "ACCOUNT_SESSION_EXPIRED", faultDomain: "account" });
  const a2 = await addAttempt({ id: "A2", requestId: request.id, accountId: "acct-2", jobId: "j2" });
  await finishAttempt(a2.id, { ok: true, result: { text: "hi" } });
  await completeRequest(request.id, { ok: true, finalAttemptId: a2.id });
  const done = getRequest("R1");
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.finalAttemptId, "A2");
  const attempts = attemptsFor("R1");
  assert.equal(attempts.length, 2);
  assert.equal(attempts.find((a) => a.id === "A1")?.status, "failed");
  assert.equal(attempts.find((a) => a.id === "A2")?.status, "succeeded");
});

test("idempotent createRelayRequest does not mint a second request", async () => {
  resetRequestsForTests();
  const a = await createRelayRequest({ idempotencyKey: "same", provider: "chatgpt", model: "gpt-5.6" });
  const b = await createRelayRequest({ idempotencyKey: "same", provider: "chatgpt", model: "gpt-5.6" });
  assert.equal(a.request.id, b.request.id);
  assert.equal(b.replay, true);
});
