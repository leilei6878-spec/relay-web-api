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
