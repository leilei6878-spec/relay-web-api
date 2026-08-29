import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adminLoginAttemptKey,
  adminLoginBlocked,
  adminMfaConfigured,
  allowAdminBearer,
  allowAdminTokenSessionLogin,
  hashAdminPassword,
  recordAdminLoginResult,
  resetAdminLoginAttemptsForTests,
  verifyAdminCredentials,
  verifyAdminRecoveryToken,
  verifyAdminTotp,
} from "./admin-password.ts";
import { totpCode } from "./saas-crypto.ts";

test("administrator password hashes verify without storing plaintext", () => {
  const encoded = hashAdminPassword("correct horse", Buffer.alloc(16, 7));
  assert.match(encoded, /^scrypt:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(encoded.includes("correct horse"), false);
  const env = {
    RELAY_ADMIN_USERNAME: "admin",
    RELAY_ADMIN_PASSWORD_HASH: encoded,
  } as NodeJS.ProcessEnv;
  assert.equal(verifyAdminCredentials("admin", "correct horse", env), true);
  assert.equal(verifyAdminCredentials("Admin", "correct horse", env), false);
  assert.equal(verifyAdminCredentials("admin", "wrong", env), false);
});

test("administrator credential verification fails closed on missing or malformed config", () => {
  assert.equal(verifyAdminCredentials("admin", "password", {} as NodeJS.ProcessEnv), false);
  assert.equal(
    verifyAdminCredentials("admin", "password", {
      RELAY_ADMIN_USERNAME: "admin",
      RELAY_ADMIN_PASSWORD_HASH: "not-a-password-hash",
    } as NodeJS.ProcessEnv),
    false,
  );
});

test("administrator TOTP configuration is bounded and verifies a rolling code", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const at = 2_000_000_000_000;
  const env = { RELAY_ADMIN_TOTP_SECRET: secret } as NodeJS.ProcessEnv;
  assert.equal(adminMfaConfigured(env), true);
  assert.equal(verifyAdminTotp(totpCode(secret, at), env, at), true);
  assert.equal(verifyAdminTotp("000000", env, at), totpCode(secret, at) === "000000");
  assert.equal(adminMfaConfigured({ RELAY_ADMIN_TOTP_SECRET: "not-base32" } as NodeJS.ProcessEnv), false);
});

test("administrator root-token exchange is constant-time and production-local by default", () => {
  assert.equal(verifyAdminRecoveryToken("ad-relay-secret", "ad-relay-secret"), true);
  assert.equal(verifyAdminRecoveryToken("ad-relay-wrong", "ad-relay-secret"), false);
  assert.equal(allowAdminTokenSessionLogin(new Request("https://relay.example/api/admin/session"), { NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
  assert.equal(allowAdminTokenSessionLogin(new Request("http://127.0.0.1/api/admin/session"), { NODE_ENV: "production" } as NodeJS.ProcessEnv), true);
  assert.equal(allowAdminTokenSessionLogin(new Request("http://127.0.0.1/api/admin/session", { headers: { "x-forwarded-for": "127.0.0.1" } }), { NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
  assert.equal(allowAdminTokenSessionLogin(new Request("https://relay.example/api/admin/session"), { NODE_ENV: "development" } as NodeJS.ProcessEnv), true);
  assert.equal(allowAdminBearer(new Request("https://relay.example/api/admin/metrics"), { NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
  assert.equal(allowAdminBearer(new Request("http://localhost/api/admin/metrics"), { NODE_ENV: "production" } as NodeJS.ProcessEnv), true);
  assert.equal(allowAdminBearer(new Request("https://relay.example/api/admin/metrics"), { NODE_ENV: "production", RELAY_ALLOW_REMOTE_ADMIN_BEARER: "1" } as NodeJS.ProcessEnv), true);
});

test("administrator login failures are bounded per client window", () => {
  resetAdminLoginAttemptsForTests();
  const key = "198.51.100.7";
  for (let i = 0; i < 7; i += 1) recordAdminLoginResult(key, false, 1_000);
  assert.equal(adminLoginBlocked(key, 2_000), false);
  recordAdminLoginResult(key, false, 1_000);
  assert.equal(adminLoginBlocked(key, 2_000), true);
  assert.equal(adminLoginBlocked(key, 1_000 + 15 * 60_000), false);
  recordAdminLoginResult(key, false, 2_000_000);
  recordAdminLoginResult(key, true, 2_000_001);
  assert.equal(adminLoginBlocked(key, 2_000_002), false);
});

test("administrator login keys prefer the trusted edge address", () => {
  const request = new Request("https://relay.example/login", {
    headers: {
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.2, 198.51.100.3",
    },
  });
  assert.equal(adminLoginAttemptKey(request), "203.0.113.9");
});
