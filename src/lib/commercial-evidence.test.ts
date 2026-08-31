import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  commercialEvidenceStatus,
  expectedCommercialEvidence,
  listCommercialEvidence,
  recordCommercialEvidence,
  type CommercialEvidenceExpectation,
} from "./commercial-evidence.ts";
import { commercialReadiness } from "./commercial-readiness.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql",
    "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql",
    "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql", "0017_email_delivery_outbox.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql", "0020_tenant_privacy_rights.sql", "0021_customer_session_security.sql", "0022_staged_mfa_enrollment.sql", "0023_customer_password_change.sql", "0024_tenant_switching.sql", "0025_tenant_ownership.sql", "0026_tenant_invitation_lifecycle.sql",
  ]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return { pg, db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows } };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function pass(item: CommercialEvidenceExpectation, db: Parameters<typeof recordCommercialEvidence>[1]) {
  return recordCommercialEvidence({
    requirement: item.requirement,
    subject: item.subject,
    status: "passed",
    artifactRef: `EVIDENCE-${hash(`${item.requirement}:${item.subject}`).slice(0, 16)}`,
    artifactSha256: hash(`artifact:${item.requirement}:${item.subject}`),
    note: "Independent review completed",
    reviewer: "reviewer@example.test",
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    confirmation: "EVIDENCE_REVIEWED",
    actor: "admin",
  }, db);
}

test("commercial evidence expectations include global, active-provider and exact price-version requirements", async () => {
  const { pg, db } = await database();
  await pg.query(
    `insert into relay_price_book(id,version,provider,model,capability,currency,effective_from,status)
     values ('price-evidence',3,'openai','gpt-evidence','chat','USD',now()-interval '1 minute','active')`,
  );
  const expected = await expectedCommercialEvidence({ RELAY_SAAS_REGISTRATION_ENABLED: "0" } as NodeJS.ProcessEnv, db);
  assert.ok(expected.some((item) => item.requirement === "legal_documents" && item.subject === "global"));
  assert.ok(!expected.some((item) => item.requirement === "email_delivery"));
  assert.ok(expected.some((item) => item.requirement === "provider_rights" && item.subject === "openai"));
  assert.ok(expected.some((item) => item.requirement === "price_review" && item.subject === "price-evidence"));
  const planSubjects = expected.filter((item) => item.requirement === "plan_review").map((item) => item.subject);
  assert.equal(planSubjects.length, 2);
  await pg.query("update relay_plans set monthly_fee_minor=123 where id='starter'");
  const changedPlans = await expectedCommercialEvidence({ RELAY_SAAS_REGISTRATION_ENABLED: "0" } as NodeJS.ProcessEnv, db);
  const changedStarter = changedPlans.find((item) => item.requirement === "plan_review" && item.subject.startsWith("starter:"))?.subject;
  assert.ok(changedStarter);
  assert.ok(!planSubjects.includes(changedStarter));
  const registration = await expectedCommercialEvidence({ RELAY_SAAS_REGISTRATION_ENABLED: "1" } as NodeJS.ProcessEnv, db);
  assert.ok(registration.some((item) => item.requirement === "email_delivery"));
  await pg.close();
});

test("commercial evidence rejects missing confirmation, self-review, secrets, bad hashes and excessive validity", async () => {
  const { pg, db } = await database();
  const base = {
    requirement: "legal_documents" as const, subject: "global", status: "passed" as const,
    artifactRef: "LEGAL-2026-001", artifactSha256: hash("legal"), note: "Legal review completed",
    reviewer: "reviewer@example.test", observedAt: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(), confirmation: "EVIDENCE_REVIEWED", actor: "admin",
  };
  await assert.rejects(() => recordCommercialEvidence({ ...base, confirmation: "wrong" }, db), /CONFIRMATION_REQUIRED/);
  await assert.rejects(() => recordCommercialEvidence({ ...base, reviewer: "ADMIN" }, db), /INDEPENDENT_REVIEWER_REQUIRED/);
  await assert.rejects(() => recordCommercialEvidence({ ...base, artifactSha256: "bad" }, db), /SHA256_REQUIRED/);
  await assert.rejects(() => recordCommercialEvidence({ ...base, note: "password=do-not-store" }, db), /NOTE_INVALID/);
  await assert.rejects(() => recordCommercialEvidence({ ...base, artifactRef: "sk-proj-do-not-store-this-secret" }, db), /ARTIFACT_REF_INVALID/);
  await assert.rejects(() => recordCommercialEvidence({ ...base, validUntil: new Date(Date.now() + 366 * 86_400_000).toISOString() }, db), /VALIDITY_TOO_LONG/);
  assert.equal((await listCommercialEvidence(db)).length, 0);
  await pg.close();
});

test("commercial evidence is append-only, independently reviewed, expiring and revocable by a new version", async () => {
  const { pg, db } = await database();
  const expectation = (await expectedCommercialEvidence({} as NodeJS.ProcessEnv, db)).find((item) => item.requirement === "legal_documents")!;
  const first = await pass(expectation, db);
  assert.equal(first.version, 1);
  let state = (await commercialEvidenceStatus({} as NodeJS.ProcessEnv, db)).find((item) => item.requirement === "legal_documents")!;
  assert.equal(state.valid, true);
  assert.equal(state.reason, "passed");
  await assert.rejects(() => pg.query("update relay_commercial_launch_evidence set note='changed'"), /append-only/);
  await assert.rejects(() => pg.query("delete from relay_commercial_launch_evidence"), /append-only/);
  const revoked = await recordCommercialEvidence({
    requirement: "legal_documents", subject: "global", status: "revoked", artifactRef: "LEGAL-REVOCATION-001",
    artifactSha256: hash("revocation"), note: "Approval was withdrawn", reviewer: "counsel@example.test",
    observedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    confirmation: "EVIDENCE_REVIEWED", actor: "admin",
  }, db);
  assert.equal(revoked.version, 2);
  state = (await commercialEvidenceStatus({} as NodeJS.ProcessEnv, db)).find((item) => item.requirement === "legal_documents")!;
  assert.equal(state.valid, false);
  assert.equal(state.reason, "revoked");
  assert.equal((await listCommercialEvidence(db)).length, 2);
  const audit = await pg.query<{ detail: Record<string, unknown> }>("select detail from relay_commercial_audit where action='launch_evidence.record' order by created_at");
  assert.equal(audit.rows.length, 2);
  assert.ok(!JSON.stringify(audit.rows).includes("Approval was withdrawn"));
  await pg.close();
});

test("commercial readiness cannot be enabled by environment flags until every required evidence item passes", async () => {
  const { pg, db } = await database();
  await pg.query(
    `insert into relay_price_book(id,version,provider,model,capability,currency,input_micros_per_million,output_micros_per_million,effective_from,status)
     values ('price-ready-evidence',1,'openai','gpt-ready-evidence','chat','USD',1000000,1000000,now()-interval '1 minute','active')`,
  );
  await pg.query("insert into relay_workers(id,name,last_beat,draining) values ('evidence-worker','evidence-worker',now(),false)");
  await pg.query("insert into relay_meta(key,value,updated_at) values ('scheduler_last_beat','test',now()) on conflict(key) do update set value='test',updated_at=now()");
  await pg.query(
    `insert into relay_provider_sandbox_runs(id,provider,model,capability,mode,status,currency,estimated_charge_minor,initiated_by,started_at,finished_at)
     values ('evidence-canary','openai','gpt-ready-evidence','chat','live','passed','USD',1,'admin',now(),now())`,
  );
  const env = {
    NODE_ENV: "test", RELAY_COMMERCIAL_ENABLED: "1", RELAY_PUBLIC_URL: "https://relay.example.test", REDIS_URL: "redis://unused",
    OPENAI_API_KEY: "configured", RELAY_GATEWAY_REPLICA_COUNT: "2", RELAY_COMMERCIAL_MIN_WORKERS: "1",
    RELAY_BACKUP_S3_ENDPOINT: "https://backup.example.test", RELAY_BACKUP_S3_BUCKET: "offsite", RELAY_LEGAL_APPROVED: "1",
    RELAY_LEGAL_OPERATOR_NAME: "Relay Evidence Test Ltd.", RELAY_LEGAL_CONTACT_EMAIL: "privacy@relay.example.test",
    RELAY_TERMS_VERSION: "evidence-terms-v1", RELAY_PRIVACY_VERSION: "evidence-privacy-v1", RELAY_LEGAL_EFFECTIVE_DATE: "2026-08-31",
    RELAY_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "unit", STRIPE_WEBHOOK_SECRET: "unit", RELAY_TAX_MODE: "approved_exempt",
    RELAY_REQUIRE_ADMIN_MFA: "1", RELAY_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP", RELAY_REQUIRE_PRIVILEGED_SAAS_MFA: "1",
    RELAY_SECRETS_KEY: "evidence-test-secret-key-0123456789abcdef",
    RELAY_ALERT_WEBHOOK_URL: "https://alerts.example.test/relay", RELAY_ALERT_WEBHOOK_SECRET: "evidence-alert-secret-0123456789abcdef",
    RELAY_EMAIL_WEBHOOK_URL: "https://mail.example.test/relay", RELAY_EMAIL_WEBHOOK_SECRET: "evidence-email-secret-0123456789abcdef",
    RELAY_SAAS_REGISTRATION_ENABLED: "0",
  } as NodeJS.ProcessEnv;
  const blocked = await commercialReadiness(env, db);
  assert.ok(blocked.missingEvidence.length > 0);
  assert.ok(blocked.blockers.some((item) => item.includes("launch evidence")));
  assert.equal(blocked.ready, false);
  for (const item of await expectedCommercialEvidence(env, db)) await pass(item, db);
  const ready = await commercialReadiness(env, db);
  assert.equal(ready.missingEvidence.length, 0);
  assert.equal(ready.evidenceTotal, (await expectedCommercialEvidence(env, db)).length);
  assert.equal(ready.ready, true);
  await pg.close();
});
