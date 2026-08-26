import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("test fixtures cannot clobber a real account pool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-plane-"));
  process.env.RELAY_SKIP_DB = "1";
  process.env.RELAY_STORAGE_DIR = dir;
  process.env.RELAY_ALLOW_CLOBBER = "";
  await mkdir(join(dir, "backups"), { recursive: true });
  const { writeControlPlane, readControlPlane } = await import("./control-plane.ts");
  const settings = {
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
  };
  const real = await writeControlPlane({
    accounts: [
      {
        id: "real-1",
        platform: "chatgpt",
        email: "owner@gmail.com",
        remark: "",
        status: "healthy",
        proxyId: "px-ss",
        sessionPath: join(dir, "sessions", "real-1.json"),
        failCount: 0,
        totalRequests: 1,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        lockedUntil: null,
      },
    ],
    proxies: [
      {
        id: "px-ss",
        name: "Japan",
        type: "http",
        host: "127.0.0.1",
        port: 18080,
        username: "",
        stickySessionId: "s",
        region: "JP",
        status: "active",
        maxAccounts: 8,
        remark: "",
        createdAt: new Date().toISOString(),
      },
    ],
    settings,
  });
  assert.equal(real.ok, true);
  const blocked = await writeControlPlane({
    accounts: [
      {
        id: "ac-qa",
        platform: "chatgpt",
        email: "ac-qa@test.local",
        remark: "qa",
        status: "healthy",
        proxyId: "px-1",
        sessionPath: join(dir, "sessions", "ac-qa.json"),
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
    settings,
  });
  assert.equal(blocked.ok, true);
  assert.equal((blocked as { skipped?: string }).skipped, "real-accounts-protected");
  const plane = await readControlPlane();
  assert.equal(plane.accounts.length, 1);
  assert.equal(plane.accounts[0]?.email, "owner@gmail.com");
  const disk = JSON.parse(await readFile(join(dir, "control-plane.json"), "utf8")) as { accounts: { email: string }[] };
  assert.equal(disk.accounts[0]?.email, "owner@gmail.com");
  await writeFile(join(dir, "ok"), "1");
});
