import assert from "node:assert/strict";
import { test } from "node:test";
import { loginPackTextFiles } from "./session-file.ts";
import type { Account, Proxy } from "./types.ts";

const account: Account = {
  id: "login-test",
  platform: "leonardo",
  email: "login@example.invalid",
  remark: "",
  status: "pending_login",
  proxyId: "proxy-test",
  sessionPath: null,
  failCount: 0,
  totalRequests: 0,
  lastUsedAt: null,
  createdAt: "2026-08-28T00:00:00.000Z",
};

const proxy: Proxy = {
  id: "proxy-test",
  name: "test",
  type: "ss",
  host: "127.0.0.1",
  port: 8443,
  username: "",
  method: "2022-blake3-aes-256-gcm",
  stickySessionId: "login-test",
  region: "test",
  status: "active",
  maxAccounts: 1,
  remark: "",
  createdAt: "2026-08-28T00:00:00.000Z",
};

test("Leonardo login pack never loops tab creation or steals focus", () => {
  const files = loginPackTextFiles(account, proxy, "test-password");
  const script = new TextDecoder().decode(files.find((file) => file.name === "login.py")?.data);
  const wait = script.slice(script.indexOf("def wait_login"), script.indexOf("def ensure_canva_and_leonardo_tabs"));
  const firstOpen = wait.indexOf("ensure_canva_and_leonardo_tabs(context, page)");
  assert.ok(firstOpen > 0);
  const loop = wait.slice(firstOpen + "ensure_canva_and_leonardo_tabs(context, page)".length);
  assert.doesNotMatch(loop, /ensure_canva_and_leonardo_tabs/);
  assert.doesNotMatch(loop, /click_canva_sso|bring_to_front|dismiss_canva_cookies/);
  assert.doesNotMatch(script, /if click_canva_sso\(leo_login\)/);
  assert.match(script, /助手不会自动点击或抢焦点/);
  assert.match(script, /助手不会重复建页/);
  const kill = script.indexOf("kill_helper_chrome(dest)");
  const wipe = script.indexOf("shutil.rmtree(dest, ignore_errors=True)", kill);
  const clone = script.indexOf("clone_chrome_profile(live_data, dest)", wipe);
  assert.ok(kill > 0 && wipe > kill && clone > wipe, "wipe only the dedicated profile before cloning");
});
