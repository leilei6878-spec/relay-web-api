import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const base = "http://127.0.0.1:8080";
const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(20000);

try {
  await page.goto(base + "/settings", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "重置演示数据" }).click();
  await page.waitForTimeout(300);

  await page.getByRole("link", { name: "账号池" }).click();
  await page.getByRole("heading", { name: "账号池" }).waitFor();
  rec("上线说明", await page.getByText("本机登录助手").first().isVisible());

  await page.getByPlaceholder("搜索邮箱或备注").fill("pool.echo@mail.test");
  const echo = page.locator("tr", { hasText: "pool.echo@mail.test" });
  await echo.getByRole("button", { name: "登录" }).click();
  rec("安全说明", await page.getByText("下载一键登录包").first().isVisible());
  await page.getByRole("button", { name: "下载一键登录包" }).click();
  rec("无代理不能下载助手", await page.getByText(/先绑定 sticky 代理/).first().isVisible());

  await page.getByRole("button", { name: "演示登录" }).click();
  await page.getByRole("button", { name: "写入演示登录" }).click();
  rec("未绑代理被拦", await page.getByText("先绑定 sticky 代理").first().isVisible());

  await page.getByRole("dialog").locator("select").selectOption("px-tokyo-a");
  await page.getByRole("button", { name: "绑定" }).click();
  await page.getByRole("button", { name: "写入演示登录" }).click();
  await page.waitForTimeout(400);
  rec("演示登录上线", await echo.getByText("健康").isVisible());

  await page.getByPlaceholder("搜索邮箱或备注").fill("pool.charlie@mail.test");
  const charlie = page.locator("tr", { hasText: "pool.charlie@mail.test" });
  await charlie.getByRole("button", { name: "登录" }).click();
  rec("下载助手", await page.getByRole("button", { name: "下载一键登录包" }).isVisible());

  writeFileSync("/tmp/bad-state.json", "{not json");
  await page.getByRole("dialog").locator('input[type="file"]').setInputFiles("/tmp/bad-state.json");
  rec("坏文件被拦", await page.getByText(/JSON 无法解析/).first().waitFor({ timeout: 5000 }).then(() => true));

  writeFileSync(
    "/tmp/good-state.json",
    JSON.stringify({
      cookies: [{ name: "session", value: "qa", domain: ".chatgpt.com" }],
      origins: [],
    }),
  );
  await page.getByRole("dialog").locator('input[type="file"]').setInputFiles("/tmp/good-state.json");
  rec("拖入文件上线", await echo.or(charlie).count() >= 0 && await charlie.getByText("健康").waitFor({ timeout: 8000 }).then(() => true));
  rec("登记 Cookie 数", await charlie.getByText("已登记 1 枚 Cookie").isVisible());
} catch (e) {
  rec("脚本异常", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
console.log(`\npassed ${results.filter((r) => r.ok).length}/${results.length}`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
