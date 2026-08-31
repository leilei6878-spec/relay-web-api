import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { commercialReadiness } from "./commercial-readiness.ts";
import { collectCommercialSignals } from "./commercial-monitor.ts";
import { listProviderSandboxRuns, runProviderSandbox } from "./provider-sandbox.ts";
import type { officialChat, officialImage } from "./official-providers.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql",
    "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql", "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql", "0017_email_delivery_outbox.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql", "0020_tenant_privacy_rights.sql", "0021_customer_session_security.sql",
  ]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return { pg, db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows } };
}

async function price(pg: PGlite, input: { id: string; provider: string; model: string; capability: string; image?: number }) {
  await pg.query(
    `insert into relay_price_book(id,version,provider,model,capability,currency,input_micros_per_million,output_micros_per_million,image_price_minor,effective_from,status)
     values ($1,1,$2,$3,$4,'USD',1000000,2000000,$5,now()-interval '1 minute','active')`,
    [input.id, input.provider, input.model, input.capability, input.image || 0],
  );
}

const canaryEnv = { RELAY_ALLOW_LIVE_PROVIDER_CANARY: "1", RELAY_CANARY_MAX_CHARGE_MINOR: "100" } as NodeJS.ProcessEnv;

test("provider canary hard gate, fixed confirmation and price cap fail before any upstream call", async () => {
  const { pg, db } = await database();
  await price(pg, { id: "price-gate", provider: "openai", model: "gpt-canary", capability: "chat" });
  let called = false;
  const chat = (async () => { called = true; throw new Error("must not call"); }) as typeof officialChat;
  await assert.rejects(
    () => runProviderSandbox({ provider: "openai", model: "gpt-canary", capability: "chat", confirmation: "LIVE_COST_ACCEPTED", actor: "admin" }, { db, env: { RELAY_ALLOW_LIVE_PROVIDER_CANARY: "0" } as NodeJS.ProcessEnv, chat }),
    /HARD_GATE_CLOSED/,
  );
  await assert.rejects(
    () => runProviderSandbox({ provider: "openai", model: "gpt-canary", capability: "chat", confirmation: "wrong", actor: "admin" }, { db, env: canaryEnv, chat }),
    /CONFIRMATION_REQUIRED/,
  );
  await pg.query("update relay_price_book set input_micros_per_million=1000000000,output_micros_per_million=1000000000 where id='price-gate'");
  await assert.rejects(
    () => runProviderSandbox({ provider: "openai", model: "gpt-canary", capability: "chat", confirmation: "LIVE_COST_ACCEPTED", actor: "admin" }, { db, env: { ...canaryEnv, RELAY_CANARY_MAX_CHARGE_MINOR: "1" } as NodeJS.ProcessEnv, chat }),
    /EXCEEDS_LIMIT/,
  );
  assert.equal(called, false);
  assert.equal((await listProviderSandboxRuns(db)).length, 0);
  await pg.close();
});

test("successful chat and image canaries retain evidence but no prompt, text, image or raw response", async () => {
  const { pg, db } = await database();
  await price(pg, { id: "price-chat", provider: "openai", model: "gpt-canary", capability: "chat" });
  await price(pg, { id: "price-image", provider: "vertex", model: "gemini-image-canary", capability: "image", image: 10 });
  const chat = (async (input) => {
    assert.equal(input.messages[0]?.content, "Reply with exactly RELAY_CANARY_OK");
    return { ok: true, provider: "openai", model: "gpt-canary", id: "chat-upstream", text: "RELAY_CANARY_OK", promptTokens: 7, completionTokens: 2, finishReason: "stop", raw: { secretContent: "must-not-store" } };
  }) as typeof officialChat;
  const image = (async (input) => {
    assert.equal(input.n, 1);
    return { ok: true, provider: "vertex", model: "gemini-image-canary", id: "image-upstream", images: [{ b64_json: "must-not-store-image" }], promptTokens: 5, completionTokens: 1, raw: { secretContent: "must-not-store" } };
  }) as typeof officialImage;
  const chatRun = await runProviderSandbox({ provider: "openai", model: "gpt-canary", capability: "chat", confirmation: "LIVE_COST_ACCEPTED", actor: "admin" }, { db, env: canaryEnv, chat });
  const imageRun = await runProviderSandbox({ provider: "vertex", model: "gemini-image-canary", capability: "image", confirmation: "LIVE_COST_ACCEPTED", actor: "admin" }, { db, env: canaryEnv, image });
  assert.equal(chatRun.status, "passed");
  assert.equal(imageRun.status, "passed");
  const rows = await pg.query<Record<string, unknown>>("select * from relay_provider_sandbox_runs order by provider");
  const serialized = JSON.stringify(rows.rows);
  assert.ok(!serialized.includes("RELAY_CANARY_OK"));
  assert.ok(!serialized.includes("must-not-store"));
  assert.ok(rows.rows.every((row) => (row.detail as Record<string, unknown>).contentStored === false));
  await assert.rejects(() => pg.query("delete from relay_provider_sandbox_runs"), /append-only/);
  await assert.rejects(() => pg.query("update relay_provider_sandbox_runs set status='failed' where status='passed'"), /final provider sandbox evidence is immutable/);
  await pg.close();
});

test("failed canary sanitizes provider errors and does not satisfy readiness evidence", async () => {
  const { pg, db } = await database();
  await price(pg, { id: "price-fail", provider: "google", model: "gemini-fail", capability: "chat" });
  const chat = (async () => ({ ok: false, provider: "google", status: 401, error: "Bearer sk-secret-value at https://private.example user@example.com", code: "AUTH_FAILED" })) as typeof officialChat;
  const run = await runProviderSandbox({ provider: "google", model: "gemini-fail", capability: "chat", confirmation: "LIVE_COST_ACCEPTED", actor: "admin" }, { db, env: canaryEnv, chat });
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "AUTH_FAILED");
  assert.ok(!String(run.errorMessage).includes("sk-secret"));
  assert.ok(!String(run.errorMessage).includes("private.example"));
  assert.ok(!String(run.errorMessage).includes("user@example.com"));
  await pg.close();
});

test("commercial readiness requires a recent exact provider/model/capability canary for active prices", async () => {
  const { pg, db } = await database();
  await price(pg, { id: "price-ready", provider: "openai", model: "gpt-ready", capability: "chat" });
  const env = {
    NODE_ENV: "test", RELAY_COMMERCIAL_ENABLED: "1", RELAY_PUBLIC_URL: "https://relay.example.test", REDIS_URL: "redis://unused",
    OPENAI_API_KEY: "configured", RELAY_GATEWAY_REPLICA_COUNT: "2", RELAY_COMMERCIAL_MIN_WORKERS: "1",
    RELAY_BACKUP_S3_ENDPOINT: "https://backup.example.test", RELAY_BACKUP_S3_BUCKET: "offsite", RELAY_LEGAL_APPROVED: "1",
    RELAY_PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "unit", STRIPE_WEBHOOK_SECRET: "unit", RELAY_TAX_MODE: "approved_exempt",
  } as NodeJS.ProcessEnv;
  await pg.query("insert into relay_workers(id,name,last_beat,draining) values ('sandbox-worker','sandbox-worker',now(),false)");
  const missing = await commercialReadiness(env, db);
  assert.equal(missing.missingCanaries, 1);
  assert.ok(missing.blockers.some((blocker) => blocker.includes("canary evidence")));
  await pg.query(`insert into relay_provider_sandbox_runs(id,provider,model,capability,mode,status,currency,estimated_charge_minor,initiated_by,started_at,finished_at) values ('ready-canary','openai','gpt-ready','chat','live','passed','USD',1,'admin',now(),now())`);
  const ready = await commercialReadiness(env, db);
  assert.equal(ready.missingCanaries, 0);
  assert.ok(!ready.blockers.some((blocker) => blocker.includes("canary evidence")));
  await pg.close();
});

test("commercial readiness requires a current credential for every active provider even when an old canary passed", async () => {
  const { pg, db } = await database();
  await price(pg, { id: "price-leonardo-credential", provider: "leonardo", model: "model-live", capability: "image", image: 10 });
  await pg.query(`insert into relay_provider_sandbox_runs(id,provider,model,capability,mode,status,currency,estimated_charge_minor,initiated_by,started_at,finished_at) values ('credential-canary','leonardo','model-live','image','live','passed','USD',1,'admin',now(),now())`);
  const base = { RELAY_COMMERCIAL_ENABLED: "1", OPENAI_API_KEY: "unrelated-provider-key" } as NodeJS.ProcessEnv;
  const missing = await commercialReadiness(base, db);
  assert.deepEqual(missing.activeProviders, ["leonardo"]);
  assert.deepEqual(missing.missingProviderCredentials, ["leonardo"]);
  assert.ok(missing.blockers.some((blocker) => blocker.includes("leonardo")));
  const savedLeonardo = process.env.LEONARDO_API_KEY;
  delete process.env.LEONARDO_API_KEY;
  try {
    const signals = await collectCommercialSignals(db);
    assert.ok(signals.some((signal) => signal.code === "PROVIDER_CREDENTIAL_MISSING" && signal.message.includes("leonardo")));
  } finally {
    if (savedLeonardo === undefined) delete process.env.LEONARDO_API_KEY;
    else process.env.LEONARDO_API_KEY = savedLeonardo;
  }
  const configured = await commercialReadiness({ ...base, LEONARDO_API_KEY: "leonardo-current-key" } as NodeJS.ProcessEnv, db);
  assert.deepEqual(configured.missingProviderCredentials, []);
  await pg.close();
});

test("provider canary evidence is isolated by currency and must be live", async () => {
  const { pg, db } = await database();
  await price(pg, { id: "price-currency-usd", provider: "openai", model: "gpt-currency", capability: "chat" });
  await pg.query(
    `insert into relay_price_book(id,version,provider,model,capability,currency,input_micros_per_million,output_micros_per_million,effective_from,status)
     values ('price-currency-cny',2,'openai','gpt-currency','chat','CNY',1000000,1000000,now()-interval '1 minute','active')`,
  );
  await assert.rejects(
    () => pg.query(`insert into relay_provider_sandbox_runs(id,provider,model,capability,mode,status,currency,estimated_charge_minor,initiated_by,started_at,finished_at) values ('structural-cny','openai','gpt-currency','chat','structural','passed','CNY',1,'admin',now(),now())`),
    /check constraint/i,
  );
  await pg.query(`insert into relay_provider_sandbox_runs(id,provider,model,capability,mode,status,currency,estimated_charge_minor,initiated_by,started_at,finished_at) values ('live-usd','openai','gpt-currency','chat','live','passed','USD',1,'admin',now(),now())`);
  const env = { RELAY_COMMERCIAL_ENABLED: "1", OPENAI_API_KEY: "configured" } as NodeJS.ProcessEnv;
  const missing = await commercialReadiness(env, db);
  assert.equal(missing.activePrices, 2);
  assert.equal(missing.missingCanaries, 1);
  await pg.query(`insert into relay_provider_sandbox_runs(id,provider,model,capability,mode,status,currency,estimated_charge_minor,initiated_by,started_at,finished_at) values ('live-cny','openai','gpt-currency','chat','live','passed','CNY',1,'admin',now(),now())`);
  const exact = await commercialReadiness(env, db);
  assert.equal(exact.missingCanaries, 0);
  await pg.close();
});
