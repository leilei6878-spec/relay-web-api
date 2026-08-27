import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import "./test-env.ts";
import { resetCoordForTests } from "./coord.ts";
import { writeControlPlane } from "./control-plane.ts";
import { claimNext, enqueueChat, finishJob, getJob } from "./job-queue.ts";
import { LocalMediaStore, resetMediaStoreForTests } from "./media-store.ts";
import { ingestWorkerMedia } from "./worker-media.ts";

process.env.RELAY_SKIP_DB = "1";
process.env.RELAY_TEST = "1";
delete process.env.NODE_ENV;

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function syntheticPng(w: number, h: number, minBytes = 4096): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = pngChunk("IDAT", Buffer.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  let out = Buffer.concat([sig, pngChunk("IHDR", ihdr), idat, pngChunk("IEND", Buffer.alloc(0))]);
  if (out.length < minBytes) out = Buffer.concat([out, Buffer.alloc(minBytes - out.length, 0x00)]);
  return out;
}

async function seed() {
  resetCoordForTests();
  resetMediaStoreForTests();
  const root = resolve(process.env.RELAY_STORAGE_DIR || "/tmp/relay-qa-storage");
  await mkdir(resolve(root, "sessions"), { recursive: true });
  await writeFile(resolve(root, "jobs.json"), JSON.stringify({ jobs: [], workers: [] }), "utf8");
  const a = `ac-${crypto.randomUUID().slice(0, 8)}`;
  await writeFile(
    resolve(root, "sessions", `${a}.json`),
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

test("worker media 1MB/5MB stays out of job JSON; stale fence rejected", async () => {
  await seed();
  const queued = await enqueueChat("media", "chatgpt-web-auto", 8000, [], { idempotencyKey: `media-${Date.now()}` });
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const next = await claimNext("qa-worker");
  assert.ok(next.job);
  const stale = await ingestWorkerMedia({
    jobId: next.job!.id,
    leaseId: "old",
    fencingToken: 0,
    attemptId: "x",
    buf: syntheticPng(64, 64, 4096),
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /STALE_LEASE/);

  const png1 = syntheticPng(256, 256, 1024 * 1024);
  const up = await ingestWorkerMedia({
    jobId: next.job!.id,
    leaseId: next.job!.leaseId,
    fencingToken: next.job!.fencingToken,
    attemptId: next.job!.attemptId,
    workerId: "qa-worker",
    buf: png1,
  });
  assert.equal(up.ok, true);
  if (!up.ok) return;
  assert.match(up.url, /\/api\/media\//);
  assert.equal(up.bytes, png1.length);
  assert.ok(up.mediaStoreMs >= 0);
  const done = await finishJob(next.job!.id, {
    ok: true,
    text: "ok",
    url: up.url,
    leaseId: next.job!.leaseId,
    fencingToken: next.job!.fencingToken,
    attemptId: next.job!.attemptId,
    workerId: "qa-worker",
  });
  assert.equal(done.ok, true);
  const job = await getJob(next.job!.id);
  const json = JSON.stringify(job);
  assert.ok(!json.includes("data:image"), "job JSON must not embed data URLs");
  assert.ok(json.length < png1.length / 4, `job JSON ${json.length} grew with ${png1.length} image`);
  assert.equal(job?.url, up.url);
});

test("5MB media payload does not inflate job JSON", async () => {
  await seed();
  const queued = await enqueueChat("media5", "chatgpt-web-auto", 8000, [], { idempotencyKey: `media5-${Date.now()}` });
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const next = await claimNext("qa-worker");
  const png = syntheticPng(256, 256, 5 * 1024 * 1024);
  const up = await ingestWorkerMedia({
    jobId: next.job!.id,
    leaseId: next.job!.leaseId,
    fencingToken: next.job!.fencingToken,
    attemptId: next.job!.attemptId,
    workerId: "qa-worker",
    buf: png,
  });
  assert.equal(up.ok, true);
  if (!up.ok) return;
  await finishJob(next.job!.id, {
    ok: true,
    text: "ok",
    url: up.url,
    leaseId: next.job!.leaseId,
    fencingToken: next.job!.fencingToken,
    attemptId: next.job!.attemptId,
    workerId: "qa-worker",
  });
  const job = await getJob(next.job!.id);
  const json = JSON.stringify(job);
  assert.ok(json.length < 200_000, `job JSON ${json.length} for 5MB image`);
  assert.ok(!json.includes("data:image"));
});

test("15MB media payload is accepted by the store", async () => {
  const store = new LocalMediaStore(resolve("/tmp/relay-media-15"));
  const png = syntheticPng(512, 512, 15 * 1024 * 1024);
  const put = await store.put(png, "image/png");
  assert.equal(put.bytes, png.length);
  const got = await store.get(`${put.id}.png`);
  assert.equal(got?.buf.length, png.length);
});
