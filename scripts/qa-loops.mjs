import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = "http://127.0.0.1:8080";
mkdirSync("/workspace/screenshots", { recursive: true });

const results = [];
function rec(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(15000);

try {
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  rec("总览加载", await page.getByRole("heading", { name: "总览" }).isVisible());
  rec("总览健康账号", await page.getByText("健康账号").isVisible());
  rec("总览 Worker", await page.getByText("Worker 节点").isVisible());

  await page.getByRole("link", { name: "账号池" }).click();
  await page.getByRole("heading", { name: "账号池" }).waitFor();
  rec("账号池页", true);

  const email = `qa.loop.${Date.now()}@mail.test`;
  await page.getByRole("button", { name: "添加账号" }).click();
  const addDlg = page.getByRole("dialog");
  await addDlg.getByPlaceholder("user@mail.test").fill(email);
  await addDlg.locator("input[type='text'], input:not([type])").nth(1).fill("闭环测试");
  await addDlg.getByRole("button", { name: "加入池" }).click();
  await page.waitForTimeout(400);
  rec("添加账号", await page.getByText(email).isVisible(), email);

  await page.getByPlaceholder("搜索邮箱或备注").fill(email);
  await page.waitForTimeout(200);
  rec("搜索过滤", await page.getByText(email).isVisible());

  const row = page.locator("tr", { hasText: email });
  const sel = row.locator("select");
  const opts = await sel.locator("option").allTextContents();
  if (opts.length > 1) {
    await sel.selectOption({ index: 1 });
    rec("绑定代理", true, opts[1].trim());
  } else {
    rec("绑定代理", false, "无代理选项");
  }

  await row.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "开始捕获" }).click();
  await page.getByRole("button", { name: "确认已登录并保存" }).waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: "确认已登录并保存" }).click();
  await page.waitForTimeout(400);
  rec("Session 捕获→健康", await row.getByText("健康").isVisible());

  await page.getByPlaceholder("搜索邮箱或备注").fill("");
  await page.getByRole("button", { name: "批量导入" }).click();
  const importEmail = `qa.import.${Date.now()}@mail.test`;
  await page.getByRole("dialog").locator("textarea").fill(`chatgpt,${importEmail},导入闭环`);
  await page.getByRole("dialog").getByRole("button", { name: "导入" }).click();
  await page.waitForTimeout(300);
  await page.getByPlaceholder("搜索邮箱或备注").fill(importEmail);
  rec("批量导入", await page.getByText(importEmail).isVisible(), importEmail);

  const row2 = page.locator("tr", { hasText: importEmail });
  await row2.getByRole("button", { name: "下线" }).click();
  rec("强制下线", await row2.getByText("失效").isVisible());

  await row2.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /删除 \d/ }).click();
  await page.waitForTimeout(300);
  rec("批量删除", !(await page.getByText(importEmail).isVisible()));

  await page.getByRole("link", { name: "代理" }).click();
  await page.getByRole("heading", { name: "代理" }).waitFor();
  await page.getByRole("button", { name: "添加代理" }).click();
  const pname = `QA-sticky-${Date.now()}`;
  const pdlg = page.getByRole("dialog");
  await pdlg.locator("input").first().fill(pname);
  await pdlg.getByPlaceholder("res.example.net").fill("res-qa.example.net");
  await pdlg.getByRole("button", { name: "保存" }).click();
  await page.waitForTimeout(300);
  rec("添加代理", await page.getByText(pname).isVisible(), pname);

  await page.getByRole("link", { name: "网关试运行" }).click();
  await page.getByRole("heading", { name: "网关试运行" }).waitFor();
  await page.locator("textarea").fill("只回答两个字：通了");
  await page.getByRole("button", { name: "发送" }).click();
  try {
    await page.getByText("已路由").waitFor({ timeout: 45000 });
    const body = await page.locator("main").innerText();
    rec("对话网关", true, body.replace(/\s+/g, " ").slice(0, 160));
  } catch {
    const body = await page.locator("main").innerText();
    rec("对话网关", false, body.replace(/\s+/g, " ").slice(0, 220));
  }

  await page.getByRole("button", { name: "/v1/images/generations" }).click();
  await page.locator("textarea").fill("一颗灰色的小石子，极简静物，浅色背景");
  await page.getByRole("button", { name: "发送" }).click();
  try {
    await page.locator("img[alt='生成结果']").waitFor({ timeout: 60000 });
    rec("图片网关", true);
  } catch {
    rec("图片网关", false, "超时无图");
  }

  await page.getByRole("link", { name: "请求日志" }).click();
  await page.getByRole("heading", { name: "请求日志" }).waitFor();
  rec("日志记录对话", await page.getByText("只回答两个字").isVisible());

  await page.getByRole("link", { name: "调度设置" }).click();
  await page.getByRole("heading", { name: "调度设置" }).waitFor();
  const failInput = page.locator("input[type=number]").nth(1);
  await failInput.fill("7");
  rec("修改摘除阈值", (await failInput.inputValue()) === "7");
  await page.getByRole("button", { name: "重置演示数据" }).click();
  rec("重置演示", true);

  await page.getByRole("link", { name: "账号池" }).click();
  await page.waitForTimeout(400);
  rec("重置后演示号回来", await page.getByText("pool.alpha@mail.test").isVisible());

  await page.screenshot({ path: "/workspace/screenshots/qa-accounts.png", fullPage: true });
} catch (err) {
  rec("脚本异常", false, String(err).slice(0, 400));
  await page.screenshot({ path: "/workspace/screenshots/qa-error.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log("\n---");
console.log(`passed ${results.filter((r) => r.ok).length}/${results.length}`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
