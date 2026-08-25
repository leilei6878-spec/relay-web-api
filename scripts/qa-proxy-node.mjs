import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(25000);
const rec = [];
const log = (n, ok, d = "") => {
  rec.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);
};
try {
  await page.goto("http://127.0.0.1:8080/proxies", { waitUntil: "networkidle" });
  const jp = page.locator("article", { hasText: "Japan-BGP-SS2022" });
  await jp.getByRole("button", { name: "测试连通" }).click();
  await jp.getByText(/38\.175\.201\.137:8443 通/).waitFor({ timeout: 15000 });
  log("日本节点 TCP 通", true, (await jp.innerText()).replace(/\s+/g, " ").slice(0, 220));
} catch (e) {
  log("异常", false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
if (rec.some((r) => !r.ok)) process.exitCode = 1;
