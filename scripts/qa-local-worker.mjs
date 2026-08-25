import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { localWorkerScript } from "../src/lib/local-worker-script.ts";

const rec = [];
const pass = (name, ok, detail = "") => {
  rec.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

mkdirSync("/tmp/relay-worker-test", { recursive: true });
const workerPy = "/tmp/relay-worker-test/worker.py";
writeFileSync(workerPy, localWorkerScript());

const worker = spawn("python3", [workerPy], {
  env: {
    ...process.env,
    RELAY_HEADLESS: "1",
    RELAY_TEST_URL: "self",
    RELAY_WORKER_PORT: "18765",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
worker.stdout.on("data", (c) => process.stdout.write(c));
worker.stderr.on("data", (c) => process.stderr.write(c));

async function waitHealth(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch("http://127.0.0.1:18765/health");
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const up = await waitHealth();
pass("worker /health", up);

if (up) {
  const mockPage = await fetch("http://127.0.0.1:18765/mock");
  const html = await mockPage.text();
  pass("mock page served", html.includes("prompt-textarea"));

  const empty = await fetch("http://127.0.0.1:18765/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "" }),
  });
  const emptyBody = await empty.json();
  pass("empty prompt rejected", emptyBody.ok === false && /没有/.test(emptyBody.error || ""), emptyBody.error);

  const chat = await fetch("http://127.0.0.1:18765/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "ping-relay",
      storageState: { cookies: [], origins: [] },
      timeoutMs: 25000,
    }),
  });
  const chatBody = await chat.json();
  pass(
    "mock chatgpt roundtrip",
    chatBody.ok === true && chatBody.text === "MOCK:ping-relay",
    JSON.stringify(chatBody).slice(0, 300),
  );

  const cors = await fetch("http://127.0.0.1:18765/health");
  pass("CORS *", cors.headers.get("access-control-allow-origin") === "*");

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(25000);
    await page.goto("http://127.0.0.1:8080/settings", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "重置演示数据" }).click();
    await page.waitForTimeout(300);
    await page.goto("http://127.0.0.1:8080/playground", { waitUntil: "networkidle" });
    const workerLabel = page.getByText(/本机 Worker：已连接/);
    await page.waitForTimeout(1200);
    pass("playground sees worker", await workerLabel.isVisible().catch(() => false));
    const box = page.locator("textarea").first();
    await box.fill("闭环自测");
    await page.getByRole("button", { name: "发送" }).click();
    try {
      await page.getByText("MOCK:闭环自测").waitFor({ timeout: 25000 });
      pass("playground mock reply", true);
    } catch (err) {
      const shot = await page.locator("body").innerText();
      pass("playground mock reply", false, shot.replace(/\s+/g, " ").slice(0, 400));
    }
    await browser.close();
  } catch (err) {
    pass("playground mock reply", false, err instanceof Error ? err.message.slice(0, 240) : String(err));
  }
}

worker.kill("SIGTERM");
const failed = rec.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} failed`);
  process.exit(1);
}
console.log(`\n${rec.length} passed`);
