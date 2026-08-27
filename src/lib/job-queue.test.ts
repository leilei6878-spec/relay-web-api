import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";
import "./test-env.ts";
import { resetCoordForTests } from "./coord.ts";
import { writeControlPlane } from "./control-plane.ts";
import { checkpointJob, claimNext, cancelJob, enqueueChat, finishJob, getJob } from "./job-queue.ts";
import { resetMediaStoreForTests } from "./media-store.ts";
import { ingestReferenceImages } from "./reference-input.ts";

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
    modelActual: "GPT-5.6",
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

test("post-submit cancellation retains the running attempt and never requeues", async () => {
  await seed();
  const queued = await enqueueChat("paid", "gpt-5.6", 8000, [], {
    idempotencyKey: `unsafe-${Date.now()}`,
  });
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const next = await claimNext("qa-worker");
  assert.ok(next.job);
  const job = next.job!;
  const checkpoint = await checkpointJob(job.id, {
    leaseId: job.leaseId,
    fencingToken: job.fencingToken,
    attemptId: job.attemptId,
    workerId: "qa-worker",
    submissionState: "SUBMITTED",
    retrySafety: "UNSAFE",
  });
  assert.equal(checkpoint.ok, true);

  const stale = await checkpointJob(job.id, {
    leaseId: job.leaseId,
    fencingToken: job.fencingToken,
    attemptId: job.attemptId,
    workerId: "different-worker",
    submissionState: "GENERATING",
    retrySafety: "UNSAFE",
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /worker_id mismatch/);

  const cancelled = await cancelJob(job.id, "TIMEOUT: wait deadline");
  assert.equal(cancelled.ok, true);
  assert.equal("retained" in cancelled && cancelled.retained, true);
  assert.equal((await getJob(job.id))?.status, "running");

  const finished = await finishJob(job.id, {
    ok: true,
    text: "provider result",
    leaseId: job.leaseId,
    fencingToken: job.fencingToken,
    attemptId: job.attemptId,
    workerId: "qa-worker",
    submissionState: "RESULT_VALIDATED",
    retrySafety: "UNSAFE",
    modelActual: "GPT-5.6",
  });
  assert.equal(finished.ok, true);
  assert.equal((await getJob(job.id))?.status, "done");
});

test("dead-worker reclaim requeues SAFE work but terminalizes submitted work", async () => {
  const oldDead = process.env.RELAY_WORKER_DEAD_MS;
  const oldGrace = process.env.RELAY_CLAIM_GRACE_MS;
  process.env.RELAY_WORKER_DEAD_MS = "1";
  process.env.RELAY_CLAIM_GRACE_MS = "1";
  try {
    await seed();
    const safe = await enqueueChat("safe", "gpt-5.6", 8000, [], {
      idempotencyKey: `reclaim-safe-${Date.now()}`,
    });
    assert.equal(safe.ok, true);
    if (!safe.ok) return;
    await claimNext("dead-safe-worker");
    await new Promise((resolve) => setTimeout(resolve, 8));
    assert.equal((await getJob(safe.job.id))?.status, "queued");

    await seed();
    const unsafe = await enqueueChat("unsafe", "gpt-5.6", 8000, [], {
      idempotencyKey: `reclaim-unsafe-${Date.now()}`,
    });
    assert.equal(unsafe.ok, true);
    if (!unsafe.ok) return;
    const claimed = await claimNext("dead-unsafe-worker");
    const job = claimed.job!;
    await checkpointJob(job.id, {
      leaseId: job.leaseId,
      fencingToken: job.fencingToken,
      attemptId: job.attemptId,
      workerId: "dead-unsafe-worker",
      submissionState: "SUBMITTED",
      retrySafety: "UNSAFE",
    });
    await new Promise((resolve) => setTimeout(resolve, 8));
    const recovered = await getJob(job.id);
    assert.equal(recovered?.status, "error");
    assert.match(recovered?.error || "", /RESULT_UNCERTAIN/);
  } finally {
    if (oldDead === undefined) delete process.env.RELAY_WORKER_DEAD_MS;
    else process.env.RELAY_WORKER_DEAD_MS = oldDead;
    if (oldGrace === undefined) delete process.env.RELAY_CLAIM_GRACE_MS;
    else process.env.RELAY_CLAIM_GRACE_MS = oldGrace;
  }
});

test("queue cap returns QUEUE_FULL 429", async () => {
  await seed();
  process.env.RELAY_QUEUE_CAP = "1";
  const a = await enqueueChat("one", "gpt-5.6", 8000, [], { idempotencyKey: `cap-a-${Date.now()}` });
  assert.equal(a.ok, true);
  const b = await enqueueChat("two", "gpt-5.6", 8000, [], { idempotencyKey: `cap-b-${Date.now()}` });
  assert.equal(b.ok, false);
  if (!b.ok) assert.match(b.error, /QUEUE_FULL: 429/);
  delete process.env.RELAY_QUEUE_CAP;
});

test("web-auto succeeds without inventing an actual model; exact IDs fail closed", async () => {
  await seed();
  const auto = await enqueueChat("auto", "chatgpt-web-auto", 8000, [], {
    idempotencyKey: `model-auto-${Date.now()}`,
  });
  assert.equal(auto.ok, true);
  if (!auto.ok) return;
  const autoClaim = await claimNext("model-worker");
  const autoDone = await finishJob(autoClaim.job!.id, {
    ok: true,
    text: "answer",
    modelActual: "ChatGPT",
    leaseId: autoClaim.job!.leaseId,
    fencingToken: autoClaim.job!.fencingToken,
    attemptId: autoClaim.job!.attemptId,
    workerId: "model-worker",
  });
  assert.equal(autoDone.ok, true);
  const autoJob = await getJob(autoClaim.job!.id);
  assert.equal(autoJob?.status, "done");
  assert.equal(autoJob?.actualModel, "unknown");
  assert.equal(autoJob?.actualModelLabel, "ChatGPT");
  assert.equal(autoJob?.modelVerified, false);

  await seed();
  const exact = await enqueueChat("exact", "gpt-5.6", 8000, [], {
    idempotencyKey: `model-exact-${Date.now()}`,
  });
  assert.equal(exact.ok, true);
  if (!exact.ok) return;
  const exactClaim = await claimNext("model-worker");
  const rejected = await finishJob(exactClaim.job!.id, {
    ok: true,
    text: "answer",
    modelActual: "ChatGPT",
    leaseId: exactClaim.job!.leaseId,
    fencingToken: exactClaim.job!.fencingToken,
    attemptId: exactClaim.job!.attemptId,
    workerId: "model-worker",
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /MODEL_SELECTION_UNCONFIRMED/);
  assert.equal((await getJob(exactClaim.job!.id))?.status, "error");

  await seed();
  const missing = await enqueueChat("missing", "gpt-5.6", 8000, [], {
    idempotencyKey: `model-missing-${Date.now()}`,
  });
  assert.equal(missing.ok, true);
  if (!missing.ok) return;
  const missingClaim = await claimNext("model-worker");
  const missingRejected = await finishJob(missingClaim.job!.id, {
    ok: true,
    text: "answer",
    leaseId: missingClaim.job!.leaseId,
    fencingToken: missingClaim.job!.fencingToken,
    attemptId: missingClaim.job!.attemptId,
    workerId: "model-worker",
  });
  assert.equal(missingRejected.ok, false);
  if (!missingRejected.ok) assert.match(missingRejected.error, /MODEL_SELECTION_UNCONFIRMED/);
});

test("input reference bytes are frozen outside job JSON", async () => {
  await seed();
  resetMediaStoreForTests();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const frozen = await ingestReferenceImages([dataUrl], "http://relay.test");
  assert.equal(frozen.ok, true);
  if (!frozen.ok) return;
  const queued = await enqueueChat(
    "vision",
    "chatgpt-web-auto",
    8000,
    frozen.assets.map((asset) => asset.url),
    { referenceAssets: frozen.assets, idempotencyKey: `frozen-${Date.now()}` },
  );
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const json = JSON.stringify(await getJob(queued.job.id));
  assert.doesNotMatch(json, /data:image/);
  assert.match(json, /\/api\/media\//);
  assert.match(json, new RegExp(frozen.assets[0]!.sha256));
});
