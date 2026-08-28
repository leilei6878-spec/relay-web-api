import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibilityReason, listEligible } from "./eligibility.ts";
import type { Account, GatewaySettings } from "./types.ts";

const settings = { enforceProxy: false } as GatewaySettings;

function account(id: string, lastUsedAt: unknown): Account {
  return {
    id,
    platform: "leonardo",
    email: `${id}@test.invalid`,
    status: "healthy",
    sessionPath: `storage/sessions/${id}.json`,
    lastUsedAt,
  } as Account;
}

test("eligible account ordering accepts PostgreSQL Date timestamps", () => {
  const older = account("older", new Date("2026-08-28T10:00:00Z"));
  const newer = account("newer", "2026-08-28T11:00:00Z");
  const never = account("never", null);
  const rows = listEligible([newer, older, never], [], settings, "leonardo");
  assert.deepEqual(rows.map((row) => row.id), ["never", "older", "newer"]);
});

test("expired business accounts and IP drift fail closed", () => {
  const expired = account("expired", null);
  expired.expiresAt = "2026-08-28T00:00:00Z";
  assert.equal(eligibilityReason(expired, [], settings, Date.parse("2026-08-29T00:00:00Z")), "业务已过期");

  const drift = account("drift", null);
  drift.ipState = "drift";
  assert.equal(eligibilityReason(drift, [], settings), "登录 IP 漂移");
});
