import assert from "node:assert/strict";
import { test } from "node:test";
import "./test-env.ts";
import { createApiKey } from "./api-keys.ts";
import { ADMIN_COOKIE, adminCookieHeader, allowAutomaticAdminLogin, classify, ensureAdminToken } from "./authz.ts";

process.env.RELAY_SKIP_DB = "1";

test("customer Authorization wins over admin cookie", async () => {
  const admin = await ensureAdminToken();
  const row = await createApiKey({ name: "authz-priority" });
  const req = new Request("http://127.0.0.1/v1/chat/completions", {
    headers: {
      Authorization: `Bearer ${row.key}`,
      Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}`,
    },
  });
  const p = await classify(req);
  assert.equal(p?.kind, "customer");
  if (p?.kind === "customer") assert.equal(p.record.key, row.key);
});

test("admin cookie without bearer is admin", async () => {
  const admin = await ensureAdminToken();
  const req = new Request("http://127.0.0.1/api/admin/metrics", {
    headers: { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}` },
  });
  const p = await classify(req);
  assert.equal(p?.kind, "admin");
});

test("unknown bearer does not fall back to admin cookie", async () => {
  const admin = await ensureAdminToken();
  const req = new Request("http://127.0.0.1/v1/chat/completions", {
    headers: {
      Authorization: "Bearer sk-relay-not-a-real-key-000000",
      Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}`,
    },
  });
  const p = await classify(req);
  assert.equal(p, null);
});

test("x-goog-api-key and ?key= are customer tokens", async () => {
  const row = await createApiKey({ name: "goog-key" });
  const goog = new Request("http://127.0.0.1/v1beta/models/gemini-2.5-flash-image:generateContent", {
    headers: { "x-goog-api-key": row.key },
  });
  const p = await classify(goog);
  assert.equal(p?.kind, "customer");
  const q = new Request(`http://127.0.0.1/v1beta/models/x:generateContent?key=${encodeURIComponent(row.key)}`);
  const p2 = await classify(q);
  assert.equal(p2?.kind, "customer");
});

test("automatic admin login is never allowed in production", () => {
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "production", RELAY_REQUIRE_ADMIN_LOGIN: undefined }), false);
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "production", RELAY_REQUIRE_ADMIN_LOGIN: "0" }), false);
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "production", RELAY_REQUIRE_ADMIN_LOGIN: "1" }), false);
});

test("automatic admin login remains an opt-out development convenience", () => {
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "development", RELAY_REQUIRE_ADMIN_LOGIN: undefined }), true);
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "development", RELAY_REQUIRE_ADMIN_LOGIN: "0" }), true);
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "development", RELAY_REQUIRE_ADMIN_LOGIN: "1" }), false);
});

test("admin cookie stays same-site on HTTP and HTTPS", () => {
  const http = adminCookieHeader("ad-relay-test", false);
  const https = adminCookieHeader("ad-relay-test", true);
  assert.match(http, /HttpOnly/);
  assert.match(http, /SameSite=Lax/);
  assert.doesNotMatch(http, /Secure/);
  assert.match(https, /SameSite=Lax/);
  assert.match(https, /Secure/);
  assert.doesNotMatch(https, /SameSite=None/);
});
