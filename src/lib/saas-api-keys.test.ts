import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createTenantOwner } from "./saas-billing.ts";
import {
  createTenantApiKey,
  enforceCommercialKeyLimits,
  findTenantApiKey,
  listTenantApiKeys,
  revokeTenantApiKey,
  rotateTenantApiKey,
} from "./saas-api-keys.ts";
import { legalDocumentMetadata } from "./legal-documents.ts";

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql", "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql", "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql", "0017_email_delivery_outbox.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql", "0020_tenant_privacy_rights.sql", "0021_customer_session_security.sql", "0022_staged_mfa_enrollment.sql", "0023_customer_password_change.sql", "0024_tenant_switching.sql", "0025_tenant_ownership.sql", "0026_tenant_invitation_lifecycle.sql", "0027_tenant_api_key_rotation.sql",
  ]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return {
    pg,
    db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows },
  };
}

test("commercial API keys are hash-only, tenant-scoped and revocable", async () => {
  const { pg, db } = await database();
  const owner = await createTenantOwner(
    { tenantName: "Tenant Key Co", ownerName: "Owner", email: "key-owner@example.test", password: "commercial-password-123" },
    db,
  );
  const created = await createTenantApiKey(
    { tenantId: owner.tenantId, createdBy: owner.userId, name: "Production", scopes: ["chat"], modelAllowlist: ["gpt-5-mini"], requestsPerMinute: 2, monthlySpendLimitMinor: 10 },
    db,
  );
  assert.match(created.token, /^sk-saas-/);
  const stored = await pg.query<{ key_hash: string; key_hint: string }>("select key_hash,key_hint from relay_tenant_api_keys where id=$1", [created.id]);
  assert.notEqual(stored.rows[0]?.key_hash, created.token);
  assert.ok(!JSON.stringify(stored.rows[0]).includes(created.token));
  const found = await findTenantApiKey(created.token, db);
  assert.equal(found?.tenantId, owner.tenantId);
  assert.deepEqual(found?.scopes, ["chat"]);
  assert.deepEqual(found?.modelAllowlist, ["gpt-5-mini"]);
  assert.equal((await enforceCommercialKeyLimits(found!, "chat", "gpt-5-mini", new Date(), db)).ok, true);
  const denied = await enforceCommercialKeyLimits(found!, "image", "gpt-image-1", new Date(), db);
  assert.equal(denied.ok, false);
  await pg.query(
    `insert into relay_usage_charges
      (id,tenant_id,api_key_id,request_id,provider,model,capability,reserved_minor,charged_minor,status,created_at)
     values ('charge-limit',$1,$2,'request-limit','openai','gpt-5-mini','chat',0,10,'settled',now())`,
    [owner.tenantId, created.id],
  );
  const spent = await enforceCommercialKeyLimits(found!, "chat", "gpt-5-mini", new Date(), db);
  assert.equal(spent.ok, false);
  if (!spent.ok) assert.equal(spent.error, "MONTHLY_SPEND_LIMIT_REACHED");
  assert.equal(await revokeTenantApiKey(owner.tenantId, created.id, db), true);
  assert.equal(await findTenantApiKey(created.token, db), null);
  await pg.close();
});

test("tenant API-key rotation has bounded overlap, one concurrent winner and no secret listing", async () => {
  const { pg, db } = await database();
  const owner = await createTenantOwner(
    { tenantName: "Key Rotation Co", ownerName: "Owner", email: "rotation-owner@example.test", password: "rotation-password-123" },
    db,
  );
  await assert.rejects(
    () => createTenantApiKey({ tenantId: owner.tenantId, createdBy: owner.userId, name: "Expired", expiresAt: new Date(Date.now() - 60_000).toISOString() }, db),
    /API_KEY_EXPIRY_INVALID/,
  );
  await assert.rejects(
    () => createTenantApiKey({ tenantId: owner.tenantId, createdBy: owner.userId, name: "Unbounded", concurrencyLimit: 10_001 }, db),
    /API_KEY_CONCURRENCY_INVALID/,
  );
  await assert.rejects(
    () => createTenantApiKey({ tenantId: owner.tenantId, createdBy: owner.userId, name: "Not a number", requestsPerMinute: Number.NaN }, db),
    /API_KEY_RPM_INVALID/,
  );
  const created = await createTenantApiKey({ tenantId: owner.tenantId, createdBy: owner.userId, name: "Rotating", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, db);
  const first = await rotateTenantApiKey(owner.tenantId, created.id, 300, db);
  assert.notEqual(first.token, created.token);
  assert.equal((await findTenantApiKey(created.token, db))?.id, created.id);
  assert.equal((await findTenantApiKey(first.token, db))?.id, created.id);
  await assert.rejects(() => rotateTenantApiKey(owner.tenantId, created.id, 300, db), /API_KEY_ROTATION_COOLDOWN/);
  await assert.rejects(() => rotateTenantApiKey(owner.tenantId, created.id, 0, db), /API_KEY_ROTATION_GRACE_INVALID/);

  const listed = (await listTenantApiKeys(owner.tenantId, db))[0]!;
  assert.equal(Number(listed.rotation_count), 1);
  assert.ok(listed.previous_key_expires_at);
  assert.equal("key_hash" in listed, false);
  assert.equal("previous_key_hash" in listed, false);
  assert.ok(!JSON.stringify(listed).includes(first.token));

  await pg.query("update relay_tenant_api_keys set rotated_at=now()-interval '2 minutes' where id=$1", [created.id]);
  const concurrent = await Promise.allSettled([
    rotateTenantApiKey(owner.tenantId, created.id, 300, db),
    rotateTenantApiKey(owner.tenantId, created.id, 300, db),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  const winner = concurrent.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof rotateTenantApiKey>>> => result.status === "fulfilled")!.value;
  assert.equal(await findTenantApiKey(created.token, db), null);
  assert.equal((await findTenantApiKey(first.token, db))?.id, created.id);
  assert.equal((await findTenantApiKey(winner.token, db))?.id, created.id);
  await pg.query("update relay_tenant_api_keys set previous_key_expires_at=now()-interval '1 second' where id=$1", [created.id]);
  assert.equal(await findTenantApiKey(first.token, db), null);
  assert.equal(await revokeTenantApiKey(owner.tenantId, created.id, db), true);
  assert.equal(await findTenantApiKey(winner.token, db), null);
  const revoked = await pg.query<{ previous_key_hash: string | null; previous_key_expires_at: string | null }>(
    "select previous_key_hash,previous_key_expires_at from relay_tenant_api_keys where id=$1",
    [created.id],
  );
  assert.deepEqual(revoked.rows[0], { previous_key_hash: null, previous_key_expires_at: null });

  const shortExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
  const short = await createTenantApiKey({ tenantId: owner.tenantId, createdBy: owner.userId, name: "Short", expiresAt: shortExpiry }, db);
  const shortRotation = await rotateTenantApiKey(owner.tenantId, short.id, 24 * 60 * 60, db);
  assert.ok(Date.parse(shortRotation.previousValidUntil) <= Date.parse(shortExpiry));
  await pg.query("update relay_tenant_api_keys set expires_at=now()-interval '1 second',rotated_at=now()-interval '2 minutes' where id=$1", [short.id]);
  await assert.rejects(() => rotateTenantApiKey(owner.tenantId, short.id, 300, db), /API_KEY_NOT_ROTATABLE/);

  const route = await readFile("src/routes/api/saas/keys.ts", "utf8");
  assert.match(route, /api_key\.rotate/);
  assert.match(route, /forceMfa: true/);
  assert.match(route, /API_KEY_ROTATION_COOLDOWN[\s\S]*429/);
  assert.match(route, /"Retry-After": "60"/);
  await pg.close();
});

test("plan features, model catalog and plan limits constrain every tenant key", async () => {
  const { pg, db } = await database();
  const owner = await createTenantOwner(
    { tenantName: "Plan Guard Co", ownerName: "Owner", email: "plan-owner@example.test", password: "commercial-password-plan" },
    db,
  );
  await pg.query(
    `update relay_plans set limits='{"requestsPerMinute":3,"concurrency":2,"dailyRequestLimit":5,"monthlySpendMinor":25}'::jsonb,
       features='{"chat":true,"image":false,"models":["openai:gpt-plan"]}'::jsonb where id='starter'`,
  );
  const created = await createTenantApiKey(
    { tenantId: owner.tenantId, createdBy: owner.userId, name: "Plan inherited", scopes: ["chat", "image"] },
    db,
  );
  const found = await findTenantApiKey(created.token, db);
  assert.deepEqual(found?.scopes, ["chat"]);
  assert.deepEqual(found?.modelAllowlist, ["openai:gpt-plan"]);
  assert.equal(found?.requestsPerMinute, 3);
  assert.equal(found?.concurrencyLimit, 2);
  assert.equal(found?.dailyRequestLimit, 5);
  assert.equal(found?.monthlySpendLimitMinor, 25);
  const image = await enforceCommercialKeyLimits(found!, "image", "openai:gpt-plan", new Date(), db);
  assert.equal(image.ok, false);
  const wrongModel = await enforceCommercialKeyLimits(found!, "chat", "openai:gpt-other", new Date(), db);
  assert.equal(wrongModel.ok, false);
  const disjoint = await createTenantApiKey(
    { tenantId: owner.tenantId, createdBy: owner.userId, name: "Disjoint", scopes: ["chat"], modelAllowlist: ["openai:gpt-other"] },
    db,
  );
  const disjointFound = await findTenantApiKey(disjoint.token, db);
  assert.equal(disjointFound?.modelAccessDenied, true);
  const disjointDenied = await enforceCommercialKeyLimits(disjointFound!, "chat", "openai:gpt-plan", new Date(), db);
  assert.equal(disjointDenied.ok, false);
  await pg.query(
    `insert into relay_usage_charges
      (id,tenant_id,api_key_id,request_id,provider,model,capability,reserved_minor,charged_minor,status,created_at)
     values ('plan-spend',$1,$2,'plan-request','openai','gpt-plan','chat',0,25,'settled',now())`,
    [owner.tenantId, created.id],
  );
  const spent = await enforceCommercialKeyLimits(found!, "chat", "openai:gpt-plan", new Date(), db);
  assert.equal(spent.ok, false);
  if (!spent.ok) assert.equal(spent.error, "MONTHLY_SPEND_LIMIT_REACHED");
  await pg.close();
});

test("paid tenant API keys fail closed until an active owner/admin accepts the current legal bundle", async () => {
  const { pg, db } = await database();
  const owner = await createTenantOwner(
    { tenantName: "Legal Key Co", ownerName: "Owner", email: "legal-key@example.test", password: "commercial-password-legal" }, db,
  );
  const created = await createTenantApiKey({ tenantId: owner.tenantId, createdBy: owner.userId, name: "Legal gated" }, db);
  const env = {
    NODE_ENV: "production", RELAY_COMMERCIAL_ENABLED: "1", RELAY_REQUIRE_LEGAL_ACCEPTANCE: "1",
    RELAY_LEGAL_APPROVED: "1", RELAY_LEGAL_OPERATOR_NAME: "Legal Key Test Ltd.",
    RELAY_LEGAL_CONTACT_EMAIL: "privacy@legal-key.test", RELAY_TERMS_VERSION: "legal-key-terms-v1",
    RELAY_PRIVACY_VERSION: "legal-key-privacy-v1", RELAY_LEGAL_EFFECTIVE_DATE: "2026-08-31",
  } as NodeJS.ProcessEnv;
  const ready = async () => true;
  assert.equal(await findTenantApiKey(created.token, db, { env, commercialReady: ready }), null);
  const metadata = legalDocumentMetadata(env);
  const digest = "c".repeat(64);
  await pg.query(
    `insert into relay_legal_acceptances
      (id,user_id,tenant_id,terms_version,privacy_version,bundle_sha256,ip_hmac,user_agent_hmac,acceptance_method)
     values ('legal-key-acceptance',$1,$2,$3,$4,$5,$6,$6,'reconsent')`,
    [owner.userId, owner.tenantId, metadata.termsVersion, metadata.privacyVersion, metadata.bundleSha256, digest],
  );
  assert.equal((await findTenantApiKey(created.token, db, { env, commercialReady: ready }))?.tenantId, owner.tenantId);
  assert.equal(await findTenantApiKey(created.token, db, { env: { ...env, RELAY_TERMS_VERSION: "legal-key-terms-v2" }, commercialReady: ready }), null);
  await pg.close();
});
