import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createTenantOwner } from "./saas-billing.ts";
import { acceptTenantInvite, inviteTenantMember, listTenantMembers, transferTenantOwnership, updateTenantMemberRole } from "./saas-members.ts";
import type { SaasSession } from "./saas-auth.ts";
import { legalDocumentMetadata } from "./legal-documents.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of ["0001_relay.sql","0002_relay_ops.sql","0003_relay_production.sql","0004_schema_meta.sql","0005_account_operations.sql","0006_account_availability_samples.sql","0007_commercial_saas.sql","0008_commercial_payments.sql","0009_commercial_config.sql","0010_provider_sandbox.sql","0011_commercial_launch_evidence.sql","0012_admin_sessions.sql","0013_plan_periods.sql","0014_saas_session_mfa.sql","0015_tenant_audit.sql","0016_alert_delivery_outbox.sql","0017_email_delivery_outbox.sql","0018_legal_acceptance.sql","0019_legal_reconsent.sql","0020_tenant_privacy_rights.sql","0021_customer_session_security.sql","0022_staged_mfa_enrollment.sql","0023_customer_password_change.sql","0024_tenant_switching.sql","0025_tenant_ownership.sql"]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return { pg, db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows } };
}

test("tenant invitations are hash-only, email-delivered and atomically accepted", async () => {
  const { pg, db } = await database();
  const owner = await createTenantOwner({ tenantName: "Members Co", ownerName: "Owner", email: "owner@members.test", password: "members-password-123" }, db);
  const session = { userId: owner.userId, tenantId: owner.tenantId, email: owner.email, name: "Owner", tenantName: "Members Co", tenantStatus: "active", role: "owner", sessionId: "s", csrfHash: "x", expiresAt: "", mfaVerified: false, mfaVerifiedAt: null, mfaEnabled: false, legalAcceptanceRequired: false } satisfies SaasSession;
  let link = "";
  await inviteTenantMember(session, { email: "developer@members.test", role: "developer" }, {
    db,
    env: {
      RELAY_EMAIL_WEBHOOK_URL: "https://mail.test", RELAY_PUBLIC_URL: "https://relay.test",
      RELAY_EMAIL_WEBHOOK_SECRET: "invite-email-secret-0123456789abcdef",
      RELAY_SECRETS_KEY: "invite-encryption-key-0123456789abcdef",
    } as NodeJS.ProcessEnv,
    fetcher: async (_url, init) => { link = JSON.parse(String(init?.body)).link; return Response.json({ ok: true }); },
  });
  const stored = await pg.query<Record<string, unknown>>("select * from relay_tenant_invites");
  const token = new URL(link).searchParams.get("token") || "";
  assert.ok(token);
  assert.ok(!JSON.stringify(stored.rows).includes(token));
  const acceptEnv = {
    NODE_ENV: "production", RELAY_LEGAL_APPROVED: "1", RELAY_LEGAL_OPERATOR_NAME: "Relay Members Test Ltd.",
    RELAY_LEGAL_CONTACT_EMAIL: "privacy@members.test", RELAY_TERMS_VERSION: "members-terms-v1",
    RELAY_PRIVACY_VERSION: "members-privacy-v1", RELAY_LEGAL_EFFECTIVE_DATE: "2026-08-31",
    RELAY_AUDIT_HASH_KEY: "members-legal-hmac-key-0123456789abcdef",
    RELAY_TRUST_PROXY_HEADERS: "1", RELAY_CLIENT_IP_HEADER: "x-real-ip",
  } as NodeJS.ProcessEnv;
  const legal = legalDocumentMetadata(acceptEnv);
  const acceptRequest = new Request("https://relay.test/api/saas/invite", { headers: { "x-real-ip": "203.0.113.88", "user-agent": "InviteAcceptanceTest" } });
  await assert.rejects(
    () => acceptTenantInvite({ token, name: "Developer", password: "developer-password-123" }, acceptRequest, { db, env: acceptEnv }),
    /LEGAL_ACCEPTANCE_REQUIRED/,
  );
  const accepted = await acceptTenantInvite({
    token, name: "Developer", password: "developer-password-123", legalAccepted: true,
    termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion, legalBundleSha256: legal.bundleSha256,
  }, acceptRequest, { db, env: acceptEnv });
  assert.equal(accepted.tenantId, owner.tenantId);
  const acceptance = await pg.query<Record<string, unknown>>("select * from relay_legal_acceptances");
  assert.equal(acceptance.rows.length, 1);
  assert.equal(acceptance.rows[0]?.acceptance_method, "invite");
  assert.equal(acceptance.rows[0]?.bundle_sha256, legal.bundleSha256);
  const members = await listTenantMembers(owner.tenantId, db);
  assert.equal(members.length, 2);
  assert.ok(members.some((member) => member.role === "developer"));
  assert.equal(members.find((member) => member.id === owner.userId)?.is_designated_owner, true);
  await assert.rejects(() => inviteTenantMember(session, { email: "owner2@members.test", role: "owner" }), /OWNER_TRANSFER_REQUIRED/);
  await assert.rejects(() => updateTenantMemberRole(session, owner.userId, "viewer", "active", db), /LAST_OWNER_REQUIRED/);
  await pg.close();
});

test("designated ownership transfer is atomic, MFA-bound and concurrency-safe", async () => {
  const { pg, db } = await database();
  const owner = await createTenantOwner({ tenantName: "Ownership Co", ownerName: "Owner", email: "owner@ownership.test", password: "ownership-password-123" }, db);
  const session = { userId: owner.userId, tenantId: owner.tenantId, email: owner.email, name: "Owner", tenantName: "Ownership Co", tenantStatus: "active", role: "owner", sessionId: "ownership-session", csrfHash: "x", expiresAt: "", mfaVerified: true, mfaVerifiedAt: new Date().toISOString(), mfaEnabled: true, legalAcceptanceRequired: false } satisfies SaasSession;
  for (const suffix of ["one", "two"]) {
    await pg.query(
      "insert into relay_saas_users(id,email,email_normalized,name,password_hash,status,mfa_enabled) values ($1,$2,$2,$1,'hash','active',true)",
      [`target-${suffix}`, `target-${suffix}@ownership.test`],
    );
    await pg.query(
      "insert into relay_tenant_memberships(tenant_id,user_id,role,status) values ($1,$2,'admin','active')",
      [owner.tenantId, `target-${suffix}`],
    );
  }
  await pg.query("update relay_saas_users set mfa_enabled=false where id='target-one'");
  await assert.rejects(() => transferTenantOwnership(session, "target-one", db), /active with MFA/);
  await pg.query("update relay_saas_users set mfa_enabled=true where id='target-one'");
  const results = await Promise.allSettled([
    transferTenantOwnership(session, "target-one", db),
    transferTenantOwnership(session, "target-two", db),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const ownership = await pg.query<{ user_id: string }>("select user_id from relay_tenant_ownership where tenant_id=$1", [owner.tenantId]);
  const roles = await pg.query<{ user_id: string; role: string }>("select user_id,role from relay_tenant_memberships where tenant_id=$1 order by user_id", [owner.tenantId]);
  assert.equal(roles.rows.filter((row) => row.role === "owner").length, 1);
  assert.equal(roles.rows.find((row) => row.user_id === ownership.rows[0]?.user_id)?.role, "owner");
  assert.equal(roles.rows.find((row) => row.user_id === owner.userId)?.role, "admin");
  await assert.rejects(
    () => pg.query("update relay_tenant_memberships set role='viewer' where tenant_id=$1 and user_id=$2", [owner.tenantId, ownership.rows[0]?.user_id]),
    /designated owner/,
  );
  const nonOwner = roles.rows.find((row) => row.role !== "owner")!.user_id;
  await assert.rejects(
    () => pg.query("update relay_tenant_memberships set role='owner' where tenant_id=$1 and user_id=$2", [owner.tenantId, nonOwner]),
    /atomic transfer/,
  );
  await pg.close();
});

test("ownership transfer route always requires the designated owner's MFA", async () => {
  const source = await readFile("src/routes/api/saas/members.ts", "utf8");
  assert.match(source, /action === "transfer-ownership"[\s\S]*assertSaasSession\(request, \["owner"\], \{ requireCsrf: true, forceMfa: true \}\)/);
  assert.match(source, /auditedTenantMutation\(request, transferAuth\.session/);
  assert.match(source, /transferTenantOwnership\(transferAuth\.session/);
});

test("tenant invitation rolls back its business row when the Outbox insert fails", async () => {
  const { pg, db } = await database();
  const owner = await createTenantOwner({ tenantName: "Atomic Invite Co", ownerName: "Owner", email: "owner@atomic-invite.test", password: "members-password-123" }, db);
  const session = { userId: owner.userId, tenantId: owner.tenantId, email: owner.email, name: "Owner", tenantName: "Atomic Invite Co", tenantStatus: "active", role: "owner", sessionId: "s", csrfHash: "x", expiresAt: "", mfaVerified: false, mfaVerifiedAt: null, mfaEnabled: false, legalAcceptanceRequired: false } satisfies SaasSession;
  await pg.exec("alter table relay_email_deliveries add constraint test_reject_invite_email check (kind <> 'tenant-invite')");
  let networkCalls = 0;
  await assert.rejects(
    () => inviteTenantMember(session, { email: "developer@atomic-invite.test", role: "developer" }, {
      db,
      env: {
        RELAY_EMAIL_WEBHOOK_URL: "https://mail.test", RELAY_PUBLIC_URL: "https://relay.test",
        RELAY_EMAIL_WEBHOOK_SECRET: "atomic-invite-email-secret-0123456789",
        RELAY_SECRETS_KEY: "atomic-invite-encryption-key-0123456789",
      } as NodeJS.ProcessEnv,
      fetcher: (async () => { networkCalls += 1; return Response.json({ ok: true }); }) as typeof fetch,
    }),
    /test_reject_invite_email|constraint/i,
  );
  const counts = await pg.query<{ invites: number; deliveries: number }>(
    "select (select count(*)::int from relay_tenant_invites) as invites,(select count(*)::int from relay_email_deliveries) as deliveries",
  );
  assert.deepEqual(counts.rows[0], { invites: 0, deliveries: 0 });
  assert.equal(networkCalls, 0);
  await pg.close();
});
