import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeAvailability } from "./account-analytics.ts";
import type { Account, GatewaySettings, Proxy } from "./types.ts";

const now = Date.parse("2026-08-29T00:00:00Z");
const proxy: Proxy = {
  id: "proxy-1",
  name: "JP",
  type: "socks5",
  host: "127.0.0.1",
  port: 1080,
  username: "",
  stickySessionId: "jp",
  region: "JP",
  status: "active",
  maxAccounts: 8,
  remark: "",
  createdAt: new Date(now).toISOString(),
};
const settings = { enforceProxy: true } as GatewaySettings;

function account(id: string, patch: Partial<Account> = {}): Account {
  return {
    id,
    platform: "leonardo",
    email: `${id}@example.invalid`,
    remark: "",
    status: "healthy",
    proxyId: proxy.id,
    sessionPath: `storage/sessions/${id}.json`,
    failCount: 0,
    totalRequests: 0,
    lastUsedAt: null,
    createdAt: "2026-08-20T00:00:00Z",
    ipState: "matched",
    ...patch,
  };
}

test("availability snapshot keeps health, schedulability, expiry and IP counters distinct", () => {
  const summary = summarizeAvailability(
    [
      account("ready", { expiresAt: "2026-08-29T12:00:00Z" }),
      account("busy", { lockedUntil: "2026-08-29T01:00:00Z" }),
      account("drift", { ipState: "drift" }),
      account("invalid", { status: "invalid" }),
    ],
    [proxy],
    settings,
    now,
  );
  assert.deepEqual(summary, {
    total: 4,
    available: 2,
    schedulable: 1,
    busy: 1,
    expiring24h: 1,
    expiring7d: 1,
    invalid: 1,
    ipDrift: 1,
  });
});
