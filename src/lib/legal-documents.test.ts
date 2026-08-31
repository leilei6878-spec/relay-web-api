import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { legalDocumentMetadata, prepareLegalAcceptance, recordLegalReconsent, tenantHasCurrentLegalAcceptance, userHasCurrentLegalAcceptance } from "./legal-documents.ts";

const env = {
  NODE_ENV: "production",
  RELAY_LEGAL_APPROVED: "1",
  RELAY_LEGAL_OPERATOR_NAME: "Relay Example Ltd.",
  RELAY_LEGAL_CONTACT_EMAIL: "privacy@relay.example.test",
  RELAY_TERMS_VERSION: "terms-2026-08",
  RELAY_PRIVACY_VERSION: "privacy-2026-08",
  RELAY_LEGAL_EFFECTIVE_DATE: "2026-08-31",
  RELAY_AUDIT_HASH_KEY: "legal-acceptance-hmac-key-0123456789abcdef",
  RELAY_TRUST_PROXY_HEADERS: "1",
  RELAY_CLIENT_IP_HEADER: "x-real-ip",
} as NodeJS.ProcessEnv;

test("legal metadata binds operator, versions, effective date and exact content hash", () => {
  const metadata = legalDocumentMetadata(env);
  assert.equal(metadata.configured, true);
  assert.equal(metadata.approved, true);
  assert.match(metadata.bundleSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(legalDocumentMetadata({ ...env, RELAY_TERMS_VERSION: "terms-2026-09" }).bundleSha256, metadata.bundleSha256);
  assert.equal(legalDocumentMetadata({ ...env, RELAY_LEGAL_CONTACT_EMAIL: "invalid" }).configured, false);
  assert.equal(legalDocumentMetadata({ ...env, RELAY_LEGAL_EFFECTIVE_DATE: "2026-02-31" }).configured, false);
});

test("explicit acceptance rejects stale/draft documents and stores only HMAC network evidence", () => {
  const metadata = legalDocumentMetadata(env);
  const request = new Request("https://relay.example.test/api/saas/session", {
    headers: {
      "x-real-ip": "203.0.113.70", "cf-connecting-ip": "198.51.100.99",
      "x-forwarded-for": "192.0.2.8", "user-agent": "LegalAcceptanceTest/1.0",
    },
  });
  const accepted = prepareLegalAcceptance({
    accepted: true, termsVersion: metadata.termsVersion, privacyVersion: metadata.privacyVersion,
    bundleSha256: metadata.bundleSha256, method: "registration",
  }, request, env)!;
  assert.equal(accepted.ipHmac, createHmac("sha256", env.RELAY_AUDIT_HASH_KEY!).update("203.0.113.70").digest("hex"));
  assert.ok(!JSON.stringify(accepted).includes("203.0.113.70"));
  assert.ok(!JSON.stringify(accepted).includes("LegalAcceptanceTest"));
  assert.throws(() => prepareLegalAcceptance({ accepted: false, method: "registration" }, request, env), /LEGAL_ACCEPTANCE_REQUIRED/);
  assert.throws(() => prepareLegalAcceptance({ accepted: true, termsVersion: "old", privacyVersion: metadata.privacyVersion, bundleSha256: metadata.bundleSha256, method: "registration" }, request, env), /LEGAL_DOCUMENT_VERSION_STALE/);
  assert.throws(() => prepareLegalAcceptance({ accepted: true, termsVersion: metadata.termsVersion, privacyVersion: metadata.privacyVersion, bundleSha256: metadata.bundleSha256, method: "registration" }, request, { ...env, RELAY_LEGAL_APPROVED: "0" }), /LEGAL_DOCUMENTS_NOT_APPROVED/);
  assert.equal(prepareLegalAcceptance({ method: "registration" }, request, { NODE_ENV: "development" } as NodeJS.ProcessEnv), null);
});

test("legal acceptance rows are append-only", async () => {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of ["0001_relay.sql", "0004_schema_meta.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql"]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  const digest = "a".repeat(64);
  await pg.query(
    `insert into relay_legal_acceptances
      (id,user_id,tenant_id,terms_version,privacy_version,bundle_sha256,ip_hmac,user_agent_hmac,acceptance_method)
     values ('accept-1','user-1','tenant-1','terms-v1','privacy-v1',$1,$1,$1,'registration')`,
    [digest],
  );
  await assert.rejects(pg.query("update relay_legal_acceptances set terms_version='changed' where id='accept-1'"), /append-only/);
  await assert.rejects(pg.query("delete from relay_legal_acceptances where id='accept-1'"), /append-only/);
  await pg.close();
});

test("registration and invite UI/API keep the explicit legal-version contract", async () => {
  const login = await readFile("src/routes/saas/login.tsx", "utf8");
  const invite = await readFile("src/routes/saas/invite.tsx", "utf8");
  const sessionRoute = await readFile("src/routes/api/saas/session.ts", "utf8");
  const inviteRoute = await readFile("src/routes/api/saas/invite.ts", "utf8");
  for (const source of [login, invite]) {
    assert.match(source, /type="checkbox"/);
    assert.match(source, /legalBundleSha256/);
    assert.match(source, /termsVersion/);
    assert.match(source, /privacyVersion/);
  }
  for (const source of [sessionRoute, inviteRoute]) {
    assert.match(source, /legalAccepted/);
    assert.match(source, /legalBundleSha256/);
  }
});

test("reconsent route, session gate, portal redirect and machine-key gate stay wired", async () => {
  const consentPage = await readFile("src/routes/saas/consent.tsx", "utf8");
  const consentRoute = await readFile("src/routes/api/saas/consent.ts", "utf8");
  const session = await readFile("src/lib/saas-auth.ts", "utf8");
  const portal = await readFile("src/routes/portal.tsx", "utf8");
  const keys = await readFile("src/lib/saas-api-keys.ts", "utf8");
  assert.match(consentPage, /type="checkbox"/);
  assert.match(consentPage, /bundleSha256/);
  assert.match(consentRoute, /requireLegal:\s*false/);
  assert.match(consentRoute, /recordLegalReconsent/);
  assert.match(session, /LEGAL_RECONSENT_REQUIRED/);
  assert.match(portal, /\/saas\/consent/);
  assert.match(keys, /tenantHasCurrentLegalAcceptance/);
});

test("reconsent restores the current user and tenant gate, replays idempotently, and expires on the next version", async () => {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of ["0001_relay.sql", "0004_schema_meta.sql", "0007_commercial_saas.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql"]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  const db = { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
  await pg.query("insert into relay_saas_users(id,email,email_normalized,name,password_hash,status) values ('legal-user','legal@example.test','legal@example.test','Legal User','hash','active')");
  await pg.query("insert into relay_tenants(id,slug,name,status,plan_id,billing_email) values ('legal-tenant','legal-tenant','Legal Tenant','active','starter','legal@example.test')");
  await pg.query("insert into relay_tenant_memberships(tenant_id,user_id,role,status) values ('legal-tenant','legal-user','owner','active')");
  const digest = "b".repeat(64);
  await pg.query(`insert into relay_legal_acceptances(id,user_id,tenant_id,terms_version,privacy_version,bundle_sha256,ip_hmac,user_agent_hmac,acceptance_method) values ('old-acceptance','legal-user','legal-tenant','old-terms','old-privacy',$1,$1,$1,'registration')`, [digest]);
  assert.equal(await userHasCurrentLegalAcceptance("legal-user", "legal-tenant", env, db), false);
  assert.equal(await tenantHasCurrentLegalAcceptance("legal-tenant", env, db), false);
  const metadata = legalDocumentMetadata(env);
  const request = new Request("https://relay.example.test/api/saas/consent", { headers: { "x-real-ip": "203.0.113.71", "user-agent": "ReconsentTest" } });
  const input = { userId: "legal-user", tenantId: "legal-tenant", accepted: true, termsVersion: metadata.termsVersion, privacyVersion: metadata.privacyVersion, bundleSha256: metadata.bundleSha256 };
  const first = await recordLegalReconsent(input, request, { db, env });
  assert.equal(first.replay, false);
  assert.equal(await userHasCurrentLegalAcceptance("legal-user", "legal-tenant", env, db), true);
  assert.equal(await tenantHasCurrentLegalAcceptance("legal-tenant", env, db), true);
  const replay = await recordLegalReconsent(input, request, { db, env });
  assert.equal(replay.id, first.id);
  assert.equal(replay.replay, true);
  assert.equal((await pg.query<{ count: number }>("select count(*)::int as count from relay_legal_acceptances")).rows[0]?.count, 2);
  const nextEnv = { ...env, RELAY_TERMS_VERSION: "terms-2026-09" } as NodeJS.ProcessEnv;
  assert.equal(await userHasCurrentLegalAcceptance("legal-user", "legal-tenant", nextEnv, db), false);
  assert.equal(await tenantHasCurrentLegalAcceptance("legal-tenant", nextEnv, db), false);
  await pg.close();
});
