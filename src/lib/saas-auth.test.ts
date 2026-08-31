import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  assertSaasSession,
  confirmSaasMfa,
  createSaasSession,
  getSaasSession,
  loginSaas,
  registerSaasOwner,
  startSaasMfa,
  trustedSaasOrigin,
  verifySaasEmail,
  requestSaasPasswordReset,
  resetSaasPassword,
  sendSaasVerification,
} from "./saas-auth.ts";
import { totpCode } from "./saas-crypto.ts";
import { legalDocumentMetadata } from "./legal-documents.ts";

const PRODUCTION_LEGAL_ENV = {
  RELAY_LEGAL_APPROVED: "1",
  RELAY_LEGAL_OPERATOR_NAME: "Relay Test Operator Ltd.",
  RELAY_LEGAL_CONTACT_EMAIL: "privacy@relay.example.test",
  RELAY_TERMS_VERSION: "terms-test-v1",
  RELAY_PRIVACY_VERSION: "privacy-test-v1",
  RELAY_LEGAL_EFFECTIVE_DATE: "2026-08-31",
  RELAY_AUDIT_HASH_KEY: "legal-audit-hmac-key-0123456789abcdef",
};

function acceptedLegal(env: NodeJS.ProcessEnv) {
  const metadata = legalDocumentMetadata(env);
  return {
    legalAccepted: true,
    termsVersion: metadata.termsVersion,
    privacyVersion: metadata.privacyVersion,
    legalBundleSha256: metadata.bundleSha256,
  };
}

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql", "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql", "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql", "0017_email_delivery_outbox.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql", "0020_tenant_privacy_rights.sql", "0021_customer_session_security.sql", "0022_staged_mfa_enrollment.sql",
  ]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return {
    pg,
    db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows },
  };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://relay.example.test${path}`, {
    ...init,
    headers: { origin: "https://relay.example.test", host: "relay.example.test", "x-forwarded-proto": "https", ...(init.headers || {}) },
  });
}

function cookieHeader(cookies: string[]) {
  return cookies.map((value) => value.split(";", 1)[0]).join("; ");
}

function csrfFrom(cookies: string[]) {
  const value = cookies.find((item) => item.startsWith("relay_saas_csrf="))?.split(";", 1)[0]?.split("=")[1] || "";
  return decodeURIComponent(value);
}

test("SaaS origin validation trusts the configured/public edge and rejects cross-site", () => {
  const previous = process.env.RELAY_PUBLIC_URL;
  process.env.RELAY_PUBLIC_URL = "https://relay.example.test";
  assert.equal(trustedSaasOrigin(request("/api/saas/session", { method: "POST" })), true);
  assert.equal(
    trustedSaasOrigin(new Request("https://relay.example.test/api", { method: "POST", headers: { origin: "https://evil.example", host: "relay.example.test" } })),
    false,
  );
  if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
  else process.env.RELAY_PUBLIC_URL = previous;
});

test("owner registration, login, HttpOnly session and CSRF role gate", async () => {
  const { pg, db } = await database();
  const previous = process.env.RELAY_PUBLIC_URL;
  process.env.RELAY_PUBLIC_URL = "https://relay.example.test";
  const registered = await registerSaasOwner(
    { tenantName: "Portal Co", ownerName: "Owner", email: "portal@example.test", password: "portal-password-123" },
    request("/api/saas/session", { method: "POST" }),
    db,
  );
  assert.ok(registered.cookies[0]?.includes("HttpOnly"));
  assert.ok(registered.cookies.every((value) => value.includes("Secure")));
  const cookies = cookieHeader(registered.cookies);
  const csrf = csrfFrom(registered.cookies);
  const sessionRequest = request("/api/saas/session", { headers: { cookie: cookies } });
  const session = await getSaasSession(sessionRequest, db);
  assert.equal(session?.tenantId, registered.tenantId);
  assert.equal(session?.role, "owner");
  assert.equal(session?.mfaVerified, false);
  const mutation = request("/api/saas/keys", { method: "POST", headers: { cookie: cookies, "x-csrf-token": csrf } });
  assert.equal((await assertSaasSession(mutation, ["owner"], { requireCsrf: true }, db)).ok, true);
  const rejected = request("/api/saas/keys", { method: "POST", headers: { cookie: cookies, "x-csrf-token": "wrong" } });
  assert.equal((await assertSaasSession(rejected, ["owner"], { requireCsrf: true }, db)).ok, false);

  const logged = await loginSaas(
    { email: "portal@example.test", password: "portal-password-123" },
    request("/api/saas/session", { method: "POST" }),
    db,
  );
  assert.equal(logged.tenant.id, registered.tenantId);
  if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
  else process.env.RELAY_PUBLIC_URL = previous;
  await pg.close();
});

test("a suspended tenant cannot use service APIs but can reauthenticate for privacy rights", async () => {
  const { pg, db } = await database();
  const registered = await registerSaasOwner(
    { tenantName: "Suspended Co", ownerName: "Owner", email: "suspended@example.test", password: "suspended-password-12345" },
    request("/api/saas/session", { method: "POST" }),
    db,
  );
  await pg.query("update relay_tenants set status='suspended' where id=$1", [registered.tenantId]);
  const existing = request("/api/saas/session", { headers: { cookie: cookieHeader(registered.cookies) } });
  assert.equal(await getSaasSession(existing, db), null);
  const rightsSession = await getSaasSession(existing, db, { allowSuspended: true });
  assert.equal(rightsSession?.tenantStatus, "suspended");
  assert.equal((await assertSaasSession(existing, ["owner"], { requireLegal: false }, db)).ok, false);
  assert.equal((await assertSaasSession(existing, ["owner"], { requireLegal: false, allowSuspended: true }, db)).ok, true);
  const logged = await loginSaas(
    { email: "suspended@example.test", password: "suspended-password-12345" },
    request("/api/saas/session", { method: "POST" }),
    db,
  );
  assert.equal(logged.tenant.status, "suspended");
  assert.ok(await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(logged.cookies) } }), db, { allowSuspended: true }));
  await pg.close();
});

test("stale legal acceptance blocks service APIs but keeps non-conditional rights surfaces reachable", async () => {
  const { pg, db } = await database();
  const registered = await registerSaasOwner(
    { tenantName: "Reconsent Co", ownerName: "Owner", email: "reconsent@example.test", password: "reconsent-password-123" },
    request("/api/saas/session", { method: "POST" }), db,
  );
  const keys = ["RELAY_REQUIRE_LEGAL_ACCEPTANCE", "RELAY_LEGAL_APPROVED", "RELAY_LEGAL_OPERATOR_NAME", "RELAY_LEGAL_CONTACT_EMAIL", "RELAY_TERMS_VERSION", "RELAY_PRIVACY_VERSION", "RELAY_LEGAL_EFFECTIVE_DATE", "RELAY_AUDIT_HASH_KEY"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    RELAY_REQUIRE_LEGAL_ACCEPTANCE: "1", RELAY_LEGAL_APPROVED: "1",
    RELAY_LEGAL_OPERATOR_NAME: "Reconsent Test Ltd.", RELAY_LEGAL_CONTACT_EMAIL: "privacy@reconsent.test",
    RELAY_TERMS_VERSION: "reconsent-terms-v1", RELAY_PRIVACY_VERSION: "reconsent-privacy-v1",
    RELAY_LEGAL_EFFECTIVE_DATE: "2026-08-31", RELAY_AUDIT_HASH_KEY: "reconsent-audit-key-0123456789abcdef",
  });
  try {
    const mutation = request("/api/saas/keys", {
      method: "POST",
      headers: { cookie: cookieHeader(registered.cookies), "x-csrf-token": registered.csrf || "" },
    });
    const blocked = await assertSaasSession(mutation, ["owner"], { requireCsrf: true }, db);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error, "LEGAL_RECONSENT_REQUIRED");
    assert.equal((await assertSaasSession(mutation, ["owner"], { requireCsrf: true, requireLegal: false }, db)).ok, true);
    assert.equal((await getSaasSession(mutation, db))?.legalAcceptanceRequired, true);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await pg.close();
  }
});

test("MFA enrollment requires a current code and returns one-time recovery codes", async () => {
  const { pg, db } = await database();
  const previous = process.env.RELAY_PUBLIC_URL;
  process.env.RELAY_PUBLIC_URL = "https://relay.example.test";
  const registered = await registerSaasOwner(
    { tenantName: "MFA Co", ownerName: "Owner", email: "mfa@example.test", password: "mfa-password-12345" },
    request("/api/saas/session", { method: "POST" }),
    db,
  );
  const session = await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(registered.cookies) } }), db);
  assert.ok(session);
  assert.equal(session?.mfaVerified, false);
  const legacySession = await createSaasSession(registered.userId, registered.tenantId, request("/api/saas/session", { method: "POST" }), db, false);
  const forcedPrivacyMutation = request("/api/saas/privacy", { method: "POST", headers: { cookie: cookieHeader(legacySession.cookies), "x-csrf-token": csrfFrom(legacySession.cookies) } });
  const forcedPrivacyMfa = await assertSaasSession(forcedPrivacyMutation, ["owner"], { requireCsrf: true, forceMfa: true }, db);
  assert.equal(forcedPrivacyMfa.ok, false);
  if (!forcedPrivacyMfa.ok) assert.equal(forcedPrivacyMfa.error, "MFA_STEP_UP_REQUIRED");
  const enrollment = await startSaasMfa(session!, db);
  const pending = await pg.query<{ mfa_enabled: boolean; active_secret: string | null; pending_secret: string | null }>(
    "select mfa_enabled,mfa_secret_ciphertext as active_secret,mfa_pending_secret_ciphertext as pending_secret from relay_saas_users where id=$1",
    [registered.userId],
  );
  assert.equal(pending.rows[0]?.mfa_enabled, false);
  assert.equal(pending.rows[0]?.active_secret, null);
  assert.ok(pending.rows[0]?.pending_secret);
  const confirmed = await confirmSaasMfa(session!, totpCode(enrollment.secret), db);
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) { assert.equal(confirmed.recoveryCodes.length, 8); assert.equal(confirmed.revokedSessions, 1); }
  const refreshed = await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(registered.cookies) } }), db);
  assert.equal(refreshed?.mfaVerified, true);
  const legacy = await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(legacySession.cookies) } }), db);
  assert.equal(legacy, null);
  const legacyReason = await pg.query<{ revoked_reason: string }>("select revoked_reason from relay_saas_sessions where id=$1", [legacySession.sessionId]);
  assert.equal(legacyReason.rows[0]?.revoked_reason, "mfa_reenrollment");
  const previousMfaGate = process.env.RELAY_REQUIRE_PRIVILEGED_SAAS_MFA;
  process.env.RELAY_REQUIRE_PRIVILEGED_SAAS_MFA = "1";
  const currentMutation = request("/api/saas/keys", { method: "POST", headers: { cookie: cookieHeader(registered.cookies), "x-csrf-token": csrfFrom(registered.cookies) } });
  assert.equal((await assertSaasSession(currentMutation, ["owner"], { requireCsrf: true, requireMfa: true }, db)).ok, true);
  await pg.query("update relay_saas_sessions set mfa_verified_at=now()-interval '25 hours' where id=$1", [session!.sessionId]);
  const expiredStepUp = await assertSaasSession(currentMutation, ["owner"], { requireCsrf: true, requireMfa: true }, db);
  assert.equal(expiredStepUp.ok, false);
  if (!expiredStepUp.ok) assert.equal(expiredStepUp.error, "MFA_STEP_UP_REQUIRED");
  await pg.query("update relay_saas_sessions set mfa_verified_at=now() where id=$1", [session!.sessionId]);
  await assert.rejects(
    () => loginSaas({ email: "mfa@example.test", password: "mfa-password-12345" }, request("/api/saas/session", { method: "POST" }), db),
    /MFA_REQUIRED/,
  );
  const logged = await loginSaas(
    { email: "mfa@example.test", password: "mfa-password-12345", totp: totpCode(enrollment.secret) },
    request("/api/saas/session", { method: "POST" }),
    db,
  );
  assert.equal(logged.user.email, "mfa@example.test");
  assert.equal(logged.mfaVerified, true);
  if (!confirmed.ok) throw new Error("MFA confirmation failed");
  const recoveryAttempts = await Promise.allSettled([
    loginSaas({ email: "mfa@example.test", password: "mfa-password-12345", recoveryCode: confirmed.recoveryCodes[0] }, request("/api/saas/session", { method: "POST" }), db),
    loginSaas({ email: "mfa@example.test", password: "mfa-password-12345", recoveryCode: confirmed.recoveryCodes[0] }, request("/api/saas/session", { method: "POST" }), db),
  ]);
  assert.equal(recoveryAttempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(recoveryAttempts.filter((result) => result.status === "rejected").length, 1);
  const recovered = recoveryAttempts.find((result) => result.status === "fulfilled")!.value;
  assert.equal(recovered.mfaVerified, true);
  await assert.rejects(
    () => loginSaas({ email: "mfa@example.test", password: "mfa-password-12345", recoveryCode: confirmed.recoveryCodes[0] }, request("/api/saas/session", { method: "POST" }), db),
    /MFA_REQUIRED/,
  );
  if (previousMfaGate === undefined) delete process.env.RELAY_REQUIRE_PRIVILEGED_SAAS_MFA;
  else process.env.RELAY_REQUIRE_PRIVILEGED_SAAS_MFA = previousMfaGate;
  if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
  else process.env.RELAY_PUBLIC_URL = previous;
  await pg.close();
});

test("MFA re-enrollment keeps the old factor live until atomic confirmation", async () => {
  const { pg, db } = await database();
  const registered = await registerSaasOwner(
    { tenantName: "MFA Replace Co", ownerName: "Owner", email: "mfa-replace@example.test", password: "mfa-replace-password-12345" },
    request("/api/saas/session", { method: "POST" }), db,
  );
  const initial = await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(registered.cookies) } }), db);
  const first = await startSaasMfa(initial!, db);
  assert.equal((await confirmSaasMfa(initial!, totpCode(first.secret), db)).ok, true);
  const current = await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(registered.cookies) } }), db);
  assert.equal(current?.mfaEnabled, true);
  const before = await pg.query<{ active: string; recovery: string[] }>(
    "select mfa_secret_ciphertext as active,recovery_codes_hash as recovery from relay_saas_users where id=$1",
    [registered.userId],
  );
  const abandoned = await startSaasMfa(current!, db);
  assert.equal(abandoned.replacingExisting, true);
  const staged = await pg.query<{ enabled: boolean; active: string; pending: string; recovery: string[] }>(
    `select mfa_enabled as enabled,mfa_secret_ciphertext as active,
            mfa_pending_secret_ciphertext as pending,recovery_codes_hash as recovery
       from relay_saas_users where id=$1`,
    [registered.userId],
  );
  assert.equal(staged.rows[0]?.enabled, true);
  assert.equal(staged.rows[0]?.active, before.rows[0]?.active);
  assert.deepEqual(staged.rows[0]?.recovery, before.rows[0]?.recovery);
  assert.notEqual(staged.rows[0]?.pending, before.rows[0]?.active);
  assert.deepEqual(await confirmSaasMfa(current!, "not-a-code", db), { ok: false, error: "MFA_CODE_INVALID" });
  await pg.query("update relay_saas_users set mfa_pending_expires_at=now()-interval '1 second' where id=$1", [registered.userId]);
  assert.deepEqual(await confirmSaasMfa(current!, totpCode(abandoned.secret), db), { ok: false, error: "MFA_ENROLLMENT_EXPIRED" });
  const afterExpiry = await pg.query<{ enabled: boolean; active: string; pending: string | null }>(
    "select mfa_enabled as enabled,mfa_secret_ciphertext as active,mfa_pending_secret_ciphertext as pending from relay_saas_users where id=$1",
    [registered.userId],
  );
  assert.equal(afterExpiry.rows[0]?.enabled, true);
  assert.equal(afterExpiry.rows[0]?.active, before.rows[0]?.active);
  assert.equal(afterExpiry.rows[0]?.pending, null);
  const oldFactorLogin = await loginSaas(
    { email: "mfa-replace@example.test", password: "mfa-replace-password-12345", totp: totpCode(first.secret) },
    request("/api/saas/session", { method: "POST" }), db,
  );
  const extra = await createSaasSession(registered.userId, registered.tenantId, request("/api/saas/session", { method: "POST" }), db, true);
  const replacement = await startSaasMfa(current!, db);
  const switched = await confirmSaasMfa(current!, totpCode(replacement.secret), db);
  assert.equal(switched.ok, true);
  if (switched.ok) assert.equal(switched.revokedSessions, 2);
  assert.equal(await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(oldFactorLogin.cookies) } }), db), null);
  assert.equal(await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(extra.cookies) } }), db), null);
  await assert.rejects(
    () => loginSaas({ email: "mfa-replace@example.test", password: "mfa-replace-password-12345", totp: totpCode(first.secret) }, request("/api/saas/session", { method: "POST" }), db),
    /MFA_REQUIRED/,
  );
  assert.equal((await loginSaas(
    { email: "mfa-replace@example.test", password: "mfa-replace-password-12345", totp: totpCode(replacement.secret) },
    request("/api/saas/session", { method: "POST" }), db,
  )).mfaVerified, true);
  const sessionRoute = await readFile("src/routes/api/saas/session.ts", "utf8");
  assert.match(sessionRoute, /auth\.session\.mfaEnabled/);
  assert.match(sessionRoute, /forceMfa: true/);
  await pg.close();
});

test("production registration requires delivered email verification before login", async () => {
  const { pg, db } = await database();
  let verificationLink = "";
  const verificationLinks: string[] = [];
  const emailEnv = {
    ...PRODUCTION_LEGAL_ENV,
    NODE_ENV: "production",
    RELAY_PUBLIC_URL: "https://relay.example.test",
    RELAY_EMAIL_WEBHOOK_URL: "https://mail.example.test/send",
    RELAY_EMAIL_WEBHOOK_SECRET: "verification-email-secret-0123456789abcdef",
    RELAY_SECRETS_KEY: "verification-encryption-key-0123456789abcdef",
  } as NodeJS.ProcessEnv;
  const emailFetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    verificationLink = String(JSON.parse(String(init?.body)).link || "");
    verificationLinks.push(verificationLink);
    return Response.json({ ok: true });
  };
  const registered = await registerSaasOwner(
    { tenantName: "Verify Co", ownerName: "Owner", email: "verify@example.test", password: "verify-password-123", ...acceptedLegal(emailEnv) },
    request("/api/saas/session", { method: "POST" }),
    db,
    { env: emailEnv, fetcher: emailFetcher as typeof fetch },
  );
  assert.equal(registered.verificationRequired, true);
  assert.equal(registered.cookies.length, 0);
  const legalRows = await pg.query<Record<string, unknown>>("select * from relay_legal_acceptances");
  assert.equal(legalRows.rows.length, 1);
  assert.equal(legalRows.rows[0]?.acceptance_method, "registration");
  assert.equal(legalRows.rows[0]?.bundle_sha256, legalDocumentMetadata(emailEnv).bundleSha256);
  assert.ok(!JSON.stringify(legalRows.rows).includes("verify@example.test"));
  await assert.rejects(
    () => loginSaas({ email: "verify@example.test", password: "verify-password-123" }, request("/api/saas/session", { method: "POST" }), db),
    /INVALID_CREDENTIALS/,
  );
  const firstToken = new URL(verificationLink).searchParams.get("token") || "";
  assert.ok(firstToken);
  assert.deepEqual(
    await sendSaasVerification("verify@example.test", request("/api/saas/session", { method: "POST" }), db, {
      env: emailEnv, fetcher: emailFetcher as typeof fetch, deliverImmediately: true, delay: async () => undefined,
    }),
    { ok: true },
  );
  assert.deepEqual(
    await sendSaasVerification("missing@example.test", request("/api/saas/session", { method: "POST" }), db, { env: emailEnv, delay: async () => undefined }),
    { ok: true },
  );
  assert.equal(verificationLinks.length, 2);
  const token = new URL(verificationLinks[1]!).searchParams.get("token") || "";
  assert.ok(token && token !== firstToken);
  await assert.rejects(() => verifySaasEmail(firstToken, request("/api/saas/session", { method: "POST" }), db), /VERIFICATION_INVALID/);
  assert.equal((await verifySaasEmail(token, request("/api/saas/session", { method: "POST" }), db)).ok, true);
  const logged = await loginSaas(
    { email: "verify@example.test", password: "verify-password-123" },
    request("/api/saas/session", { method: "POST" }),
    db,
  );
  assert.equal(logged.user.email, "verify@example.test");
  await pg.close();
});

test("production registration rolls back user, tenant and verification when its Outbox insert fails", async () => {
  const { pg, db } = await database();
  await pg.exec("alter table relay_email_deliveries add constraint test_reject_registration_email check (kind <> 'verify-email')");
  let networkCalls = 0;
  const atomicEnv = {
    ...PRODUCTION_LEGAL_ENV,
    NODE_ENV: "production", RELAY_PUBLIC_URL: "https://relay.example.test",
    RELAY_EMAIL_WEBHOOK_URL: "https://mail.example.test/send",
    RELAY_EMAIL_WEBHOOK_SECRET: "atomic-email-secret-0123456789abcdef",
    RELAY_SECRETS_KEY: "atomic-encryption-key-0123456789abcdef",
  } as NodeJS.ProcessEnv;
  await assert.rejects(
    () => registerSaasOwner(
      { tenantName: "Atomic Registration", ownerName: "Owner", email: "atomic-register@example.test", password: "atomic-register-password-123", ...acceptedLegal(atomicEnv) },
      request("/api/saas/session", { method: "POST", headers: { "x-forwarded-for": "192.0.2.81" } }),
      db,
      {
        env: atomicEnv,
        fetcher: (async () => { networkCalls += 1; return Response.json({ ok: true }); }) as typeof fetch,
      },
    ),
    /test_reject_registration_email|constraint/i,
  );
  const counts = await pg.query<{ users: number; tenants: number; memberships: number; verifications: number; deliveries: number; acceptances: number }>(
    `select
       (select count(*)::int from relay_saas_users) as users,
       (select count(*)::int from relay_tenants) as tenants,
       (select count(*)::int from relay_tenant_memberships) as memberships,
       (select count(*)::int from relay_saas_verifications) as verifications,
       (select count(*)::int from relay_email_deliveries) as deliveries,
       (select count(*)::int from relay_legal_acceptances) as acceptances`,
  );
  assert.deepEqual(counts.rows[0], { users: 0, tenants: 0, memberships: 0, verifications: 0, deliveries: 0, acceptances: 0 });
  assert.equal(networkCalls, 0);
  await pg.close();
});

test("public reset requests enqueue asynchronously and equalize known/unknown response timing", async () => {
  const { pg, db } = await database();
  await registerSaasOwner(
    { tenantName: "Async Reset Co", ownerName: "Owner", email: "async-reset@example.test", password: "old-password-12345" },
    request("/api/saas/session", { method: "POST", headers: { "x-forwarded-for": "192.0.2.82" } }), db,
  );
  let networkCalls = 0;
  const delays: number[] = [];
  const opts = {
    env: {
      RELAY_PUBLIC_URL: "https://relay.example.test", RELAY_EMAIL_WEBHOOK_URL: "https://mail.test",
      RELAY_EMAIL_WEBHOOK_SECRET: "async-reset-email-secret-0123456789",
      RELAY_SECRETS_KEY: "async-reset-encryption-key-0123456789",
    } as NodeJS.ProcessEnv,
    fetcher: (async () => { networkCalls += 1; return Response.json({ ok: true }); }) as typeof fetch,
    delay: async (ms: number) => { delays.push(ms); },
  };
  assert.deepEqual(await requestSaasPasswordReset("async-reset@example.test", request("/api/saas/session", { method: "POST" }), db, opts), { ok: true });
  assert.deepEqual(await requestSaasPasswordReset("missing-async@example.test", request("/api/saas/session", { method: "POST" }), db, opts), { ok: true });
  assert.equal(networkCalls, 0, "the public request path must not synchronously call the receiver");
  assert.equal(delays.length, 2);
  assert.ok(delays.every((ms) => ms > 0 && ms <= 350));
  const queued = await pg.query<{ status: string }>("select status from relay_email_deliveries");
  assert.deepEqual(queued.rows, [{ status: "pending" }]);
  await pg.close();
});

test("public reset hides queue configuration failures without logging the address", async () => {
  const { pg, db } = await database();
  await registerSaasOwner(
    { tenantName: "Hidden Failure Co", ownerName: "Owner", email: "hidden-failure@example.test", password: "old-password-12345" },
    request("/api/saas/session", { method: "POST", headers: { "x-forwarded-for": "192.0.2.83" } }), db,
  );
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    assert.deepEqual(
      await requestSaasPasswordReset("hidden-failure@example.test", request("/api/saas/session", { method: "POST" }), db, {
        env: { RELAY_PUBLIC_URL: "https://relay.example.test" } as NodeJS.ProcessEnv,
        delay: async () => undefined,
      }),
      { ok: true },
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /EMAIL_OUTBOX_QUEUE_FAILED/);
  assert.ok(!logged[0]!.includes("hidden-failure@example.test"));
  assert.equal((await pg.query("select id from relay_saas_verifications where kind='password_reset'")).rows.length, 0);
  assert.equal((await pg.query("select id from relay_email_deliveries")).rows.length, 0);
  await pg.close();
});

test("password reset is non-enumerating, one-time and revokes existing sessions", async () => {
  const { pg, db } = await database();
  const previous = process.env.RELAY_PUBLIC_URL; process.env.RELAY_PUBLIC_URL = "https://relay.example.test";
  const registered = await registerSaasOwner(
    { tenantName: "Reset Co", ownerName: "Owner", email: "reset@example.test", password: "old-password-12345" },
    request("/api/saas/session", { method: "POST" }), db,
  );
  const resetSession = await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(registered.cookies) } }), db);
  await startSaasMfa(resetSession!, db);
  const links: string[] = [];
  const resetEnv = {
    RELAY_PUBLIC_URL: "https://relay.example.test", RELAY_EMAIL_WEBHOOK_URL: "https://mail.test",
    RELAY_EMAIL_WEBHOOK_SECRET: "reset-email-secret-0123456789abcdef",
    RELAY_SECRETS_KEY: "reset-encryption-key-0123456789abcdef",
  } as NodeJS.ProcessEnv;
  const resetOpts = {
    env: resetEnv,
    fetcher: (async (_url, init) => { links.push(JSON.parse(String(init?.body)).link); return Response.json({ ok: true }); }) as typeof fetch,
    deliverImmediately: true,
    delay: async () => undefined,
  };
  assert.deepEqual(await requestSaasPasswordReset("reset@example.test", request("/api/saas/session", { method: "POST" }), db, resetOpts), { ok: true });
  const firstToken = new URL(links[0]!).searchParams.get("token") || "";
  assert.deepEqual(await requestSaasPasswordReset("reset@example.test", request("/api/saas/session", { method: "POST" }), db, resetOpts), { ok: true });
  assert.deepEqual(await requestSaasPasswordReset("unknown@example.test", request("/api/saas/session", { method: "POST" }), db, { env: {} as NodeJS.ProcessEnv, delay: async () => undefined }), { ok: true });
  assert.equal(links.length, 2);
  const token = new URL(links[1]!).searchParams.get("token") || "";
  assert.ok(firstToken && token && firstToken !== token);
  await assert.rejects(() => resetSaasPassword(firstToken, "discarded-password-123", request("/api/saas/session", { method: "POST" }), db), /RESET_INVALID/);
  assert.equal((await resetSaasPassword(token, "new-password-12345", request("/api/saas/session", { method: "POST" }), db)).ok, true);
  const clearedPending = await pg.query<{ count: number }>("select count(*)::int as count from relay_saas_users where id=$1 and mfa_pending_secret_ciphertext is not null", [registered.userId]);
  assert.equal(clearedPending.rows[0]?.count, 0);
  await assert.rejects(() => resetSaasPassword(token, "another-password-123", request("/api/saas/session", { method: "POST" }), db), /RESET_INVALID/);
  assert.equal(await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(registered.cookies) } }), db), null);
  const logged = await loginSaas({ email: "reset@example.test", password: "new-password-12345" }, request("/api/saas/session", { method: "POST" }), db);
  assert.equal(logged.user.email, "reset@example.test");
  if (previous === undefined) delete process.env.RELAY_PUBLIC_URL; else process.env.RELAY_PUBLIC_URL = previous;
  await pg.close();
});

test("billing, API-key and membership mutations are wired to the session-level MFA guard", async () => {
  for (const path of ["src/routes/api/saas/billing.ts", "src/routes/api/saas/keys.ts", "src/routes/api/saas/members.ts"]) {
    const source = await readFile(path, "utf8");
    assert.match(source, /requireCsrf:\s*true,\s*requireMfa:\s*true/);
  }
});
