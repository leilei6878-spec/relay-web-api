import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  assertSaasSession,
  confirmSaasMfa,
  getSaasSession,
  loginSaas,
  registerSaasOwner,
  startSaasMfa,
  trustedSaasOrigin,
  verifySaasEmail,
  requestSaasPasswordReset,
  resetSaasPassword,
} from "./saas-auth.ts";
import { totpCode } from "./saas-crypto.ts";

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
  const enrollment = await startSaasMfa(session!, db);
  const confirmed = await confirmSaasMfa(session!, totpCode(enrollment.secret), db);
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) assert.equal(confirmed.recoveryCodes.length, 8);
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
  if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
  else process.env.RELAY_PUBLIC_URL = previous;
  await pg.close();
});

test("production registration requires delivered email verification before login", async () => {
  const { pg, db } = await database();
  let verificationLink = "";
  const registered = await registerSaasOwner(
    { tenantName: "Verify Co", ownerName: "Owner", email: "verify@example.test", password: "verify-password-123" },
    request("/api/saas/session", { method: "POST" }),
    db,
    {
      env: {
        NODE_ENV: "production",
        RELAY_PUBLIC_URL: "https://relay.example.test",
        RELAY_EMAIL_WEBHOOK_URL: "https://mail.example.test/send",
      } as NodeJS.ProcessEnv,
      fetcher: async (_url, init) => {
        verificationLink = String(JSON.parse(String(init?.body)).link || "");
        return Response.json({ ok: true });
      },
    },
  );
  assert.equal(registered.verificationRequired, true);
  assert.equal(registered.cookies.length, 0);
  await assert.rejects(
    () => loginSaas({ email: "verify@example.test", password: "verify-password-123" }, request("/api/saas/session", { method: "POST" }), db),
    /INVALID_CREDENTIALS/,
  );
  const token = new URL(verificationLink).searchParams.get("token") || "";
  assert.ok(token);
  assert.equal((await verifySaasEmail(token, request("/api/saas/session", { method: "POST" }), db)).ok, true);
  const logged = await loginSaas(
    { email: "verify@example.test", password: "verify-password-123" },
    request("/api/saas/session", { method: "POST" }),
    db,
  );
  assert.equal(logged.user.email, "verify@example.test");
  await pg.close();
});

test("password reset is non-enumerating, one-time and revokes existing sessions", async () => {
  const { pg, db } = await database();
  const previous = process.env.RELAY_PUBLIC_URL; process.env.RELAY_PUBLIC_URL = "https://relay.example.test";
  const registered = await registerSaasOwner(
    { tenantName: "Reset Co", ownerName: "Owner", email: "reset@example.test", password: "old-password-12345" },
    request("/api/saas/session", { method: "POST" }), db,
  );
  let link = "";
  const response = await requestSaasPasswordReset("reset@example.test", request("/api/saas/session", { method: "POST" }), db, {
    env: { RELAY_PUBLIC_URL: "https://relay.example.test", RELAY_EMAIL_WEBHOOK_URL: "https://mail.test" } as NodeJS.ProcessEnv,
    fetcher: async (_url, init) => { link = JSON.parse(String(init?.body)).link; return Response.json({ ok: true }); },
  });
  assert.equal(response.ok, true);
  assert.equal((await requestSaasPasswordReset("unknown@example.test", request("/api/saas/session", { method: "POST" }), db, { env: {} as NodeJS.ProcessEnv })).ok, true);
  const token = new URL(link).searchParams.get("token") || "";
  assert.equal((await resetSaasPassword(token, "new-password-12345", request("/api/saas/session", { method: "POST" }), db)).ok, true);
  await assert.rejects(() => resetSaasPassword(token, "another-password-123", request("/api/saas/session", { method: "POST" }), db), /RESET_INVALID/);
  assert.equal(await getSaasSession(request("/api/saas/session", { headers: { cookie: cookieHeader(registered.cookies) } }), db), null);
  const logged = await loginSaas({ email: "reset@example.test", password: "new-password-12345" }, request("/api/saas/session", { method: "POST" }), db);
  assert.equal(logged.user.email, "reset@example.test");
  if (previous === undefined) delete process.env.RELAY_PUBLIC_URL; else process.env.RELAY_PUBLIC_URL = previous;
  await pg.close();
});
