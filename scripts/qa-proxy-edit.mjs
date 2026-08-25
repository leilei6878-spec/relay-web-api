import { chromium } from "playwright";

const rec = [];
const log = (name, ok, d = "") => {
  rec.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${d ? " — " + d : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(20000);

try {
  await page.goto("http://127.0.0.1:8080/proxies", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "代理" }).waitFor();
  log("修改按钮", await page.getByRole("button", { name: "修改" }).first().isVisible());
  log("测试连通", await page.getByRole("button", { name: "测试连通" }).first().isVisible());

  const card = page.locator("article", { hasText: "Tokyo sticky A" });
  await card.getByRole("button", { name: "修改" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByText("名称").locator("..").locator("input").fill("Tokyo sticky A 改");
  await dlg.getByRole("button", { name: "保存修改" }).click();
  await page.waitForTimeout(300);
  log("保存修改", await page.getByText("Tokyo sticky A 改").isVisible());

  await page.locator("article", { hasText: "Tokyo sticky A 改" }).getByRole("button", { name: "测试连通" }).click();
  await page.getByText(/演示代理不能出网|探测失败/).first().waitFor({ timeout: 15000 });
  log("演示代理探测失败", true);

  const jp = page.locator("article", { hasText: "Japan-BGP-SS2022" });
  if (await jp.count()) {
    await jp.getByRole("button", { name: "测试连通" }).click();
    await page.waitForTimeout(14000);
    const t = await jp.innerText();
    log("日本节点探测有结果", /出口 |探测失败/.test(t), t.replace(/\s+/g, " ").slice(0, 180));
  }
} catch (e) {
  log("脚本异常", false, String(e).slice(0, 300));
} finally {
  await browser.close();
}
if (rec.some((r) => !r.ok)) process.exitCode = 1;
