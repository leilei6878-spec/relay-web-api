import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import "./test-env.ts";
import { resetCoordForTests } from "./coord.ts";
import { readControlPlane, writeControlPlane } from "./control-plane.ts";
import { claimNext, enqueueImage, finishJob, getJob } from "./job-queue.ts";
import { persistImageBytes, resetMediaStoreForTests } from "./media-store.ts";

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}

function syntheticPng(width: number, height: number, minBytes = 4096) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = pngChunk("IDAT", Buffer.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00]));
  let out = Buffer.concat([signature, pngChunk("IHDR", ihdr), idat, pngChunk("IEND", Buffer.alloc(0))]);
  if (out.length < minBytes) out = Buffer.concat([out, Buffer.alloc(minBytes - out.length)]);
  return out;
}

async function seedGemini() {
  resetCoordForTests();
  resetMediaStoreForTests();
  const root = resolve(process.env.RELAY_STORAGE_DIR || "storage/relay-qa-storage");
  await mkdir(resolve(root, "sessions"), { recursive: true });
  await writeFile(resolve(root, "jobs.json"), JSON.stringify({ jobs: [], workers: [] }), "utf8");
  const accountId = `gem-${crypto.randomUUID().slice(0, 8)}`;
  const sessionPath = resolve(root, "sessions", `${accountId}.json`);
  await writeFile(sessionPath, JSON.stringify({ cookies: [{ name: "session", value: "x" }] }), "utf8");
  await writeControlPlane({
    accounts: [{
      id: accountId,
      platform: "gemini",
      email: `${accountId}@test.local`,
      remark: "",
      status: "healthy",
      proxyId: "px-image",
      sessionPath,
      failCount: 0,
      totalRequests: 0,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      lockedUntil: null,
    }],
    proxies: [{
      id: "px-image",
      name: "qa",
      type: "http",
      host: "127.0.0.1",
      port: 9,
      username: "",
      stickySessionId: "qa",
      region: "QA",
      status: "active",
      maxAccounts: 2,
      remark: "",
      createdAt: new Date().toISOString(),
    }],
    settings: {
      maxRetry: 2,
      failThreshold: 5,
      coolDownSeconds: 1,
      intervalMinMs: 0,
      intervalMaxMs: 1,
      concurrencyPerWorker: 1,
      enforceProxy: true,
      replyTimeoutMs: 5000,
      allowPreviewFallback: false,
      chatgptSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
      geminiSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
    },
  });
}

async function enqueueAndClaim(label: string) {
  const queued = await enqueueImage(label, "gemini-image", 8000, [], {
    idempotencyKey: `${label}-${crypto.randomUUID()}`,
    n: 1,
    size: "1024x1024",
    aspect: "1:1",
    tier: "Small",
  });
  assert.equal(queued.ok, true);
  if (!queued.ok) throw new Error("image enqueue failed");
  const claimed = await claimNext("image-worker");
  assert.ok(claimed.job);
  return claimed.job!;
}

test("image finish requires confidence and rejects historical bytes", async () => {
  await seedGemini();
  const stored = await persistImageBytes(syntheticPng(1024, 1024), "image/png");

  const missing = await enqueueAndClaim("missing-confidence");
  await finishJob(missing.id, {
    ok: true,
    url: stored.url,
    leaseId: missing.leaseId,
    fencingToken: missing.fencingToken,
    attemptId: missing.attemptId,
    workerId: "image-worker",
  });
  const missingJob = await getJob(missing.id);
  assert.equal(missingJob?.status, "error");
  assert.match(missingJob?.error || "", /IMAGE_CONFIDENCE_TOO_LOW: MISSING/);

  const accepted = await enqueueAndClaim("accepted-confidence");
  await finishJob(accepted.id, {
    ok: true,
    url: stored.url,
    resultConfidences: ["HIGH"],
    leaseId: accepted.leaseId,
    fencingToken: accepted.fencingToken,
    attemptId: accepted.attemptId,
    workerId: "image-worker",
  });
  const acceptedJob = await getJob(accepted.id);
  assert.equal(acceptedJob?.status, "done");
  assert.equal(acceptedJob?.resultAssets?.length, 1);
  assert.equal(acceptedJob?.resultAssets?.[0]?.sha256, acceptedJob?.resultHashes?.[0]);
  const account = (await readControlPlane()).accounts[0]!;
  assert.equal(account.recentResultHashes?.length, 1);

  const historical = await enqueueAndClaim("historical");
  await finishJob(historical.id, {
    ok: true,
    url: stored.url,
    resultConfidences: ["HIGH"],
    leaseId: historical.leaseId,
    fencingToken: historical.fencingToken,
    attemptId: historical.attemptId,
    workerId: "image-worker",
  });
  const historicalJob = await getJob(historical.id);
  assert.equal(historicalJob?.status, "error");
  assert.match(historicalJob?.error || "", /historical asset/);

  const otherBytes = syntheticPng(1024, 1024);
  otherBytes[otherBytes.length - 1] = 1;
  const other = await persistImageBytes(otherBytes, "image/png");
  const mismatched = await enqueueAndClaim("metadata-mismatch");
  await finishJob(mismatched.id, {
    ok: true,
    url: other.url,
    resultConfidences: ["HIGH"],
    resultAssets: [{
      assetId: other.id,
      url: other.url,
      sha256: "0".repeat(64),
      mime: "image/png",
      bytes: other.bytes,
      width: 1024,
      height: 1024,
      confidence: "HIGH",
    }],
    leaseId: mismatched.leaseId,
    fencingToken: mismatched.fencingToken,
    attemptId: mismatched.attemptId,
    workerId: "image-worker",
  });
  const mismatchedJob = await getJob(mismatched.id);
  assert.equal(mismatchedJob?.status, "error");
  assert.match(mismatchedJob?.error || "", /metadata mismatch/);
});
