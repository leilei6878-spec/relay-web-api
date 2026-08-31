import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { tickPlanRenewals } from "./plan-renewal-scheduler.ts";
import { createTenantOwner, getTenant } from "./saas-billing.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql",
    "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql",
    "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql", "0017_email_delivery_outbox.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql", "0020_tenant_privacy_rights.sql", "0021_customer_session_security.sql", "0022_staged_mfa_enrollment.sql", "0023_customer_password_change.sql", "0024_tenant_switching.sql", "0025_tenant_ownership.sql",
  ]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return { pg, db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows } };
}

test("plan renewal scheduler settles due free periods and records paid-period failures without granting credit", async () => {
  const { pg, db } = await database();
  const free = await createTenantOwner({ tenantName: "Scheduler Free", ownerName: "Owner", email: "scheduler-free@example.test", password: "commercial-password-scheduler-free" }, db);
  const paid = await createTenantOwner({ tenantName: "Scheduler Paid", ownerName: "Owner", email: "scheduler-paid@example.test", password: "commercial-password-scheduler-paid" }, db);
  await pg.query("update relay_plans set included_credit_minor=25 where id='starter'");
  await pg.query("update relay_plans set monthly_fee_minor=500,included_credit_minor=200 where id='growth'");
  await pg.query("update relay_tenants set plan_id='growth' where id=$1", [paid.tenantId]);
  const results = await tickPlanRenewals(db);
  assert.equal(results.find((item) => item.tenantId === free.tenantId)?.ok, true);
  assert.equal(results.find((item) => item.tenantId === paid.tenantId)?.ok, false);
  assert.match(results.find((item) => item.tenantId === paid.tenantId)?.error || "", /PLAN_RENEWAL_PAYMENT_REQUIRED/);
  assert.equal((await getTenant(free.tenantId, db))?.includedBalanceMinor, 25);
  assert.equal((await getTenant(paid.tenantId, db))?.includedBalanceMinor, 0);
  const periods = await pg.query<{ tenant_id: string }>("select tenant_id from relay_plan_periods order by tenant_id");
  assert.deepEqual(periods.rows.map((row) => row.tenant_id), [free.tenantId]);
  const audit = await pg.query<{ detail: Record<string, unknown> }>("select detail from relay_commercial_audit where action='plan.period.failed' and tenant_id=$1", [paid.tenantId]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]?.detail.code, "PLAN_RENEWAL_PAYMENT_REQUIRED");
  await pg.close();
});
