import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { localWorkerScript } from "../src/lib/local-worker-script.ts";

const rec = [];
const pass = (name, ok, detail = "") => {
  rec.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const plane = JSON.parse(readFileSync("/workspace/src/lib/seed.ts", "utf8") ? "{}" : "{}");
mkdirSync("/workspace/storage", { recursive: true });
writeFileSync(
  "/workspace/storage/control-plane.json",
  JSON.stringify({
    accounts: [
      {
        id: "ac-1",
        platform: "chatgpt",
        email: "pool.alpha@mail.test",
        remark: "qa",
        status: "healthy",
        proxyId: "px-tokyo-a",
        sessionPath: "storage/sessions/ac-1.json",
        failCount: 0,
        totalRequests: 1,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      },
    ],
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
        createdAt: new Date().toISOString(),
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
      replyTimeoutMs: 90000,
      chatgptSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
      geminiSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
    },
    savedAt: new Date().toISOString(),
  }),
);
void plane;

mkdirSync("/tmp/relay-worker-test", { recursive: true });
writeFileSync("/tmp/relay-worker-test/worker.py", localWorkerScript());

const unauth = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
});
pass("API 无密钥拒绝", unauth.status === 401, String(unauth.status));

const key = JSON.parse(readFileSync("/workspace/storage/api-keys.json", "utf8")).apiKey;
pass("已签发 API Key", Boolean(key && key.startsWith("sk-relay-")));

const worker = spawn("python3", ["/tmp/relay-worker-test/worker.py"], {
  env: {
    ...process.env,
    RELAY_HEADLESS: "1",
    RELAY_TEST_URL: "self",
    RELAY_WORKER_PORT: "18767",
    RELAY_GATEWAY: "http://127.0.0.1:8080",
    RELAY_TOKEN: key,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
worker.stdout.on("data", (c) => process.stdout.write(c));
worker.stderr.on("data", (c) => process.stderr.write(c));

const end = Date.now() + 15000;
let up = false;
while (Date.now() < end) {
  try {
    const h = await fetch("http://127.0.0.1:18767/health");
    if (h.ok) {
      up = true;
      break;
    }
  } catch {
    /* retry */
  }
  await new Promise((r) => setTimeout(r, 250));
}
pass("worker health", up);

const chat = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    model: "gpt-4o",
    messages: [{ role: "user", content: "api-loop" }],
  }),
});
const chatBody = await chat.json();
const text = chatBody?.choices?.[0]?.message?.content;
pass("OpenAI 兼容对话", chat.status === 200 && text === "MOCK:api-loop", JSON.stringify(chatBody).slice(0, 280));

const img = await fetch("http://127.0.0.1:8080/v1/images/generations", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({ prompt: "fog" }),
});
pass("出图未交付返回 501", img.status === 501, String(img.status));

worker.kill("SIGTERM");
const failed = rec.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} failed`);
  process.exit(1);
}
console.log(`\n${rec.length} passed`);
