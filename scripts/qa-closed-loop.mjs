import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

await new Promise((resolve, reject) => {
  const b = spawn("node", ["--experimental-strip-types", "--no-warnings", "scripts/bootstrap-runtime.mjs"], {
    cwd: "/workspace",
    stdio: "inherit",
  });
  b.on("exit", (c) => (c === 0 ? resolve(null) : reject(new Error("bootstrap"))));
});

const rec = [];
const pass = (name, ok, detail = "") => {
  rec.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const key = JSON.parse(readFileSync("/workspace/storage/api-keys.json", "utf8")).apiKey;

const unauth = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
});
pass("无密钥 401", unauth.status === 401);

const chat = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ messages: [{ role: "user", content: "closed-loop" }] }),
});
const chatBody = await chat.json();
pass(
  "对话 API 闭环",
  chat.status === 200 && chatBody?.choices?.[0]?.message?.content === "MOCK:closed-loop",
  JSON.stringify(chatBody).slice(0, 220),
);

const img = await fetch("http://127.0.0.1:8080/v1/images/generations", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ prompt: "东京雾中车站" }),
});
const imgBody = await img.json();
pass(
  "出图 API 闭环",
  img.status === 200 && typeof imgBody?.data?.[0]?.url === "string" && imgBody.data[0].url.startsWith("data:image"),
  JSON.stringify(imgBody).slice(0, 160),
);

try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(40000);
  await page.goto("http://127.0.0.1:8080/playground", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "发送" }).waitFor({ timeout: 20000 });
  await page.locator("textarea").first().fill("页面闭环");
  await page.getByRole("button", { name: "发送" }).click({ force: true, timeout: 8000 });
  try {
    await page.getByText("MOCK:页面闭环").waitFor({ timeout: 40000 });
    pass("试运行对话闭环", true);
  } catch (err) {
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 500);
    pass("试运行对话闭环", false, text);
  }
  await page.getByRole("button", { name: "/v1/images/generations" }).click({ force: true });
  await page.locator("textarea").first().fill("雾中东京");
  await page.getByRole("button", { name: "发送" }).click({ force: true, timeout: 8000 });
  const imgEl = page.locator('img[alt="生成结果"]');
  pass("试运行出图闭环", await imgEl.waitFor({ timeout: 20000 }).then(() => true).catch(() => false));
  await page.goto("http://127.0.0.1:8080/", { waitUntil: "load" });
  pass("总览交付清单", await page.getByText("商业交付清单").waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
  await browser.close();
} catch (err) {
  try {
    const { chromium } = await import("playwright");
  } catch {
    /* ignore */
  }
  pass("试运行对话闭环", false, err instanceof Error ? err.message.slice(0, 240) : String(err));
}

const failed = rec.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} failed`);
  process.exit(1);
}
console.log(`\n${rec.length} passed`);
