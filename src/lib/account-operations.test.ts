import assert from "node:assert/strict";
import { test } from "node:test";
import { accountOperationalView, normalizeAccountOperationsPatch } from "./account-operations.ts";
import type { Account, GatewaySettings, Proxy } from "./types.ts";

const now = Date.parse("2026-08-29T00:00:00Z");
const settings = { enforceProxy: true } as GatewaySettings;
const proxies: Proxy[] = [
  {
    id: "px-jp",
    name: "Japan-BGP",
    type: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: "",
    stickySessionId: "jp",
    region: "Tokyo",
    status: "active",
    maxAccounts: 8,
    remark: "",
    createdAt: new Date(now).toISOString(),
    lastCheckIp: "203.0.113.9",
  },
];

function account(id: string, patch: Partial<Account> = {}): Account {
  return {
    id,
    platform: "leonardo",
    email: `${id}@example.invalid`,
    remark: "",
    status: "healthy",
    proxyId: "px-jp",
    sessionPath: `storage/sessions/${id}.json`,
    failCount: 0,
    totalRequests: 0,
    lastUsedAt: null,
    createdAt: "2026-08-20T00:00:00Z",
    ipState: "matched",
    autoCheck: true,
    ...patch,
  };
}

test("account operations searches email, remark, tags, proxy and IP together", () => {
  const plane = {
    accounts: [
      account("alpha", { remark: "priority art", tags: ["batch-red"], loginIp: "203.0.113.9" }),
      account("beta", { remark: "ordinary" }),
    ],
    proxies,
    settings,
    savedAt: "",
  };
  assert.equal(accountOperationalView(plane, { q: "priority" }, now).total, 1);
  assert.equal(accountOperationalView(plane, { q: "batch-red" }, now).rows[0]?.id, "alpha");
  assert.equal(accountOperationalView(plane, { q: "tokyo" }, now).total, 2);
  assert.equal(accountOperationalView(plane, { q: "203.0.113.9" }, now).total, 2);
});

test("account operations separates health availability, schedulability and expiry", () => {
  const plane = {
    accounts: [
      account("ready", { expiresAt: "2026-08-30T00:00:00Z" }),
      account("busy", { lockedUntil: "2026-08-29T01:00:00Z" }),
      account("expired", { expiresAt: "2026-08-28T00:00:00Z" }),
      account("drift", { ipState: "drift" }),
    ],
    proxies,
    settings,
    savedAt: "",
  };
  const view = accountOperationalView(plane, {}, now);
  assert.deepEqual(view.stats, {
    total: 4,
    available: 2,
    schedulable: 1,
    busy: 1,
    expiring24h: 1,
    expiring7d: 1,
    invalid: 0,
    ipDrift: 1,
    pendingCheck: 4,
  });
  assert.equal(accountOperationalView(plane, { expiry: "expired" }, now).rows[0]?.id, "expired");
});

test("account metadata patch normalizes dates, tags and rejects invalid status", () => {
  const patch = normalizeAccountOperationsPatch({
    remark: "  managed  ",
    batch: "  2026-A ",
    tags: [" vip ", "vip", "image"],
    expiresAt: "2026-09-01",
    autoCheck: false,
  });
  assert.equal(patch.remark, "managed");
  assert.equal(patch.batch, "2026-A");
  assert.deepEqual(patch.tags, ["vip", "image"]);
  assert.equal(patch.expiresAt, "2026-09-01T00:00:00.000Z");
  assert.equal(patch.autoCheck, false);
  assert.throws(() => normalizeAccountOperationsPatch({ status: "deleted" }), /状态无效/);
});
