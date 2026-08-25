import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { localWorkerScript } from "../src/lib/local-worker-script.ts";

mkdirSync("/workspace/storage/sessions", { recursive: true });

const dummy = JSON.stringify({
  cookies: [
    {
      name: "session-token",
      value: "qa",
      domain: ".chatgpt.com",
      path: "/",
      httpOnly: true,
      secure: true,
    },
  ],
  origins: [],
});
for (const id of ["ac-1", "ac-2", "ac-3", "ac-4", "ac-5", "ac-6"]) {
  const path = `/workspace/storage/sessions/${id}.json`;
  if (!existsSync(path)) writeFileSync(path, dummy, { mode: 0o600 });
}

const now = new Date().toISOString();
const accounts = [
  {
    id: "ac-1",
    platform: "chatgpt",
    email: "pool.alpha@mail.test",
    remark: "",
    status: "healthy",
    proxyId: "px-tokyo-a",
    sessionPath: "storage/sessions/ac-1.json",
    failCount: 0,
    totalRequests: 0,
    lastUsedAt: null,
    createdAt: now,
  },
  {
    id: "ac-5",
    platform: "gemini",
    email: "img.nova@mail.test",
    remark: "",
    status: "healthy",
    proxyId: "px-tokyo-a",
    sessionPath: "storage/sessions/ac-5.json",
    failCount: 0,
    totalRequests: 0,
    lastUsedAt: null,
    createdAt: now,
  },
];
const real = "/workspace/storage/sessions/1fcb8daf-17d0-4eb5-9dcd-034fa21e2d32.json";
if (existsSync(real)) {
  accounts.push({
    id: "1fcb8daf-17d0-4eb5-9dcd-034fa21e2d32",
    platform: "chatgpt",
    email: "brosnanbarron6714@gmail.com",
    remark: "已登录",
    status: "healthy",
    proxyId: "px-tokyo-a",
    sessionPath: real,
    failCount: 0,
    totalRequests: 0,
    lastUsedAt: null,
    createdAt: now,
  });
}

writeFileSync(
  "/workspace/storage/control-plane.json",
  JSON.stringify({
    accounts,
    proxies: [
      {
        id: "px-tokyo-a",
        name: "Tokyo A",
        type: "http",
        host: "proxy.example.net",
        port: 10000,
        username: "u",
        stickySessionId: "tok-a",
        region: "JP",
        status: "active",
        maxAccounts: 8,
        remark: "",
        createdAt: now,
      },
    ],
    settings: {
      maxRetry: 3,
      failThreshold: 5,
      coolDownSeconds: 300,
      intervalMinMs: 800,
      intervalMaxMs: 2500,
      concurrencyPerWorker: 3,
      enforceProxy: true,
      replyTimeoutMs: 90_000,
      chatgptSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
      geminiSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
    },
    savedAt: now,
  }),
);

let apiKey = "";
try {
  apiKey = JSON.parse(readFileSync("/workspace/storage/api-keys.json", "utf8")).apiKey || "";
} catch {
  apiKey = "";
}
if (!apiKey) {
  apiKey = `sk-relay-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  writeFileSync("/workspace/storage/api-keys.json", JSON.stringify({ apiKey }, null, 2), { mode: 0o600 });
}

writeFileSync("/workspace/storage/worker.py", localWorkerScript());
writeFileSync("/workspace/storage/worker-token.txt", apiKey);
process.stdout.write(apiKey + "\n");
