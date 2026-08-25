import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(20000);
const rec = [];
const log = (n, ok, d="") => { rec.push({ok}); console.log(`${ok?"PASS":"FAIL"}  ${n}${d?" — "+d:""}`); };
try {
  await page.goto("http://127.0.0.1:8080/proxies", { waitUntil: "networkidle" });
  log("说明", await page.getByText("不是你电脑上的 v2rayN").isVisible());
  const jp = page.locator("article", { hasText: "Japan-BGP-SS2022" });
  log("标记按钮", await jp.getByRole("button", { name: "标记本机已通" }).isVisible());
  await jp.getByRole("button", { name: "标记本机已通" }).click();
  await page.waitForTimeout(200);
  log("本机已确认", await jp.getByText("本机已确认通").isVisible());
} catch (e) {
  log("异常", false, String(e).slice(0, 240));
} finally {
  await browser.close();
}
if (rec.some(r => !r.ok)) process.exitCode = 1;
