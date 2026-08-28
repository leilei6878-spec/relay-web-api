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
  assert.equal(script.match(/ensure_canva_and_leonardo_tabs\(context, page\)/g)?.length, 1);
  assert.doesNotMatch(script, /if click_canva_sso\(leo_login\)/);
  assert.match(script, /助手不会自动点击或抢焦点/);
  assert.match(script, /助手不会重复建页/);
  const kill = script.indexOf("kill_helper_chrome(dest)");
  const wipe = script.indexOf("shutil.rmtree(dest, ignore_errors=True)", kill);
  const clone = script.indexOf("clone_chrome_profile(live_data, dest)", wipe);
  assert.ok(kill > 0 && wipe > kill && clone > wipe, "wipe only the dedicated profile before cloning");
  const launch = script.slice(script.indexOf("def open_leonardo_chrome"), script.indexOf("def boot"));
  const spawn = launch.indexOf("subprocess.Popen(args");
  const checkpoint = launch.indexOf("全部完成后回到这里按回车");
  const attach = launch.indexOf("connect_over_cdp", checkpoint);
  assert.match(launch, /args\.extend\(\[CANVA_COM, LEO_LOGIN\]\)/);
  assert.ok(spawn > 0 && checkpoint > spawn && attach > checkpoint, "attach only after the manual checkpoint");
  const manualCheck = wait.slice(wait.indexOf('if PLATFORM == "leonardo":'), wait.indexOf("else:", wait.indexOf('if PLATFORM == "leonardo":')));
  assert.match(manualCheck, /正在只读检查 Leonardo 登录结果/);
  assert.doesNotMatch(manualCheck, /goto|click|bring_to_front|new_page|ensure_canva_and_leonardo_tabs/);
});
