import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getSaasSession, switchSaasTenantSession, type SaasSession } from "./saas-auth.ts";
import { sha256 } from "./saas-crypto.ts";
import { listUserSaasTenants } from "./saas-tenants.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  const files = (await readdir("migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  const db = { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
  return { pg, db };
}

async function seed(pg: PGlite) {
  for (const [id, status] of [["tenant-a", "active"], ["tenant-b", "active"], ["tenant-c", "suspended"], ["tenant-foreign", "active"]]) {
    await pg.query("insert into relay_tenants(id,slug,name,status,billing_email) values ($1,$1,$1,$2,$3)", [id, status, `${id}@example.test`]);
  }
  await pg.query("insert into relay_saas_users(id,email,email_normalized,name,password_hash,mfa_enabled) values ('switch-user','switch@example.test','switch@example.test','Switch User','hash',true)");
  await pg.query("insert into relay_saas_users(id,email,email_normalized,name,password_hash) values ('foreign-user','foreign@example.test','foreign@example.test','Foreign User','hash')");
  for (const [tenant, role] of [["tenant-a", "owner"], ["tenant-b", "developer"], ["tenant-c", "viewer"]]) {
    await pg.query("insert into relay_tenant_memberships(tenant_id,user_id,role,status) values ($1,'switch-user',$2,'active')", [tenant, role]);
  }
  await pg.query("insert into relay_tenant_memberships(tenant_id,user_id,role,status) values ('tenant-foreign','foreign-user','owner','active')");
  const mfaAt = new Date(Date.now() - 60 * 60_000).toISOString();
  await pg.query(
    `insert into relay_saas_sessions
      (id,user_id,tenant_id,token_hash,csrf_hash,ip_address,user_agent,expires_at,mfa_verified_at)
     values ('switch-current','switch-user','tenant-a',$1,$2,'203.0.113.80','Switch Browser',now()+interval '1 day',$3)`,
    [sha256("switch-token"), sha256("switch-csrf"), mfaAt],
  );
  return mfaAt;
}

function session(mfaAt: string): SaasSession {
  return {
    sessionId: "switch-current", userId: "switch-user", tenantId: "tenant-a", email: "switch@example.test",
    name: "Switch User", tenantName: "tenant-a", tenantStatus: "active", role: "owner",
    csrfHash: sha256("switch-csrf"), expiresAt: new Date(Date.now()+86_400_000).toISOString(),
    mfaVerified: true, mfaVerifiedAt: mfaAt, mfaEnabled: true, legalAcceptanceRequired: false,
  };
}

function cookieHeader(cookies: string[]) {
  return cookies.map((value) => value.split(";", 1)[0]).join("; ");
}

test("tenant list is user-scoped and keeps suspended memberships available for rights access", async () => {
  const { pg, db } = await database(); await seed(pg);
  const rows = await listUserSaasTenants("switch-user", db);
  assert.deepEqual(rows.map((row) => row.id), ["tenant-a", "tenant-b", "tenant-c"]);
  assert.equal(rows.find((row) => row.id === "tenant-b")?.role, "developer");
  assert.equal(rows.find((row) => row.id === "tenant-c")?.status, "suspended");
  assert.ok(!JSON.stringify(rows).includes("tenant-foreign"));
  await pg.close();
});

test("tenant switch is atomic, membership-bound and preserves the original MFA timestamp", async () => {
  const { pg, db } = await database(); const mfaAt = await seed(pg);
  const request = new Request("https://relay.example.test/api/saas/tenants", { method: "POST", headers: { "user-agent": "New Switch Browser" } });
  await assert.rejects(() => switchSaasTenantSession(session(mfaAt), "tenant-foreign", request, db), /TENANT_SWITCH_NOT_ALLOWED/);
  assert.equal((await pg.query<{ revoked_at: string | null }>("select revoked_at from relay_saas_sessions where id='switch-current'")).rows[0]?.revoked_at, null);
  const switched = await switchSaasTenantSession(session(mfaAt), "tenant-b", request, db);
  assert.equal(switched.tenant.id, "tenant-b");
  assert.equal(switched.tenant.role, "developer");
  assert.equal(switched.mfaVerified, true);
  const old = await pg.query<{ revoked_reason: string; revoked_by_session_id: string }>("select revoked_reason,revoked_by_session_id from relay_saas_sessions where id='switch-current'");
  assert.deepEqual(old.rows, [{ revoked_reason: "tenant_switch", revoked_by_session_id: switched.sessionId }]);
  const next = await pg.query<{ mfa_verified_at: Date | string }>("select mfa_verified_at from relay_saas_sessions where id=$1", [switched.sessionId]);
  assert.equal(new Date(next.rows[0]!.mfa_verified_at).toISOString(), new Date(mfaAt).toISOString());
  const authenticated = await getSaasSession(new Request("https://relay.example.test/api/saas/session", { headers: { cookie: cookieHeader(switched.cookies) } }), db);
  assert.equal(authenticated?.tenantId, "tenant-b");
  assert.equal(authenticated?.role, "developer");
  await pg.close();
});

test("two concurrent switches from one session have exactly one winner", async () => {
  const { pg, db } = await database(); const mfaAt = await seed(pg);
  const request = new Request("https://relay.example.test/api/saas/tenants", { method: "POST" });
  const results = await Promise.allSettled([
    switchSaasTenantSession(session(mfaAt), "tenant-b", request, db),
    switchSaasTenantSession(session(mfaAt), "tenant-c", request, db),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await pg.query<{ count: number }>("select count(*)::int as count from relay_saas_sessions where user_id='switch-user' and revoked_at is null")).rows[0]?.count, 1);
  await pg.close();
});

test("tenant switch API is CSRF-protected, legal/suspension-safe and audited", async () => {
  const route = await readFile("src/routes/api/saas/tenants.ts", "utf8");
  const shell = await readFile("src/components/saas-shell.tsx", "utf8");
  assert.match(route, /requireCsrf: true, requireLegal: false, allowSuspended: true/);
  assert.match(route, /auditedTenantMutation/);
  assert.match(route, /tenant\.switch/);
  assert.match(shell, /aria-label="当前租户"/);
  assert.match(shell, /\/api\/saas\/tenants/);
});
