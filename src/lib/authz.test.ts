import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import "./test-env.ts";
import { createApiKey } from "./api-keys.ts";
import { createAdminSession } from "./admin-sessions.ts";
import { ADMIN_COOKIE, adminCookieHeader, allowAutomaticAdminLogin, assertAdmin, assertAdminMfa, classify, ensureAdminToken } from "./authz.ts";

process.env.RELAY_SKIP_DB = "1";
let pg: PGlite;
let db: { query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]> };

before(async () => {
  pg = new PGlite(); await pg.waitReady;
  for (const name of ["0001_relay.sql", "0004_schema_meta.sql", "0009_commercial_config.sql", "0012_admin_sessions.sql"]) {
    await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  db = { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
});

after(async () => { await pg.close(); });

async function adminCookie(mfaVerified = false) {
  const session = await createAdminSession({ request: new Request("https://relay.test/login"), authMethod: "password", mfaVerified }, db);
  return `${ADMIN_COOKIE}=${encodeURIComponent(session.token)}`;
}

test("customer Authorization wins over an administrator session cookie", async () => {
  const row = await createApiKey({ name: "authz-priority" });
  const req = new Request("http://127.0.0.1/v1/chat/completions", {
    headers: { Authorization: `Bearer ${row.key}`, Cookie: await adminCookie() },
  });
  const principal = await classify(req, db);
  assert.equal(principal?.kind, "customer");
  if (principal?.kind === "customer") assert.equal(principal.record.key, row.key);
});

test("hash-backed administrator cookie without bearer is admin", async () => {
  const principal = await classify(new Request("http://127.0.0.1/api/admin/metrics", {
    headers: { Cookie: await adminCookie(true) },
  }), db);
  assert.equal(principal?.kind, "admin");
  if (principal?.kind === "admin") {
    assert.equal(principal.mfaVerified, true);
    assert.equal(principal.authMethod, "password");
  }
});

test("legacy root-token cookies are rejected while the bearer remains a machine principal", async () => {
  const admin = await ensureAdminToken();
  const cookie = await classify(new Request("https://relay.test/api/admin/metrics", {
    headers: { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}` },
  }), db);
  assert.equal(cookie, null);
  const bearer = await classify(new Request("https://relay.test/api/admin/metrics", {
    headers: { Authorization: `Bearer ${admin}` },
  }), db);
  assert.equal(bearer?.kind, "admin");
  if (bearer?.kind === "admin") {
    assert.equal(bearer.authMethod, "bearer");
    assert.equal(bearer.mfaVerified, true);
  }
});

test("an empty Bearer scheme does not shadow the administrator session", async () => {
  const principal = await classify(new Request("http://relay.test/api/usage", {
    headers: { Authorization: "Bearer", Cookie: await adminCookie() },
  }), db);
  assert.equal(principal?.kind, "admin");
});

test("unknown bearer does not fall back to administrator cookie", async () => {
  const principal = await classify(new Request("http://127.0.0.1/v1/chat/completions", {
    headers: { Authorization: "Bearer sk-relay-not-a-real-key-000000", Cookie: await adminCookie() },
  }), db);
  assert.equal(principal, null);
});

test("x-goog-api-key and ?key= are customer tokens", async () => {
  const row = await createApiKey({ name: "goog-key" });
  const goog = await classify(new Request("http://127.0.0.1/v1beta/models/gemini-2.5-flash-image:generateContent", {
    headers: { "x-goog-api-key": row.key },
  }));
  assert.equal(goog?.kind, "customer");
  const query = await classify(new Request(`http://127.0.0.1/v1beta/models/x:generateContent?key=${encodeURIComponent(row.key)}`));
  assert.equal(query?.kind, "customer");
});

test("automatic administrator login is never allowed in production", () => {
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "production", RELAY_REQUIRE_ADMIN_LOGIN: undefined }), false);
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "production", RELAY_REQUIRE_ADMIN_LOGIN: "0" }), false);
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "production", RELAY_REQUIRE_ADMIN_LOGIN: "1" }), false);
});

test("automatic administrator login remains an opt-out development convenience", () => {
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "development", RELAY_REQUIRE_ADMIN_LOGIN: undefined }), true);
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "development", RELAY_REQUIRE_ADMIN_LOGIN: "0" }), true);
  assert.equal(allowAutomaticAdminLogin({ NODE_ENV: "development", RELAY_REQUIRE_ADMIN_LOGIN: "1" }), false);
});

test("administrator cookie is short-lived, HttpOnly and strict same-site", () => {
  const http = adminCookieHeader("as-relay-test", false, 3600);
  const https = adminCookieHeader("as-relay-test", true, 3600);
  assert.match(http, /HttpOnly/);
  assert.match(http, /Max-Age=3600/);
  assert.match(http, /SameSite=Strict/);
  assert.doesNotMatch(http, /Secure/);
  assert.match(https, /SameSite=Strict/);
  assert.match(https, /Secure/);
  assert.doesNotMatch(https, /SameSite=None/);
});

test("cookie-authenticated administrator mutations require trusted origin", async () => {
  const cookie = await adminCookie(true);
  const rejected = await assertAdmin(new Request("https://relay.test/api/admin/plane", {
    method: "PUT", headers: { Cookie: cookie, Origin: "https://evil.test", Host: "relay.test" },
  }), db);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.status, 403);
  const allowed = await assertAdmin(new Request("https://relay.test/api/admin/plane", {
    method: "PUT", headers: { Cookie: cookie, Origin: "https://relay.test", Host: "relay.test" },
  }), db);
  assert.equal(allowed.ok, true);
});

test("commercial or explicit MFA mode blocks non-MFA sessions but allows MFA and machine bearer", async () => {
  const saved = process.env.RELAY_REQUIRE_ADMIN_MFA;
  process.env.RELAY_REQUIRE_ADMIN_MFA = "1";
  try {
    const plain = await assertAdminMfa(new Request("https://relay.test/api/admin/commercial", { headers: { Cookie: await adminCookie(false) } }), db);
    assert.equal(plain.ok, false);
    if (!plain.ok) assert.equal(plain.status, 403);
    const mfa = await assertAdminMfa(new Request("https://relay.test/api/admin/commercial", { headers: { Cookie: await adminCookie(true) } }), db);
    assert.equal(mfa.ok, true);
    const admin = await ensureAdminToken();
    const bearer = await assertAdminMfa(new Request("https://relay.test/api/admin/commercial", { headers: { Authorization: `Bearer ${admin}` } }), db);
    assert.equal(bearer.ok, true);
  } finally {
    if (saved === undefined) delete process.env.RELAY_REQUIRE_ADMIN_MFA;
    else process.env.RELAY_REQUIRE_ADMIN_MFA = saved;
  }
});
