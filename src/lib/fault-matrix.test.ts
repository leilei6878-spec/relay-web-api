import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, FAILURE_MATRIX, normalizeError } from "./fault-matrix.ts";

test("every required error code has a decision", () => {
  const required = [
    "ACCOUNT_SESSION_EXPIRED",
    "ACCOUNT_BANNED",
    "ACCOUNT_RATE_LIMIT",
    "PROXY_UNAVAILABLE",
    "PROXY_TIMEOUT",
    "PROXY_IDENTITY_MISMATCH",
    "WORKER_CRASH",
    "WORKER_TIMEOUT",
    "PROVIDER_DOM_CHANGED",
    "PROVIDER_UNAVAILABLE",
    "GENERATION_TIMEOUT",
    "IMAGE_NOT_FOUND",
    "REQUEST_CANCELLED",
    "INTERNAL_ERROR",
    "MODEL_MISMATCH",
    "MODEL_SELECTION_UNCONFIRMED",
    "SUBMISSION_UNCERTAIN",
    "RESULT_UNCERTAIN",
  ];
  for (const code of required) {
    assert.ok(FAILURE_MATRIX[code as keyof typeof FAILURE_MATRIX], code);
  }
});

test("PROVIDER_DOM_CHANGED does not switch accounts or bump health", () => {
  const d = decide("DOM_CHANGED: composer missing");
  assert.equal(d.code, "PROVIDER_DOM_CHANGED");
  assert.equal(d.fault_domain, "provider");
  assert.equal(d.switch_account, false);
  assert.equal(d.retry_same_account, false);
  assert.equal(d.account_health_effect, "none");
  assert.equal(d.provider_circuit_effect, "trip");
});

test("session expired switches account and marks invalid", () => {
  const d = decide("SESSION_INVALID: login wall");
  assert.equal(d.code, "ACCOUNT_SESSION_EXPIRED");
  assert.equal(d.switch_account, true);
  assert.equal(d.account_health_effect, "invalid");
});

test("LOGIN_REQUIRED is session, CHALLENGE is not, DOM miss does not pollute pool", () => {
  const login = decide("LOGIN_REQUIRED: provider login wall");
  assert.equal(login.code, "ACCOUNT_SESSION_EXPIRED");
  assert.equal(login.account_health_effect, "invalid");
  const challenge = decide("CHALLENGE: captcha or bot wall");
  assert.equal(challenge.code, "ACCOUNT_RATE_LIMIT");
  assert.equal(challenge.account_health_effect, "cool");
  const dom = decide("PROVIDER_DOM_CHANGED: selector miss (page_state=AUTHENTICATED)");
  assert.equal(dom.code, "PROVIDER_DOM_CHANGED");
  assert.equal(dom.account_health_effect, "none");
  assert.equal(dom.switch_account, false);
});

test("normalizeError maps unconfirmed model", () => {
  assert.equal(normalizeError("MODEL_SELECTION_UNCONFIRMED: empty switcher"), "MODEL_SELECTION_UNCONFIRMED");
});

test("LEONARDO_DOM_CHANGED does not switch accounts or bump health", () => {
  const d = decide("LEONARDO_DOM_CHANGED: composer missing");
  assert.equal(d.code, "LEONARDO_DOM_CHANGED");
  assert.equal(d.switch_account, false);
  assert.equal(d.account_health_effect, "none");
  assert.equal(d.provider_circuit_effect, "trip");
});

test("LEONARDO_TOKEN_EXHAUSTED switches account", () => {
  const d = decide("LEONARDO_TOKEN_EXHAUSTED");
  assert.equal(d.switch_account, true);
  assert.equal(d.account_health_effect, "cool");
});

test("assigned proxy failure never rebinds the account", () => {
  const down = decide("PROXY_UNAVAILABLE: assigned proxy unreachable");
  assert.equal(down.code, "PROXY_UNAVAILABLE");
  assert.equal(down.switch_account, false);
  assert.equal(down.switch_proxy, false);
  const drift = decide("PROXY_IDENTITY_MISMATCH: expected socks5://127.0.0.1:18080 got socks5://127.0.0.1:10808");
  assert.equal(drift.code, "PROXY_IDENTITY_MISMATCH");
  assert.equal(drift.switch_account, false);
  assert.equal(drift.switch_proxy, false);
  assert.equal(drift.retry_same_account, false);
});

test("post-submit uncertain never switches account or retries generation", () => {
  const send = decide("SEND_NOT_ACKED: message did not enter conversation");
  assert.equal(send.code, "SUBMISSION_UNCERTAIN");
  assert.equal(send.switch_account, false);
  assert.equal(send.retry_same_account, false);
  const uncertain = decide("SUBMISSION_UNCERTAIN: generate did not start (img2img)");
  assert.equal(uncertain.code, "SUBMISSION_UNCERTAIN");
  assert.equal(uncertain.switch_account, false);
  const result = decide("RESULT_UNCERTAIN: LEONARDO_RESULT_NOT_FOUND");
  assert.equal(result.code, "RESULT_UNCERTAIN");
  assert.equal(result.switch_account, false);
  assert.equal(result.retry_same_account, false);
  const timeout = decide("GENERATION_TIMEOUT: wait");
  assert.equal(timeout.retry_same_account, false);
  assert.equal(timeout.switch_account, false);
  const failed = decide("LEONARDO_GENERATION_FAILED: generate did not start");
  assert.equal(failed.switch_account, false);
  assert.equal(failed.retry_same_account, false);
});
