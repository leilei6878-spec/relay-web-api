import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getSaasSession, type SaasSession } from "./saas-auth.ts";
import {
  listUserSaasSessions,
  revokeOtherSaasSessions,
  revokeUserSaasSession,
  rotateSaasRecoveryCodes,
} from "./saas-session-security.ts";
import { sha256 } from "./saas-crypto.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  const files = (await readdir("migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  const db = { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
  return { pg, db };
}

async function seed(pg: PGlite) {
  await pg.query("insert into relay_tenants(id,slug,name,billing_email) values ('security-tenant','security-tenant','Security Tenant','security@example.test')");
  for (const id of ["security-user", "other-user"]) {
    await pg.query(
      "insert into relay_saas_users(id,email,email_normalized,name,password_hash,mfa_enabled) values ($1,$2,$2,$1,'hash',true)",
      [id, `${id}@example.test`],
    );
    await pg.query("insert into relay_tenant_memberships(tenant_id,user_id,role,status) values ('security-tenant',$1,'owner','active')", [id]);
  }
  const sessions = [
    ["session-current", "security-user", "token-current", "Windows Chrome", "203.0.113.10"],
    ["session-other", "security-user", "token-other", "iPhone Safari", "203.0.113.11"],
    ["session-foreign", "other-user", "token-foreign", "Linux Firefox", "203.0.113.12"],
  ];
  for (const [id, user, token, agent, ip] of sessions) await pg.query(
    `insert into relay_saas_sessions
      (id,user_id,tenant_id,token_hash,csrf_hash,ip_address,user_agent,expires_at,mfa_verified_at,last_seen_at)
     values ($1,$2,'security-tenant',$3,$4,$5,$6,now()+interval '1 day',now(),now())`,
    [id, user, sha256(token), sha256(`csrf-${id}`), ip, agent],
  );
}

function session(): SaasSession {
  return {
    sessionId: "session-current", userId: "security-user", tenantId: "security-tenant",
    email: "security-user@example.test", name: "Security User", tenantName: "Security Tenant",
    tenantStatus: "active", role: "owner", csrfHash: sha256("csrf-session-current"),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), mfaVerified: true,
    mfaVerifiedAt: new Date().toISOString(), mfaEnabled: true, legalAcceptanceRequired: false,
  };
}

test("session inventory is user-scoped and returns device metadata without credential hashes", async () => {
  const { pg, db } = await database(); await seed(pg);
  const rows = await listUserSaasSessions("security-user", "session-current", db);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === "session-current")?.current, true);
  assert.equal(rows.find((row) => row.id === "session-other")?.ipAddress, "203.0.113.11");
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /token-current|token-other|token_hash|csrf_hash/);
  assert.doesNotMatch(serialized, /session-foreign/);
  await pg.close();
});

test("authenticated activity refreshes last-seen at a bounded five-minute cadence", async () => {
  const { pg, db } = await database(); await seed(pg);
  await pg.query("update relay_saas_sessions set last_seen_at=now()-interval '10 minutes' where id='session-current'");
  const request = new Request("https://relay.example.test/api/saas/security", { headers: { cookie: "relay_saas_session=token-current" } });
  assert.ok(await getSaasSession(request, db));
  const touched = await pg.query<{ fresh: boolean }>("select last_seen_at>now()-interval '1 minute' as fresh from relay_saas_sessions where id='session-current'");
  assert.equal(touched.rows[0]?.fresh, true);
  await pg.close();
});

test("single-session revoke cannot target current or another user", async () => {
  const { pg, db } = await database(); await seed(pg);
  assert.deepEqual(await revokeUserSaasSession("security-user", "session-current", "session-other", db), { id: "session-other" });
  const revoked = await pg.query<{ revoked_reason: string; revoked_by_session_id: string }>("select revoked_reason,revoked_by_session_id from relay_saas_sessions where id='session-other'");
  assert.deepEqual(revoked.rows, [{ revoked_reason: "user_revoke", revoked_by_session_id: "session-current" }]);
  await assert.rejects(() => revokeUserSaasSession("security-user", "session-current", "session-current", db), /CURRENT_REQUIRES_LOGOUT/);
  await assert.rejects(() => revokeUserSaasSession("security-user", "session-current", "session-foreign", db), /NOT_REVOCABLE/);
  await pg.close();
});

test("revoke others and recovery rotation preserve current session and never store plaintext codes", async () => {
  const { pg, db } = await database(); await seed(pg);
  assert.deepEqual(await revokeOtherSaasSessions("security-user", "session-current", db), { revoked: 1 });
  await pg.query("update relay_saas_sessions set revoked_at=null,revoked_reason=null,revoked_by_session_id=null where id='session-other'");
  const rotated = await rotateSaasRecoveryCodes(session(), db);
  assert.equal(rotated.recoveryCodes.length, 8);
  assert.equal(new Set(rotated.recoveryCodes).size, 8);
  assert.equal(rotated.revokedSessions, 1);
  const user = await pg.query<{ recovery_codes_hash: string[] }>("select recovery_codes_hash from relay_saas_users where id='security-user'");
  const stored = user.rows[0]?.recovery_codes_hash || [];
  assert.deepEqual(stored.sort(), rotated.recoveryCodes.map(sha256).sort());
  for (const code of rotated.recoveryCodes) assert.ok(!JSON.stringify(stored).includes(code));
  const current = await pg.query<{ revoked_at: string | null }>("select revoked_at from relay_saas_sessions where id='session-current'");
  assert.equal(current.rows[0]?.revoked_at, null);
  await assert.rejects(
    () => rotateSaasRecoveryCodes(session(), db, { acquireLock: async () => false }),
    /MFA_RECOVERY_ROTATION_IN_PROGRESS/,
  );
  await assert.rejects(
    () => rotateSaasRecoveryCodes(session(), db, { acquireLock: async () => { throw new Error("redis down"); } }),
    /MFA_RECOVERY_ROTATION_UNAVAILABLE/,
  );
  await pg.close();
});

test("security API and independent UI stay available across legal/suspension gates", async () => {
  const route = await readFile("src/routes/api/saas/security.ts", "utf8");
  const page = await readFile("src/routes/saas/security-center.tsx", "utf8");
  assert.match(route, /requireLegal: false/);
  assert.match(route, /allowSuspended: true/);
  assert.match(route, /forceMfa: action === "rotate-recovery-codes"/);
  assert.match(route, /auditedTenantMutation/);
  assert.match(page, /独立安全入口/);
});
