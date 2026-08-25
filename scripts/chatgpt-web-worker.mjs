#!/usr/bin/env node
/**
 * ChatGPT web worker: open chatgpt.com with storage_state + sticky proxy,
 * send one user message, wait until streaming stops, print JSON on stdout.
 */
import { chromium } from "playwright";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const input = JSON.parse(await readStdin());
const {
  prompt,
  timeoutMs = 90_000,
  accountId,
  sessionPath,
  proxy,
  selectors,
} = input;

function fail(error, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error, ...extra }) + "\n");
  process.exit(0);
}

if (!prompt?.trim()) fail("没有要发送的内容");
if (!sessionPath || !existsSync(sessionPath)) {
  fail("没有服务端 Session。请在账号池重新拖入 state.json（演示登录不能发真网页）");
}
if (proxy?.host && /\.example\.net$/i.test(proxy.host)) {
  fail("当前绑定的是演示代理，无法打开 ChatGPT。请换成真实 sticky 住宅 IP 后重新登录");
}

const sel = {
  input: selectors?.input?.length
    ? selectors.input
    : ["#prompt-textarea", "textarea#prompt-textarea", "div[contenteditable='true']#prompt-textarea"],
  send: selectors?.send?.length
    ? selectors.send
    : ["button[data-testid='send-button']", "button[aria-label='Send prompt']"],
  assistant: selectors?.assistant?.length
    ? selectors.assistant
    : ["div[data-message-author-role='assistant']"],
  streamingStop: selectors?.streamingStop?.length
    ? selectors.streamingStop
    : ["button[aria-label='Stop streaming']", "button[data-testid='stop-button']"],
};

const shotDir = resolve("storage/errors");
mkdirSync(shotDir, { recursive: true });

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const contextOptions = {
    storageState: sessionPath,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
  if (proxy?.server) {
    contextOptions.proxy = {
      server: proxy.server,
      ...(proxy.username ? { username: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {}),
    };
  }

  const context = await browser.newContext(contextOptions);
  await context.addInitScript(
    "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
  );
  const page = await context.newPage();
  page.setDefaultTimeout(Math.min(timeoutMs, 45_000));

  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1200);

  const loginWall = await page
    .getByRole("button", { name: /log in|sign up|登录/i })
    .first()
    .isVisible()
    .catch(() => false);
  const input = await firstVisible(page, sel.input);
  if (!input || loginWall) {
    const shot = await snap(page, accountId);
    await context.storageState({ path: sessionPath }).catch(() => {});
    fail("Session 失效或停在登录页，请重新用本机助手登录", { screenshot: shot });
  }

  const before = await page.locator(sel.assistant.join(", ")).count();
  await input.click();
  await page.keyboard.press("Control+A").catch(() => {});
  await input.fill(prompt).catch(async () => {
    await page.keyboard.type(prompt, { delay: 12 });
  });

  const send = await firstVisible(page, sel.send);
  if (send) await send.click();
  else await page.keyboard.press("Enter");

  await waitUntilIdle(page, sel, timeoutMs, before);

  const nodes = page.locator(sel.assistant.join(", "));
  const count = await nodes.count();
  if (count === 0) {
    const shot = await snap(page, accountId);
    fail("页面上没有助手回复", { screenshot: shot });
  }
  const text = (await nodes.nth(count - 1).innerText()).trim();
  if (!text) {
    const shot = await snap(page, accountId);
    fail("助手回复是空的", { screenshot: shot });
  }

  await context.storageState({ path: sessionPath }).catch(() => {});
  await context.close();
  await browser.close();
  process.stdout.write(JSON.stringify({ ok: true, text }) + "\n");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  fail(message.slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
}

async function firstVisible(page, list) {
  for (const s of list) {
    const loc = page.locator(s).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function waitUntilIdle(page, sel, timeoutMs, beforeCount) {
  const deadline = Date.now() + timeoutMs;
  const stopSel = sel.streamingStop.join(", ");
  try {
    await page.locator(stopSel).first().waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    /* fast reply, no stop button */
  }
  try {
    await page.locator(stopSel).first().waitFor({
      state: "hidden",
      timeout: Math.max(1000, deadline - Date.now()),
    });
  } catch {
    /* keep going, check assistant text */
  }
  const remain = deadline - Date.now();
  if (remain <= 0) throw new Error("等待回复超时");
  await page.waitForFunction(
    ({ assistant, before }) => {
      const nodes = document.querySelectorAll(assistant);
      if (nodes.length <= before) return false;
      const last = nodes[nodes.length - 1];
      return (last?.innerText || "").trim().length > 0;
    },
    { assistant: sel.assistant.join(","), before: beforeCount },
    { timeout: remain },
  );
  await page.waitForTimeout(400);
}

async function snap(page, accountId) {
  try {
    const file = resolve("storage/errors", `${accountId || "unknown"}-${Date.now()}.png`);
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise((resolveStdin) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolveStdin(chunks.join("")));
  });
}
