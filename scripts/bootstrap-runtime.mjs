import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { localWorkerScript } from "../src/lib/local-worker-script.ts";

mkdirSync("/workspace/storage/sessions", { recursive: true });

const demo = process.env.RELAY_DEMO_MODE === "true";
const planePath = "/workspace/storage/control-plane.json";
const hasPlane = existsSync(planePath);

if (demo || !hasPlane) {
  const dummy = JSON.stringify({
    cookies: [{ name: "session-token", value: "qa", domain: ".chatgpt.com", path: "/", httpOnly: true, secure: true }],
    origins: [],
  });
  if (demo) {
    for (const id of ["ac-1", "ac-2", "ac-3", "ac-4", "ac-5", "ac-6"]) {
      const path = `/workspace/storage/sessions/${id}.json`;
      if (!existsSync(path)) writeFileSync(path, dummy, { mode: 0o600 });
    }
  }
  const now = new Date().toISOString();
  const accounts = demo
    ? [
        {
          id: "ac-1",
          platform: "chatgpt",
          email: "pool.alpha@mail.test",
          remark: "demo",
          status: "healthy",
          proxyId: "px-tokyo-a",
          sessionPath: "storage/sessions/ac-1.json",
          failCount: 0,
          totalRequests: 0,
          lastUsedAt: null,
          createdAt: now,
        },
      ]
    : [];
  if (!hasPlane) {
    writeFileSync(
      planePath,
      JSON.stringify({
        accounts,
        proxies: [],
        settings: {
          maxRetry: 3,
          failThreshold: 5,
          coolDownSeconds: 300,
          intervalMinMs: 800,
          intervalMaxMs: 2500,
          concurrencyPerWorker: 3,
          enforceProxy: true,
          replyTimeoutMs: 90_000,
          allowPreviewFallback: false,
        },
        savedAt: now,
      }),
    );
  }
}

let apiKey = "";
try {
  const raw = JSON.parse(readFileSync("/workspace/storage/api-keys.json", "utf8"));
  apiKey = raw.apiKey || raw.keys?.[0]?.key || "";
} catch {
  apiKey = "";
}
if (!apiKey) {
  apiKey = `sk-relay-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  writeFileSync(
    "/workspace/storage/api-keys.json",
    JSON.stringify({
      keys: [
        {
          id: "default",
          name: "默认",
          key: apiKey,
          enabled: true,
          scopes: ["chat", "image"],
          dailyLimit: 0,
          createdAt: new Date().toISOString(),
        },
      ],
    }, null, 2),
    { mode: 0o600 },
  );
}

writeFileSync("/workspace/storage/worker.py", localWorkerScript());
try {
  const existing = readFileSync("/workspace/storage/worker-token.txt", "utf8").trim();
  if (!existing.startsWith("wk-relay-")) throw new Error("rotate");
} catch {
  writeFileSync("/workspace/storage/worker-token.txt", `wk-relay-${crypto.randomUUID().replace(/-/g, "")}`);
}
try {
  const existing = readFileSync("/workspace/storage/admin-token.txt", "utf8").trim();
  if (!existing.startsWith("ad-relay-")) throw new Error("rotate");
} catch {
  writeFileSync("/workspace/storage/admin-token.txt", `ad-relay-${crypto.randomUUID().replace(/-/g, "")}`);
}
process.stdout.write(apiKey + "\n");
