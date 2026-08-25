import { chromium } from "playwright";

const base = "http://127.0.0.1:8080";
const rec = [];
const log = (name, ok, detail = "") => {
  rec.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(20000);

try {
  await page.goto(base + "/playground", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "网关试运行" }).waitFor();
  log("真网页开关", await page.getByText("ChatGPT 真网页").isVisible());
  await page.locator("textarea").fill("ping");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByText(/无法打开 ChatGPT|没有服务端 Session|请重新拖入/).first().waitFor({ timeout: 40000 });
  const body = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  log("演示号会明确失败", /无法打开 ChatGPT|没有服务端 Session/.test(body), body.slice(0, 240));
} catch (e) {
  log("脚本异常", false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
if (rec.some((r) => !r.ok)) process.exitCode = 1;
