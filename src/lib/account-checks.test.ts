import assert from "node:assert/strict";
import { test } from "node:test";
import { healthPatchForResults, normalizeCheckLevels, type CheckResult } from "./account-checks.ts";
import { dueAccountCheckLevels } from "./account-check-scheduler.ts";
import type { Account } from "./types.ts";

function account(patch: Partial<Account> = {}): Account {
  return {
    id: "account-1",
    platform: "leonardo",
    email: "one@example.invalid",
    remark: "",
    status: "healthy",
    proxyId: "proxy-1",
    sessionPath: "storage/sessions/account-1.json",
    failCount: 0,
    totalRequests: 0,
    lastUsedAt: null,
    createdAt: "2026-08-20T00:00:00Z",
    ...patch,
  };
}

const at = "2026-08-29T00:00:00.000Z";

test("three-layer success records IP, expiry, score and next due time", () => {
  const results: CheckResult[] = [
    { ok: true, code: "SESSION_OK", detail: "ok", sessionExpiresAt: "2026-09-01T00:00:00.000Z" },
    { ok: true, code: "PROXY_OK", detail: "ok", observedIp: "203.0.113.4", ipState: "matched" },
    { ok: true, code: "LIVE_OK", detail: "ok", pageState: "WARM_IDLE" },
  ];
  const patch = healthPatchForResults(account(), results, at);
  assert.equal(patch.status, "healthy");
  assert.equal(patch.healthScore, 100);
  assert.equal(patch.loginIp, "203.0.113.4");
  assert.equal(patch.lastProbeIp, "203.0.113.4");
  assert.equal(patch.sessionExpiresAt, "2026-09-01T00:00:00.000Z");
  assert.equal(patch.lastPageState, "WARM_IDLE");
  assert.equal(patch.nextProbeAt, "2026-08-29T02:00:00.000Z");
});

test("transient failures need two consecutive checks but explicit session/IP failures isolate immediately", () => {
  const transient: CheckResult[] = [{ ok: false, code: "LIVE_CHECK_FAILED", detail: "network" }];
  const first = healthPatchForResults(account(), transient, at);
  assert.equal(first.status, "probing");
  assert.equal(first.consecutiveProbeFailures, 1);
  const second = healthPatchForResults(account({ consecutiveProbeFailures: 1 }), transient, at);
  assert.equal(second.status, "invalid");

  const session = healthPatchForResults(account(), [{ ok: false, code: "SESSION_EXPIRED", detail: "expired" }], at);
  assert.equal(session.status, "invalid");
  const drift = healthPatchForResults(account(), [{ ok: false, code: "IP_DRIFT", detail: "drift", ipState: "drift" }], at);
  assert.equal(drift.status, "invalid");
});

test("scheduler applies 15m/30m/2h cadence and accelerates near expiry", () => {
  const now = Date.parse(at);
  assert.deepEqual(dueAccountCheckLevels({}, now), ["static", "proxy", "live"]);
  assert.deepEqual(
    dueAccountCheckLevels(
      {
        lastStaticProbeAt: "2026-08-28T23:50:00Z",
        lastProxyProbeAt: "2026-08-28T23:20:00Z",
        lastLiveProbeAt: "2026-08-28T22:30:00Z",
      },
      now,
    ),
    ["proxy"],
  );
  assert.deepEqual(
    dueAccountCheckLevels({ lastLiveProbeAt: "2026-08-28T23:20:00Z", expiresAt: "2026-08-29T12:00:00Z" }, now),
    ["static", "proxy", "live"],
  );
});

test("check level input is bounded and deduplicated", () => {
  assert.deepEqual(normalizeCheckLevels(["live", "static", "live", "paid"]), ["live", "static"]);
});
