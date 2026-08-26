import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resetCoordForTests } from "./coord.ts";
import { writeControlPlane } from "./control-plane.ts";
import { resetJobStoreForTests } from "./job-queue.ts";
import { resetRequestsForTests } from "./requests.ts";
import { resetCircuit } from "./circuit.ts";

export async function seedPool(count = 2) {
  process.env.RELAY_SKIP_DB = "1";
  process.env.RELAY_TEST = "1";
  process.env.RELAY_STORAGE_DIR = process.env.RELAY_STORAGE_DIR || "/tmp/relay-qa-storage";
  resetCoordForTests();
  resetJobStoreForTests();
  resetRequestsForTests();
  await resetCircuit("chatgpt");
  await resetCircuit("gemini");
  const root = resolve(process.env.RELAY_STORAGE_DIR);
  await mkdir(resolve(root, "sessions"), { recursive: true });
  await writeFile(resolve(root, "jobs.json"), JSON.stringify({ jobs: [], workers: [] }), "utf8");
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const id = `ac-${crypto.randomUUID().slice(0, 8)}`;
    await writeFile(
      resolve(root, "sessions", `${id}.json`),
      JSON.stringify({
        cookies: [{ name: "session-token", value: "t", domain: ".chatgpt.com", path: "/" }],
        origins: [],
      }),
      "utf8",
    );
    accounts.push({
      id,
      platform: "chatgpt" as const,
      email: `${id}@test.local`,
      remark: "qa",
      status: "healthy" as const,
      proxyId: "px-1",
      sessionPath: resolve(root, "sessions", `${id}.json`),
      failCount: 0,
      totalRequests: 0,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      lockedUntil: null,
      canary: i === 0,
    });
  }
  await writeControlPlane({
    accounts,
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
        maxAccounts: 32,
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
      concurrencyPerWorker: 8,
      enforceProxy: true,
      replyTimeoutMs: 5000,
      allowPreviewFallback: false,
      chatgptSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
      geminiSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
    },
  });
  return accounts;
}
