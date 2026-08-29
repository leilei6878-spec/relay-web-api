import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { handleAdminSessionDelete, handleAdminSessionGet, handleAdminSessionPost } from "./admin-session.ts";
import { hashAdminPassword, resetAdminLoginAttemptsForTests } from "./admin-password.ts";
import { totpCode } from "./saas-crypto.ts";

const saved = { ...process.env };
let pg: PGlite;
let db: { query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]> };

before(async () => {
  pg = new PGlite(); await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql",
    "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql",
    "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql",
  ]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  db = { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
});

beforeEach(async () => {
  process.env.NODE_ENV = "development";
  process.env.RELAY_ADMIN_TOKEN = "ad-relay-route-test-token";
  process.env.RELAY_ADMIN_USERNAME = "admin";
  process.env.RELAY_ADMIN_PASSWORD_HASH = hashAdminPassword("route-test-password", Buffer.alloc(16, 3));
  process.env.RELAY_WORKER_TOKEN = "wk-relay-route-test-token";
  process.env.RELAY_REQUIRE_ADMIN_LOGIN = "1";
  process.env.RELAY_REQUIRE_ADMIN_MFA = "0";
  delete process.env.RELAY_ADMIN_TOTP_SECRET;
  resetAdminLoginAttemptsForTests();
  await pg.query("delete from relay_admin_sessions");
  await pg.query("delete from relay_commercial_config_versions");
});

after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await pg.close();
});

test("production never auto-issues an administrator cookie", async () => {
  process.env.NODE_ENV = "production";
  process.env.RELAY_REQUIRE_ADMIN_LOGIN = "0";
  const response = await handleAdminSessionGet(new Request("https://relay.example/api/admin/session"), db);
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.deepEqual(await response.json(), { ok: false, error: "需要管理员凭证" });
});

test("development auto-login creates a short hash-backed SameSite session", async () => {
  process.env.RELAY_REQUIRE_ADMIN_LOGIN = "0";
  const response = await handleAdminSessionGet(new Request("https://127.0.0.1/api/admin/session"), db);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /relay_admin=as-relay-/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  const stored = await pg.query<Record<string, unknown>>("select token_sha256 from relay_admin_sessions");
  assert.equal(stored.rows.length, 1);
  assert.equal(JSON.stringify(stored.rows).includes("as-relay-"), false);
});

test("configured administrator password issues a hash-backed session without exposing the root token", async () => {
  const response = await handleAdminSessionPost(
    new Request("https://relay.example/api/admin/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "route-test-password" }),
    }), db,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, role: "admin", mfaVerified: false, authMethod: "password" });
  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /relay_admin=as-relay-/);
  assert.doesNotMatch(cookie, /ad-relay-route-test-token/);
  assert.match(cookie, /SameSite=Strict/);
});

test("administrator MFA rejects password-only login and marks a valid TOTP session", async () => {
  const secret = "JBSWY3DPEHPK3PXP";
  process.env.RELAY_REQUIRE_ADMIN_MFA = "1";
  process.env.RELAY_ADMIN_TOTP_SECRET = secret;
  const missing = await handleAdminSessionPost(new Request("https://relay.example/api/admin/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "route-test-password" }),
  }), db);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.has("set-cookie"), false);
  const accepted = await handleAdminSessionPost(new Request("https://relay.example/api/admin/session", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "route-test-password", totp: totpCode(secret) }),
  }), db);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as { mfaVerified: boolean }).mfaVerified, true);
});

test("wrong administrator credentials fail without issuing a cookie", async () => {
  const response = await handleAdminSessionPost(
    new Request("https://relay.example/api/admin/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "wrong" }),
    }), db,
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("set-cookie"), false);
});

test("administrator recovery token creates a session only through the allowed recovery surface", async () => {
  const response = await handleAdminSessionPost(
    new Request("http://127.0.0.1/api/admin/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "ad-relay-route-test-token" }),
    }), db,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { authMethod: string; mfaVerified: boolean };
  assert.equal(body.authMethod, "recovery_token");
  assert.equal(body.mfaVerified, true);
  assert.match(response.headers.get("set-cookie") || "", /relay_admin=as-relay-/);
});

test("logout revokes the server-side session and clears the browser cookie", async () => {
  const login = await handleAdminSessionPost(new Request("https://relay.example/api/admin/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "route-test-password" }),
  }), db);
  const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0]!;
  const logout = await handleAdminSessionDelete(new Request("https://relay.example/api/admin/session", {
    method: "DELETE", headers: { Cookie: cookie, Origin: "https://relay.example", Host: "relay.example" },
  }), db);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);
  const after = await handleAdminSessionGet(new Request("https://relay.example/api/admin/session", { headers: { Cookie: cookie } }), db);
  assert.equal(after.status, 401);
});
