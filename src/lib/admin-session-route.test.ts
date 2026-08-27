import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { handleAdminSessionGet } from "./admin-session.ts";

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  RELAY_ADMIN_TOKEN: process.env.RELAY_ADMIN_TOKEN,
  RELAY_WORKER_TOKEN: process.env.RELAY_WORKER_TOKEN,
  RELAY_REQUIRE_ADMIN_LOGIN: process.env.RELAY_REQUIRE_ADMIN_LOGIN,
  RELAY_SKIP_DB: process.env.RELAY_SKIP_DB,
};

before(() => {
  process.env.RELAY_ADMIN_TOKEN = "ad-relay-route-test-token";
  process.env.RELAY_WORKER_TOKEN = "wk-relay-route-test-token";
  process.env.RELAY_SKIP_DB = "1";
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("production never auto-issues an administrator cookie", async () => {
  process.env.NODE_ENV = "production";
  process.env.RELAY_REQUIRE_ADMIN_LOGIN = "0";
  const response = await handleAdminSessionGet(new Request("https://relay.example/api/admin/session"));
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.deepEqual(await response.json(), { ok: false, error: "需要管理员凭证" });
});

test("development auto-login remains explicit and same-site", async () => {
  process.env.NODE_ENV = "development";
  process.env.RELAY_REQUIRE_ADMIN_LOGIN = "0";
  const response = await handleAdminSessionGet(new Request("https://127.0.0.1/api/admin/session"));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /SameSite=None/);
});
