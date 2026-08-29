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
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql",
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
    { tenantId: owner.tenantId, createdBy: owner.userId, name: "Production", scopes: ["chat"], modelAllowlist: ["gpt-5-mini"], requestsPerMinute: 2 },
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
  assert.equal((await enforceCommercialKeyLimits(found!, "chat", "gpt-5-mini")).ok, true);
  const denied = await enforceCommercialKeyLimits(found!, "image", "gpt-image-1");
  assert.equal(denied.ok, false);
  assert.equal(await revokeTenantApiKey(owner.tenantId, created.id, db), true);
  assert.equal(await findTenantApiKey(created.token, db), null);
  await pg.close();
});
