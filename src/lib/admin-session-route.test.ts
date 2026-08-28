import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { handleAdminSessionGet, handleAdminSessionPost } from "./admin-session.ts";
import { hashAdminPassword } from "./admin-password.ts";

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  RELAY_ADMIN_TOKEN: process.env.RELAY_ADMIN_TOKEN,
  RELAY_ADMIN_USERNAME: process.env.RELAY_ADMIN_USERNAME,
  RELAY_ADMIN_PASSWORD_HASH: process.env.RELAY_ADMIN_PASSWORD_HASH,
  RELAY_WORKER_TOKEN: process.env.RELAY_WORKER_TOKEN,
  RELAY_REQUIRE_ADMIN_LOGIN: process.env.RELAY_REQUIRE_ADMIN_LOGIN,
  RELAY_SKIP_DB: process.env.RELAY_SKIP_DB,
};

before(() => {
  process.env.RELAY_ADMIN_TOKEN = "ad-relay-route-test-token";
  process.env.RELAY_ADMIN_USERNAME = "admin";
  process.env.RELAY_ADMIN_PASSWORD_HASH = hashAdminPassword("route-test-password", Buffer.alloc(16, 3));
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

test("configured administrator username and password issue an HttpOnly session", async () => {
  const response = await handleAdminSessionPost(
    new Request("https://relay.example/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "route-test-password" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, role: "admin" });
  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /relay_admin=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

test("wrong administrator credentials fail without issuing a cookie", async () => {
  const response = await handleAdminSessionPost(
    new Request("https://relay.example/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("set-cookie"), false);
});

test("administrator token login remains available for recovery", async () => {
  const response = await handleAdminSessionPost(
    new Request("http://relay.example/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "ad-relay-route-test-token" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") || "", /relay_admin=/);
});
