import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createAdminSession, findAdminSession, revokeAdminSession } from "./admin-sessions.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of ["0001_relay.sql", "0004_schema_meta.sql", "0012_admin_sessions.sql"]) {
    await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  return { pg, db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows } };
}

function request() {
  return new Request("https://relay.example.test/api/admin/session", {
    headers: { "x-real-ip": "203.0.113.8", "user-agent": "relay-admin-test" },
  });
}

test("administrator browser sessions store only hashes, have bounded fixed expiry and expose MFA state", async () => {
  const { pg, db } = await database();
  const session = await createAdminSession({ request: request(), authMethod: "password", mfaVerified: true, env: { RELAY_ADMIN_SESSION_HOURS: "99" } as NodeJS.ProcessEnv }, db);
  assert.match(session.token, /^as-relay-/);
  assert.equal(session.maxAge, 24 * 3600);
  const rows = await pg.query<Record<string, unknown>>("select * from relay_admin_sessions");
  assert.equal(rows.rows.length, 1);
  assert.equal(JSON.stringify(rows.rows).includes(session.token), false);
  assert.match(String(rows.rows[0]?.token_sha256), /^[0-9a-f]{64}$/);
  assert.match(String(rows.rows[0]?.client_ip_sha256), /^[0-9a-f]{64}$/);
  assert.equal(String(rows.rows[0]?.client_ip_sha256).includes("203.0.113.8"), false);
  const found = await findAdminSession(session.token, db);
  assert.equal(found?.mfaVerified, true);
  assert.equal(found?.authMethod, "password");
  const audit = await pg.query<{ detail: string }>("select detail from relay_audit where action='admin.session.create'");
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]?.detail.includes(session.token), false);
  await pg.close();
});

test("revoked or expired administrator sessions fail closed and logout is audited", async () => {
  const { pg, db } = await database();
  const session = await createAdminSession({ request: request(), authMethod: "password", mfaVerified: false }, db);
  assert.ok(await findAdminSession(session.token, db));
  assert.equal(await revokeAdminSession(session.token, db), true);
  assert.equal(await findAdminSession(session.token, db), null);
  assert.equal(await revokeAdminSession(session.token, db), false);
  const revokedAudit = await pg.query<{ count: number }>("select count(*)::int as count from relay_audit where action='admin.session.revoke'");
  assert.equal(revokedAudit.rows[0]?.count, 1);
  const expired = await createAdminSession({ request: request(), authMethod: "development", mfaVerified: false }, db);
  await pg.query("update relay_admin_sessions set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where token_sha256<> (select token_sha256 from relay_admin_sessions where revoked_at is not null limit 1)");
  assert.equal(await findAdminSession(expired.token, db), null);
  await pg.close();
});

test("legacy root-token cookies are never accepted as administrator sessions", async () => {
  const { pg, db } = await database();
  assert.equal(await findAdminSession("ad-relay-long-lived-root-token", db), null);
  const rows = await pg.query<{ count: number }>("select count(*)::int as count from relay_admin_sessions");
  assert.equal(rows.rows[0]?.count, 0);
  await pg.close();
});
