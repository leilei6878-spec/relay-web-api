import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";
import "./test-env.ts";
import { resetCoordForTests } from "./coord.ts";
import { writeControlPlane } from "./control-plane.ts";
import { claimNext, cancelJob, enqueueChat, finishJob, getJob } from "./job-queue.ts";

process.env.RELAY_SKIP_DB = "1";

async function seed() {
  resetCoordForTests();
  const root = resolve(process.env.RELAY_STORAGE_DIR || "/tmp/relay-qa-storage");
  await mkdir(resolve(root, "sessions"), { recursive: true });
  await writeFile(resolve(root, "jobs.json"), JSON.stringify({ jobs: [], workers: [] }), "utf8");
  const a = `ac-${crypto.randomUUID().slice(0, 8)}`;
  const b = `ac-${crypto.randomUUID().slice(0, 8)}`;
  await writeFile(
    resolve(root, "sessions", `${a}.json`),
    JSON.stringify({ cookies: [{ name: "session-token", value: "t", domain: ".chatgpt.com", path: "/" }], origins: [] }),
    "utf8",
  );
  await writeFile(
    resolve(root, "sessions", `${b}.json`),
    JSON.stringify({ cookies: [{ name: "session-token", value: "t", domain: ".chatgpt.com", path: "/" }], origins: [] }),
    "utf8",
  );
  await writeControlPlane({
    accounts: [
      {
        id: a,
        platform: "chatgpt",
        email: `${a}@test.local`,
        remark: "qa",
        status: "healthy",
        proxyId: "px-1",
        sessionPath: resolve(root, "sessions", `${a}.json`),
        failCount: 0,
        totalRequests: 0,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        lockedUntil: null,
      },
      {
        id: b,
        platform: "chatgpt",
        email: `${b}@test.local`,
        remark: "qa",
        status: "healthy",
        proxyId: "px-1",
        sessionPath: resolve(root, "sessions", `${b}.json`),
        failCount: 0,
        totalRequests: 0,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        lockedUntil: null,
      },
    ],
    proxies: [
      {
        id: "px-1",
        name: "qa",
        type: "http",
        host: "127.0.0.1",
        port: 9,
        username: "u",
        stickySessionId: "s",
        region: "QA",
        status: "active",
        maxAccounts: 8,
        remark: "",
        createdAt: new Date().toISOString(),
      },
    ],
    settings: {
      maxRetry: 2,
      failThreshold: 5,
      coolDownSeconds: 1,
      intervalMinMs: 0,
      intervalMaxMs: 1,
      concurrencyPerWorker: 2,
      enforceProxy: true,
      replyTimeoutMs: 5000,
      allowPreviewFallback: false,
      chatgptSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
      geminiSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
    },
  });
}

test("idempotency replays the same job", async () => {
  await seed();
  const a = await enqueueChat("hi", "gpt-5.6", 5000, [], { idempotencyKey: "idem-1" });
  const b = await enqueueChat("hi", "gpt-5.6", 5000, [], { idempotencyKey: "idem-1" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) assert.equal(a.job.id, b.job.id);
});

test("stale lease result is rejected", async () => {
  await seed();
  const queued = await enqueueChat("lease", "gpt-5.6", 8000, [], { idempotencyKey: `lease-${Date.now()}` });
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const next = await claimNext("qa-worker");
  assert.ok(next.job);
  const stale = await finishJob(next.job!.id, { ok: true, text: "nope", leaseId: "old", fencingToken: 0, attemptId: "x" });
  assert.equal(stale.ok, false);
  assert.match(stale.error || "", /STALE_LEASE/);
  const ok = await finishJob(next.job!.id, {
    ok: true,
    text: "hello",
    leaseId: next.job!.leaseId,
    fencingToken: next.job!.fencingToken,
    attemptId: next.job!.attemptId,
    workerId: "qa-worker",
  });
  assert.equal(ok.ok, true);
  const job = await getJob(next.job!.id);
  assert.equal(job?.status, "done");
  assert.equal(job?.text, "hello");
});

test("account failover excludes failed account on next enqueue", async () => {
  await seed();
  const first = await enqueueChat("one", "gpt-5.6", 8000, [], { idempotencyKey: `fail-${Date.now()}` });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const claimed = await claimNext("qa-worker");
  assert.ok(claimed.job);
  await finishJob(claimed.job!.id, {
    ok: false,
    error: "SESSION_INVALID: login wall",
    fault: "account",
    leaseId: claimed.job!.leaseId,
    fencingToken: claimed.job!.fencingToken,
    attemptId: claimed.job!.attemptId,
  });
  const second = await enqueueChat("two", "gpt-5.6", 8000, [], {
    idempotencyKey: `fail2-${Date.now()}`,
    excludeAccountIds: [claimed.job!.accountId || ""],
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.notEqual(second.job.accountId, claimed.job!.accountId);
});

test("wait deadline cancel is terminal and frees the account", async () => {
  await seed();
  const first = await enqueueChat("hold", "gpt-5.6", 8000, [], { idempotencyKey: `hold-${Date.now()}` });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await claimNext("qa-worker");
  await cancelJob(first.job.id, "TIMEOUT: wait deadline");
  const job = await getJob(first.job.id);
  assert.equal(job?.status, "cancelled");
  const second = await enqueueChat("next", "gpt-5.6", 8000, [], { idempotencyKey: `next-${Date.now()}` });
  assert.equal(second.ok, true, second.ok ? "" : second.error);
});
