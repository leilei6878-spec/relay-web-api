import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createTenantOwner } from "./saas-billing.ts";
import {
  createTenantApiKey,
  enforceCommercialKeyLimits,
  findTenantApiKey,
  revokeTenantApiKey,
} from "./saas-api-keys.ts";

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql", "0008_commercial_payments.sql", "0009_commercial_config.sql",
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
