import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { collectCommercialSignals, persistCommercialSignals } from "./commercial-monitor.ts";
import { retentionPolicy } from "./data-retention.ts";
import { commercialReadiness } from "./commercial-readiness.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of ["0001_relay.sql","0002_relay_ops.sql","0003_relay_production.sql","0004_schema_meta.sql","0005_account_operations.sql","0006_account_availability_samples.sql","0007_commercial_saas.sql","0008_commercial_payments.sql","0009_commercial_config.sql","0010_provider_sandbox.sql","0011_commercial_launch_evidence.sql","0012_admin_sessions.sql","0013_plan_periods.sql","0014_saas_session_mfa.sql","0015_tenant_audit.sql"]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return { pg, db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows } };
}

test("commercial readiness/monitoring signals are durable and resolve", async () => {
  const { pg, db } = await database();
  const signals = await collectCommercialSignals(db);
  assert.ok(signals.some((signal) => signal.code === "WORKER_ZERO"));
  await persistCommercialSignals(signals, db);
  const open = await pg.query<{ count: number }>("select count(*)::int as count from relay_alert_events where status='open'");
  assert.equal(open.rows[0]?.count, signals.length);
  await pg.query("insert into relay_workers(id,name,last_beat,draining) values ('worker','worker',now(),false)");
  const healthy = await collectCommercialSignals(db);
  await persistCommercialSignals(healthy, db);
  const resolved = await pg.query<{ status: string }>("select status from relay_alert_events where code='WORKER_ZERO'");
  assert.equal(resolved.rows[0]?.status, "resolved");
  await pg.close();
});

test("retention policy is bounded and never offers billing-ledger deletion", async () => {
  const policy = retentionPolicy({ RELAY_REQUEST_CONTENT_RETENTION_DAYS: "0", RELAY_AUDIT_RETENTION_DAYS: "99999" } as NodeJS.ProcessEnv);
  assert.equal(policy.requestContentDays, 1);
  assert.equal(policy.auditDays, 2555);
  assert.equal(policy.billingYears, 7);
  const source = await readFile("src/lib/data-retention.ts", "utf8");
  assert.doesNotMatch(source, /delete from relay_billing_(transactions|entries)/i);
  assert.match(source, /Billing transactions\/entries are intentionally never deleted/);
  assert.doesNotMatch(source, /delete from relay_tenant_audit_events/i);
});

test("monitor raises a critical signal for tenant audit operations missing a terminal outcome", async () => {
  const { pg, db } = await database();
  await pg.query("insert into relay_tenants(id,slug,name,billing_email) values ('audit-tenant','audit-tenant','Audit Tenant','audit@example.test')");
  await pg.query("insert into relay_saas_users(id,email,email_normalized,name,password_hash) values ('audit-user','audit@example.test','audit@example.test','Audit User','hash')");
  await pg.query(
    `insert into relay_tenant_audit_events
      (id,tenant_id,actor_user_id,actor_role,session_id,operation_id,action,target_type,outcome,request_id,ip_hmac,user_agent_hmac,created_at)
     values ('audit-event','audit-tenant','audit-user','owner','audit-session','audit-operation','api_key.create','api_key','started','audit-request-1234',$1,$1,now()-interval '10 minutes')`,
    ["a".repeat(64)],
  );
  const signals = await collectCommercialSignals(db);
  const signal = signals.find((item) => item.code === "TENANT_AUDIT_INCOMPLETE");
  assert.equal(signal?.severity, "critical");
  assert.match(signal?.message || "", /1 tenant mutation audit operation/);
  await pg.close();
});

test("commercial readiness fails closed on credentials, prices, replicas, backup and legal review", async () => {
  const { pg, db } = await database();
  const disabled = await commercialReadiness({ RELAY_COMMERCIAL_ENABLED: "0" } as NodeJS.ProcessEnv, db);
  assert.equal(disabled.ready, false);
  assert.equal(disabled.enabled, false);
  const enabled = await commercialReadiness({
    RELAY_COMMERCIAL_ENABLED: "1",
    RELAY_PUBLIC_URL: "https://relay.example.test",
    REDIS_URL: "redis://unused",
    OPENAI_API_KEY: "configured",
    RELAY_GATEWAY_REPLICA_COUNT: "1",
  } as NodeJS.ProcessEnv, db);
  assert.ok(enabled.blockers.some((blocker) => blocker.includes("gateway")));
  assert.ok(enabled.blockers.some((blocker) => blocker.includes("offsite")));
  assert.ok(enabled.blockers.some((blocker) => blocker.includes("legal")));
  assert.ok(enabled.blockers.some((blocker) => blocker.includes("Stripe")));
  assert.ok(enabled.blockers.some((blocker) => blocker.includes("tax mode")));
  assert.ok(enabled.blockers.some((blocker) => blocker.includes("audit HMAC")));
  const unsafeBackup = await commercialReadiness({
    RELAY_COMMERCIAL_ENABLED: "1", RELAY_BACKUP_S3_ENDPOINT: "http://backup.example.test",
    RELAY_BACKUP_S3_BUCKET: "relay-offsite",
  } as NodeJS.ProcessEnv, db);
  assert.equal(unsafeBackup.offsiteBackupConfigured, false);
  const sameBucket = await commercialReadiness({
    RELAY_COMMERCIAL_ENABLED: "1", RELAY_BACKUP_S3_ENDPOINT: "https://media.example.test",
    RELAY_BACKUP_S3_BUCKET: "relay-media", RELAY_S3_ENDPOINT: "https://media.example.test",
    RELAY_S3_BUCKET: "relay-media",
  } as NodeJS.ProcessEnv, db);
  assert.equal(sameBucket.offsiteBackupConfigured, false);
  await pg.close();
});

test("offsite backup includes database/storage/git and mirrors object media", async () => {
  const source = await readFile("scripts/offsite-backup.mjs", "utf8");
  assert.match(source, /backup\.mjs/);
  assert.match(source, /git", \["bundle"/);
  assert.match(source, /--is-shallow-repository/);
  assert.match(source, /refuses a shallow Git repository/);
  assert.match(source, /git", \["clone"/);
  assert.match(source, /restored Git bundle HEAD mismatch/);
  assert.match(source, /run\(mcBin, \["mirror"/);
  assert.match(source, /verifyObjectMediaManifest/);
  assert.match(source, /offsiteManifest\.complete = true/);
  assert.match(source, /offsiteManifestSha256/);
  assert.match(source, /MC_CONFIG_DIR/);
  assert.match(source, /rmSync\(configDir/);
});
