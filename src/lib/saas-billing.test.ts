import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  calculateChargeMinor,
  createTenantOwner,
  getTenant,
  postBalanceAdjustment,
  publishPrice,
  reserveUsage,
  settleUsage,
  checkpointUsageProviderResult,
  decodeUsageProviderResult,
} from "./saas-billing.ts";
import { hashSaasPassword, totpCode, verifySaasPassword, verifyTotp } from "./saas-crypto.ts";

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of [
    "0001_relay.sql",
    "0002_relay_ops.sql",
    "0003_relay_production.sql",
    "0004_schema_meta.sql",
    "0005_account_operations.sql",
    "0006_account_availability_samples.sql",
    "0007_commercial_saas.sql", "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql",
  ]) {
    await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  return {
    pg,
    db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows },
  };
}

test("SaaS passwords and TOTP are bounded and verifiable", () => {
  const hash = hashSaasPassword("commercial-password-123");
  assert.equal(verifySaasPassword("commercial-password-123", hash), true);
  assert.equal(verifySaasPassword("wrong-password", hash), false);
  const secret = "JBSWY3DPEHPK3PXP";
  const at = Date.parse("2026-08-29T00:00:00Z");
  const code = totpCode(secret, at);
  assert.equal(verifyTotp(secret, code, at), true);
  assert.equal(verifyTotp(secret, "000000", at), code === "000000");
});

test("tenant signup, append-only double-entry credit and replay are atomic", async () => {
  const { pg, db } = await database();
  const created = await createTenantOwner(
    { tenantName: "Acme Studio", ownerName: "Owner", email: "owner@acme.test", password: "commercial-password-123" },
    db,
  );
  const credited = await postBalanceAdjustment(
    { tenantId: created.tenantId, deltaMinor: 1000, kind: "recharge", idempotencyKey: "recharge-1" },
    db,
  );
  assert.equal(credited.replay, false);
  const replay = await postBalanceAdjustment(
    { tenantId: created.tenantId, deltaMinor: 1000, kind: "recharge", idempotencyKey: "recharge-1" },
    db,
  );
  assert.equal(replay.replay, true);
  assert.equal((await getTenant(created.tenantId, db))?.balanceMinor, 1000);
  const sums = await pg.query<{ total: number }>(
    "select sum(amount_minor)::int as total from relay_billing_entries where tenant_id=$1",
    [created.tenantId],
  );
  assert.equal(sums.rows[0]?.total, 0);
  await assert.rejects(
    () => pg.query("update relay_billing_entries set amount_minor=1 where tenant_id=$1", [created.tenantId]),
    /append-only/,
  );
  await pg.close();
});

test("price reservation and settlement charge once and release the hold", async () => {
  const { pg, db } = await database();
  const created = await createTenantOwner(
    { tenantName: "Image Co", ownerName: "Owner", email: "owner@image.test", password: "commercial-password-456" },
    db,
  );
  await postBalanceAdjustment(
    { tenantId: created.tenantId, deltaMinor: 500, kind: "recharge", idempotencyKey: "fund" },
    db,
  );
  await pg.query(
    `insert into relay_tenant_api_keys
      (id,tenant_id,name,key_hash,key_prefix,key_hint,created_by)
     values ('key-1',$1,'default','hash','sk-saas-test','sk-saas-test…abcd',$2)`,
    [created.tenantId, created.userId],
  );
  await pg.query(
    `insert into relay_price_book
      (id,version,provider,model,capability,currency,input_micros_per_million,output_micros_per_million,image_price_minor,markup_basis_points,effective_from,status)
     values ('price-1',1,'openai','gpt-5-mini','chat','USD',1000000,2000000,0,1000,now()-interval '1 minute','active')`,
  );
  const reservation = await reserveUsage(
    {
      tenantId: created.tenantId,
      apiKeyId: "key-1",
      requestId: "request-1",
      provider: "openai",
      model: "gpt-5-mini",
      capability: "chat",
      estimatedPromptTokens: 1000,
      estimatedCompletionTokens: 4096,
    },
    db,
  );
  assert.ok(reservation.reservedMinor > 0);
  assert.equal((await getTenant(created.tenantId, db))?.reservedMinor, reservation.reservedMinor);
  const settled = await settleUsage(reservation.chargeId, { promptTokens: 1000, completionTokens: 500 }, db);
  assert.equal(settled.replay, false);
  const replay = await settleUsage(reservation.chargeId, { promptTokens: 1000, completionTokens: 500 }, db);
  assert.equal(replay.replay, true);
  const tenant = await getTenant(created.tenantId, db);
  assert.equal(tenant?.reservedMinor, 0);
  assert.equal(tenant?.balanceMinor, 500 - settled.chargedMinor);
  const entries = await pg.query<{ transaction_id: string; total: number }>(
    `select transaction_id,sum(amount_minor)::int as total from relay_billing_entries
      where tenant_id=$1 group by transaction_id order by transaction_id`,
    [created.tenantId],
  );
  assert.ok(entries.rows.every((row) => row.total === 0));
  await pg.close();
});

test("commercial price math uses integer minor units and markup", () => {
  assert.equal(
    calculateChargeMinor(
      {
        id: "p",
        version: 1,
        provider: "openai",
        model: "m",
        capability: "chat",
        currency: "USD",
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 2_000_000,
        imagePriceMinor: 0,
        markupBasisPoints: 1000,
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveTo: null,
        status: "active",
      },
      { promptTokens: 1_000_000, completionTokens: 500_000 },
    ),
    220,
  );
});

test("price publishing accepts Vertex as an official provider and rejects arbitrary providers", async () => {
  const { pg, db } = await database();
  const price = await publishPrice({ provider: "vertex", model: "gemini-3.7-flash", capability: "chat", currency: "USD", inputMicrosPerMillion: 1000, outputMicrosPerMillion: 2000 }, db);
  assert.equal(price.provider, "vertex");
  await assert.rejects(
    () => publishPrice({ provider: "custom-http", model: "anything", capability: "chat", currency: "USD" }, db),
    /OFFICIAL_PROVIDER_OR_MODEL_INVALID/,
  );
  await pg.close();
});

test("concurrent reservation replay does not double-hold tenant balance", async () => {
  const { pg, db } = await database();
  const created = await createTenantOwner(
    { tenantName: "Concurrent Co", ownerName: "Owner", email: "owner@concurrent.test", password: "commercial-password-789" },
    db,
  );
  await postBalanceAdjustment({ tenantId: created.tenantId, deltaMinor: 500, kind: "recharge", idempotencyKey: "fund" }, db);
  await pg.query(
    `insert into relay_tenant_api_keys(id,tenant_id,name,key_hash,key_prefix,key_hint,created_by)
     values ('key-c',$1,'default','hash-c','sk-saas-c','sk-saas-c…test',$2)`,
    [created.tenantId, created.userId],
  );
  await pg.query(
    `insert into relay_price_book
      (id,version,provider,model,capability,currency,input_micros_per_million,output_micros_per_million,markup_basis_points,effective_from,status)
     values ('price-c',1,'openai','gpt-5-mini','chat','USD',1000000,2000000,0,now()-interval '1 minute','active')`,
  );
  const input = {
    tenantId: created.tenantId,
    apiKeyId: "key-c",
    requestId: "same-request",
    provider: "openai",
    model: "gpt-5-mini",
    capability: "chat" as const,
    estimatedPromptTokens: 1000,
    estimatedCompletionTokens: 1000,
  };
  const [first, second] = await Promise.all([reserveUsage(input, db), reserveUsage(input, db)]);
  assert.equal(first.chargeId, second.chargeId);
  const tenant = await getTenant(created.tenantId, db);
  assert.equal(tenant?.reservedMinor, first.reservedMinor);
  const charges = await pg.query<{ count: number }>("select count(*)::int as count from relay_usage_charges where tenant_id=$1", [created.tenantId]);
  assert.equal(charges.rows[0]?.count, 1);
  await pg.close();
});

test("provider success checkpoint makes idempotent settlement recoverable without resubmission", async () => {
  const { pg, db } = await database();
  const created = await createTenantOwner(
    { tenantName: "Recovery Co", ownerName: "Owner", email: "owner@recovery.test", password: "commercial-password-recovery" }, db,
  );
  await postBalanceAdjustment({ tenantId: created.tenantId, deltaMinor: 500, kind: "recharge", idempotencyKey: "fund" }, db);
  await pg.query(`insert into relay_tenant_api_keys(id,tenant_id,name,key_hash,key_prefix,key_hint,created_by) values ('key-r',$1,'default','hash-r','sk-saas-r','sk-saas-r…test',$2)`, [created.tenantId, created.userId]);
  await pg.query(`insert into relay_price_book(id,version,provider,model,capability,currency,input_micros_per_million,output_micros_per_million,effective_from,status) values ('price-r',1,'openai','gpt-5-mini','chat','USD',1000000,2000000,now()-interval '1 minute','active')`);
  const input = { tenantId: created.tenantId, apiKeyId: "key-r", requestId: "recover-request", provider: "openai", model: "gpt-5-mini", capability: "chat" as const, estimatedPromptTokens: 1000, estimatedCompletionTokens: 1000 };
  const reserved = await reserveUsage(input, db);
  await checkpointUsageProviderResult(reserved.chargeId, { kind: "chat", id: "provider-1", text: "completed", promptTokens: 1000, completionTokens: 500 }, db);
  await settleUsage(reserved.chargeId, { promptTokens: 1000, completionTokens: 500 }, db);
  const replay = await reserveUsage(input, db);
  assert.equal(replay.replay, true);
  assert.equal(replay.status, "settled");
  assert.equal(decodeUsageProviderResult(replay.providerResultCiphertext)?.text, "completed");
  const charges = await pg.query<{ count: number }>("select count(*)::int as count from relay_usage_charges where request_id='recover-request'");
  assert.equal(charges.rows[0]?.count, 1);
  await pg.close();
});

test("expired billing periods roll forward and plan monthly budget is tenant-wide", async () => {
  const { pg, db } = await database();
  const created = await createTenantOwner(
    { tenantName: "Period Co", ownerName: "Owner", email: "owner@period.test", password: "commercial-password-period" }, db,
  );
  await postBalanceAdjustment({ tenantId: created.tenantId, deltaMinor: 100, kind: "recharge", idempotencyKey: "period-fund" }, db);
  await pg.query(`update relay_plans set limits=jsonb_set(limits,'{monthlySpendMinor}','20'::jsonb) where id='starter'`);
  await pg.query(`update relay_tenants set current_period_start=now()-interval '2 months',current_period_end=now()-interval '1 month' where id=$1`, [created.tenantId]);
  await pg.query(`insert into relay_tenant_api_keys(id,tenant_id,name,key_hash,key_prefix,key_hint,created_by) values ('key-period',$1,'default','hash-period','sk-period','sk-period…test',$2)`, [created.tenantId, created.userId]);
  await pg.query(`insert into relay_price_book(id,version,provider,model,capability,currency,image_price_minor,effective_from,status) values ('price-period',1,'openai','gpt-image-period','image','USD',10,now()-interval '1 minute','active')`);
  await pg.query(`insert into relay_usage_charges(id,tenant_id,api_key_id,request_id,provider,model,capability,reserved_minor,charged_minor,status,created_at) values ('old-period',$1,'key-period','old-period-request','openai','gpt-image-period','image',0,100,'settled',now()-interval '40 days')`, [created.tenantId]);
  const first = await reserveUsage({ tenantId: created.tenantId, apiKeyId: "key-period", requestId: "period-1", provider: "openai", model: "gpt-image-period", capability: "image", images: 1 }, db);
  assert.equal(first.reservedMinor, 10);
  const period = await pg.query<{ current: boolean }>("select current_period_start=date_trunc('month',now()) as current from relay_tenants where id=$1", [created.tenantId]);
  assert.equal(period.rows[0]?.current, true);
  await assert.rejects(
    () => reserveUsage({ tenantId: created.tenantId, apiKeyId: "key-period", requestId: "period-2", provider: "openai", model: "gpt-image-period", capability: "image", images: 2 }, db),
    /INSUFFICIENT_BALANCE_OR_BUDGET/,
  );
  await pg.close();
});
