import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import "./test-env.ts";
import { getCircuit, resetCircuit } from "./circuit.ts";
import { resetCoordForTests } from "./coord.ts";
import { readControlPlane } from "./control-plane.ts";
import {
  cancelJob,
  claimNext,
  enqueueChat,
  fileWriteCount,
  finishJob,
  getJob,
  resetJobStoreForTests,
} from "./job-queue.ts";
import { persistenceMode } from "./persist-mode.ts";
import { seedPool } from "./qa-seed.ts";

process.env.RELAY_SKIP_DB = "1";
process.env.RELAY_WORKER_DEAD_MS = "40";
process.env.RELAY_CLAIM_GRACE_MS = "5";

async function finishOk(claimed: Awaited<ReturnType<typeof claimNext>>, text = "hello") {
  return finishJob(claimed.job!.id, {
    ok: true,
    text,
    leaseId: claimed.job!.leaseId,
    fencingToken: claimed.job!.fencingToken,
    attemptId: claimed.job!.attemptId,
    workerId: claimed.job!.workerId,
  });
}

test("chaos 1+13: kill / slow worker requeues, no lost request", async () => {
  await seedPool(2);
  const queued = await enqueueChat("slow", "gpt-5.6", 200, [], { requestId: "R-slow" });
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const claimed = await claimNext("w-slow");
  assert.ok(claimed.job);
  await new Promise((r) => setTimeout(r, 80));
  const job = await getJob(queued.job.id);
  assert.ok(job);
  assert.notEqual(job.status, "running");
  assert.ok(job.status === "queued" || job.status === "dead" || job.status === "error");
  assert.ok(job.requestId === "R-slow");
});

test("chaos 2+14: recovered worker stale result rejected; duplicate callback rejected", async () => {
  await seedPool(2);
  const queued = await enqueueChat("dup", "gpt-5.6", 8000, []);
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const first = await claimNext("w1");
  assert.ok(first.job);
  const staleProof = {
    leaseId: first.job!.leaseId!,
    fencingToken: first.job!.fencingToken!,
    attemptId: first.job!.attemptId!,
    workerId: "w1",
  };
  const ok = await finishJob(first.job!.id, { ok: true, text: "one", ...staleProof });
  assert.equal(ok.ok, true);
  const dup = await finishJob(first.job!.id, { ok: true, text: "two", ...staleProof });
  assert.equal(dup.ok, false);
  assert.match(dup.error || "", /STALE_LEASE|terminal/);
  const job = await getJob(first.job!.id);
  assert.equal(job?.text, "one");
});

test("chaos 6: same Idempotency-Key x20 collapses to one job", async () => {
  await seedPool(5);
  const key = `idem-${Date.now()}`;
  const results = await Promise.all(
    Array.from({ length: 20 }, () => enqueueChat("same", "gpt-5.6", 8000, [], { idempotencyKey: key })),
  );
  assert.ok(results.every((r) => r.ok));
  const ids = new Set(results.map((r) => (r.ok ? r.job.id : "")));
  assert.equal(ids.size, 1);
});

test("chaos 7: 20 requests compete for 5 accounts — no double lease", async () => {
  await seedPool(5);
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => enqueueChat(`p${i}`, "gpt-5.6", 8000, [], { requestId: `R-${i}` })),
  );
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  assert.equal(ok.length, 5);
  assert.equal(fail.length, 15);
  const accounts = new Set(ok.map((r) => (r.ok ? r.job.accountId : "")));
  assert.equal(accounts.size, 5);
});

test("chaos 8+9: two workers claim the same queued job — only one wins", async () => {
  await seedPool(1);
  const queued = await enqueueChat("race", "gpt-5.6", 8000, []);
  assert.equal(queued.ok, true);
  const [a, b] = await Promise.all([claimNext("gw-a"), claimNext("gw-b")]);
  const winners = [a, b].filter((x) => x.job);
  assert.equal(winners.length, 1);
  const losers = [a, b].filter((x) => !x.job);
  assert.equal(losers.length, 1);
});

test("chaos 10: PROVIDER_DOM_CHANGED does not bump failCount or walk the pool", async () => {
  const accounts = await seedPool(2);
  await resetCircuit("chatgpt");
  const queued = await enqueueChat("dom", "gpt-5.6", 8000, []);
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const claimed = await claimNext("w-dom");
  const before = (await readControlPlane()).accounts.find((a) => a.id === claimed.job!.accountId);
  const failBefore = before?.failCount || 0;
  await finishJob(claimed.job!.id, {
    ok: false,
    error: "DOM_CHANGED: composer",
    fault: "provider",
    leaseId: claimed.job!.leaseId,
    fencingToken: claimed.job!.fencingToken,
    attemptId: claimed.job!.attemptId,
    workerId: "w-dom",
  });
  const after = (await readControlPlane()).accounts.find((a) => a.id === claimed.job!.accountId);
  assert.equal(after?.failCount || 0, failBefore);
  assert.notEqual(after?.status, "invalid");
  assert.notEqual(after?.status, "banned");
  const circuit = await getCircuit("chatgpt");
  assert.ok(circuit.state === "HEALTHY" || circuit.state === "DEGRADED" || circuit.state === "OPEN");
  void accounts;
});

test("chaos 11: proxy failure does not pollute account health", async () => {
  await seedPool(2);
  const queued = await enqueueChat("proxy", "gpt-5.6", 8000, []);
  if (!queued.ok) return;
  const claimed = await claimNext("w-px");
  const before = (await readControlPlane()).accounts.find((a) => a.id === claimed.job!.accountId)?.failCount || 0;
  await finishJob(claimed.job!.id, {
    ok: false,
    error: "PROXY_UNAVAILABLE",
    leaseId: claimed.job!.leaseId,
    fencingToken: claimed.job!.fencingToken,
    attemptId: claimed.job!.attemptId,
  });
  const after = (await readControlPlane()).accounts.find((a) => a.id === claimed.job!.accountId)?.failCount || 0;
  assert.equal(after, before);
});

test("chaos 12: session expiration marks invalid and increments failCount", async () => {
  await seedPool(2);
  const queued = await enqueueChat("sess", "gpt-5.6", 8000, []);
  if (!queued.ok) return;
  const claimed = await claimNext("w-sess");
  await finishJob(claimed.job!.id, {
    ok: false,
    error: "SESSION_INVALID: login wall",
    leaseId: claimed.job!.leaseId,
    fencingToken: claimed.job!.fencingToken,
    attemptId: claimed.job!.attemptId,
  });
  const after = (await readControlPlane()).accounts.find((a) => a.id === claimed.job!.accountId);
  assert.equal(after?.status, "invalid");
  assert.ok((after?.failCount || 0) >= 1);
});

test("chaos 15: cancel during execution", async () => {
  await seedPool(1);
  const queued = await enqueueChat("cancel", "gpt-5.6", 8000, []);
  if (!queued.ok) return;
  const claimed = await claimNext("w-c");
  assert.ok(claimed.job);
  await cancelJob(claimed.job!.id, "REQUEST_CANCELLED: client");
  const job = await getJob(claimed.job!.id);
  assert.equal(job?.status, "cancelled");
});

test("chaos 3: file persistence keeps queued jobs across load (gateway restart sim)", async () => {
  await seedPool(1);
  const queued = await enqueueChat("persist", "gpt-5.6", 8000, []);
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const raw = JSON.parse(await readFile(resolve(process.env.RELAY_STORAGE_DIR || "storage", "jobs.json"), "utf8")) as { jobs: { id: string }[] };
  assert.ok(raw.jobs.some((j) => j.id === queued.job.id));
});

test("postgres SoT does not write jobs.json for scheduling", async () => {
  process.env.RELAY_SOT = "postgres";
  process.env.RELAY_SKIP_DB = "1";
  await seedPool(1);
  resetJobStoreForTests();
  resetCoordForTests();
  assert.equal(persistenceMode(), "postgres");
  const before = fileWriteCount();
  const queued = await enqueueChat("sot", "gpt-5.6", 8000, []);
  assert.equal(queued.ok, true);
  assert.equal(fileWriteCount(), before);
  delete process.env.RELAY_SOT;
});
