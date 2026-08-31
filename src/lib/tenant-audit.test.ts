import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { SaasSession } from "./saas-auth.ts";
import { auditedTenantMutation, listTenantAuditEvents } from "./tenant-audit.ts";

const migrations = [
  "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
  "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql",
  "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql",
  "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql",
  "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql", "0017_email_delivery_outbox.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql", "0020_tenant_privacy_rights.sql", "0021_customer_session_security.sql", "0022_staged_mfa_enrollment.sql", "0023_customer_password_change.sql", "0024_tenant_switching.sql", "0025_tenant_ownership.sql",
];

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of migrations) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  const db = { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
  return { pg, db };
}

async function seed(pg: PGlite, suffix: string): Promise<SaasSession> {
  const tenantId = `tenant-${suffix}`;
  const userId = `user-${suffix}`;
  const sessionId = `session-${suffix}`;
  await pg.query(
    "insert into relay_tenants(id,slug,name,billing_email) values ($1,$2,$3,$4)",
    [tenantId, `tenant-${suffix}`, `Tenant ${suffix}`, `${suffix}@example.test`],
  );
  await pg.query(
    "insert into relay_saas_users(id,email,email_normalized,name,password_hash) values ($1,$2,$2,$3,'hash')",
    [userId, `${suffix}@example.test`, `User ${suffix}`],
  );
  await pg.query(
    "insert into relay_tenant_memberships(tenant_id,user_id,role,status) values ($1,$2,'owner','active')",
    [tenantId, userId],
  );
  await pg.query(
    `insert into relay_saas_sessions(id,user_id,tenant_id,token_hash,csrf_hash,expires_at,mfa_verified_at)
     values ($1,$2,$3,$4,$5,now()+interval '1 day',now())`,
    [sessionId, userId, tenantId, `token-${suffix}`, `csrf-${suffix}`],
  );
  return {
    sessionId, userId, tenantId, email: `${suffix}@example.test`, name: `User ${suffix}`,
    tenantName: `Tenant ${suffix}`, tenantStatus: "active", role: "owner", csrfHash: `csrf-${suffix}`,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), mfaVerified: true,
    mfaVerifiedAt: new Date().toISOString(), mfaEnabled: true, legalAcceptanceRequired: false,
  };
}

test("tenant mutation audit records terminal outcomes without raw network identity or secrets", async () => {
  const { pg, db } = await database();
  const session = await seed(pg, "one");
  const previousKey = process.env.RELAY_AUDIT_HASH_KEY;
  const previousTrust = process.env.RELAY_TRUST_PROXY_HEADERS;
  const previousHeader = process.env.RELAY_CLIENT_IP_HEADER;
  process.env.RELAY_AUDIT_HASH_KEY = "audit-hmac-key-for-tests-0123456789abcdef";
  process.env.RELAY_TRUST_PROXY_HEADERS = "1";
  process.env.RELAY_CLIENT_IP_HEADER = "x-real-ip";
  try {
    const request = new Request("https://relay.example.test/api/saas/keys", {
      headers: {
        "x-real-ip": "203.0.113.55",
        "cf-connecting-ip": "198.51.100.99",
        "x-forwarded-for": "203.0.113.55, 10.0.0.2",
        "user-agent": "TenantBrowser/1.0 private-device",
        "x-request-id": "request-12345678",
      },
    });
    const value = await auditedTenantMutation(request, session, {
      action: "api_key.create",
      targetType: "api_key",
      detail: {
        scopes: ["chat"], password: "must-never-appear", note: "sk-1234567890abcdef",
        contact: "private-person@example.test",
        nested: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz", safe: "retained" },
      },
      resultTargetId: (result) => result.id,
    }, async () => ({ id: "key-created", value: 42 }), db);
    assert.equal(value.value, 42);
    const events = await pg.query<Record<string, unknown>>(
      "select * from relay_tenant_audit_events where tenant_id=$1 order by created_at,id",
      [session.tenantId],
    );
    assert.deepEqual(events.rows.map((row) => row.outcome).sort(), ["started", "succeeded"]);
    assert.equal(new Set(events.rows.map((row) => row.operation_id)).size, 1);
    assert.ok(events.rows.every((row) => row.request_id === "request-12345678"));
    assert.ok(events.rows.every((row) => /^[0-9a-f]{64}$/.test(String(row.ip_hmac))));
    assert.ok(events.rows.every((row) => row.ip_hmac === createHmac("sha256", process.env.RELAY_AUDIT_HASH_KEY!).update("203.0.113.55").digest("hex")));
    assert.ok(events.rows.every((row) => /^[0-9a-f]{64}$/.test(String(row.user_agent_hmac))));
    assert.equal(events.rows.find((row) => row.outcome === "succeeded")?.target_id, "key-created");
    const serialized = JSON.stringify(events.rows);
    assert.doesNotMatch(serialized, /203\.0\.113\.55|TenantBrowser|must-never-appear|1234567890abcdef|abcdefghijklmnopqrstuvwxyz|private-person@example\.test/);
    const detail = events.rows[0]?.detail as Record<string, unknown>;
    assert.equal(detail.password, undefined);
    assert.equal(detail.note, "[REDACTED]");
    assert.equal(detail.contact, "[REDACTED]");
    assert.deepEqual(detail.nested, { safe: "retained" });

    await assert.rejects(
      auditedTenantMutation(request, session, {
        action: "member.update", targetType: "tenant_member", targetId: "member-1",
      }, async () => { throw new Error("PAYMENT_DECLINED: private upstream detail"); }, db),
      /PAYMENT_DECLINED/,
    );
    const failure = await pg.query<{ outcome: string; error_code: string }>(
      "select outcome,error_code from relay_tenant_audit_events where action='member.update' order by created_at desc limit 1",
    );
    assert.equal(failure.rows[0]?.outcome, "failed");
    assert.equal(failure.rows[0]?.error_code, "PAYMENT_DECLINED");
  } finally {
    if (previousKey === undefined) delete process.env.RELAY_AUDIT_HASH_KEY;
    else process.env.RELAY_AUDIT_HASH_KEY = previousKey;
    if (previousTrust === undefined) delete process.env.RELAY_TRUST_PROXY_HEADERS;
    else process.env.RELAY_TRUST_PROXY_HEADERS = previousTrust;
    if (previousHeader === undefined) delete process.env.RELAY_CLIENT_IP_HEADER;
    else process.env.RELAY_CLIENT_IP_HEADER = previousHeader;
    await pg.close();
  }
});

test("a terminal audit write failure preserves the business result and leaves a detectable started operation", async () => {
  const { pg, db } = await database();
  const session = await seed(pg, "terminal");
  let auditWrites = 0;
  const terminalFailureDb = {
    query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      if (/insert into relay_tenant_audit_events/i.test(text) && ++auditWrites === 2) throw new Error("simulated terminal write loss");
      return db.query<T>(text, params);
    },
  };
  const previousConsoleError = console.error;
  console.error = () => undefined;
  let result: boolean;
  try {
    result = await auditedTenantMutation(
      new Request("https://relay.example.test/api/saas/keys", { headers: { "user-agent": "test" } }),
      session,
      { action: "api_key.revoke", targetType: "api_key", targetId: "key-1" },
      async () => true,
      terminalFailureDb,
    );
  } finally {
    console.error = previousConsoleError;
  }
  assert.equal(result, true);
  const events = await pg.query<{ outcome: string }>("select outcome from relay_tenant_audit_events where tenant_id=$1", [session.tenantId]);
  assert.deepEqual(events.rows.map((row) => row.outcome), ["started"]);
  await pg.close();
});

test("tenant audit is append-only and list queries cannot cross tenant boundaries", async () => {
  const { pg, db } = await database();
  const first = await seed(pg, "first");
  const second = await seed(pg, "second");
  const request = new Request("https://relay.example.test/api/saas/members", {
    headers: { "x-forwarded-for": "198.51.100.8", "user-agent": "audit-test" },
  });
  await auditedTenantMutation(request, first, { action: "member.update", targetType: "tenant_member", targetId: "a" }, async () => true, db);
  await auditedTenantMutation(request, second, { action: "member.update", targetType: "tenant_member", targetId: "b" }, async () => true, db);
  const listed = await listTenantAuditEvents(first.tenantId, 5000, db);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((row) => row.tenant_id === first.tenantId));
  assert.ok(listed.every((row) => row.target_id === "a"));
  const id = String(listed[0]?.id);
  await assert.rejects(pg.query("update relay_tenant_audit_events set action='changed' where id=$1", [id]), /append-only/);
  await assert.rejects(pg.query("delete from relay_tenant_audit_events where id=$1", [id]), /append-only/);
  await pg.close();
});

test("tenant audit route and all privileged tenant mutation routes keep the audit invariant", async () => {
  const auditRoute = await readFile("src/routes/api/saas/audit.ts", "utf8");
  assert.match(auditRoute, /assertSaasSession\(request, \["owner", "admin"\]\)/);
  assert.match(auditRoute, /listTenantAuditEvents\(auth\.session\.tenantId/);
  for (const path of ["keys.ts", "members.ts", "billing.ts", "session.ts", "privacy.ts", "security.ts", "tenants.ts"]) {
    const source = await readFile(`src/routes/api/saas/${path}`, "utf8");
    assert.match(source, /auditedTenantMutation\(request, auth\.session/);
  }
  const retention = await readFile("src/lib/data-retention.ts", "utf8");
  assert.doesNotMatch(retention, /delete from relay_tenant_audit_events/i);
});
