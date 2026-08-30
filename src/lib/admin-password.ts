import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { base32Decode, verifyTotp } from "./saas-crypto";
import { trustedClientIp } from "./client-network";

const PREFIX = "scrypt";
const KEY_BYTES = 32;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;
const attempts = new Map<string, { failures: number; resetAt: number }>();

function safeTextEqual(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export function verifyAdminRecoveryToken(candidate: string, expected: string) {
  if (!candidate || !expected || candidate.length > 1024 || expected.length > 1024) return false;
  return safeTextEqual(candidate, expected);
}

export function hashAdminPassword(password: string, salt = randomBytes(16)) {
  if (!password || password.length > 1024) throw new Error("invalid administrator password");
  const digest = scryptSync(password, salt, KEY_BYTES);
  return `${PREFIX}:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

export function verifyAdminCredentials(
  username: string,
  password: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const expectedUsername = env.RELAY_ADMIN_USERNAME?.trim() || "";
  const encoded = env.RELAY_ADMIN_PASSWORD_HASH?.trim() || "";
  if (!expectedUsername || !username || !password || password.length > 1024) return false;
  const usernameOk = safeTextEqual(username, expectedUsername);
  const [prefix, saltText, digestText, extra] = encoded.split(":");
  if (prefix !== PREFIX || !saltText || !digestText || extra !== undefined) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    if (salt.length < 16 || expected.length !== KEY_BYTES) return false;
    const actual = scryptSync(password, salt, expected.length);
    return usernameOk && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function adminMfaConfigured(env: NodeJS.ProcessEnv = process.env) {
  const secret = (env.RELAY_ADMIN_TOTP_SECRET || "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z2-7]{16,128}$/.test(secret)) return false;
  try {
    return base32Decode(secret).length >= 10;
  } catch {
    return false;
  }
}

export function verifyAdminTotp(code: string, env: NodeJS.ProcessEnv = process.env, at = Date.now()) {
  if (!adminMfaConfigured(env)) return false;
  try {
    return verifyTotp(String(env.RELAY_ADMIN_TOTP_SECRET || "").replace(/\s+/g, "").toUpperCase(), code, at);
  } catch {
    return false;
  }
}

function directLoopbackRequest(request: Request) {
  if (request.headers.get("forwarded") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip")) return false;
  const host = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function allowAdminTokenSessionLogin(request: Request, env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== "production") return true;
  if (env.RELAY_ALLOW_REMOTE_ADMIN_TOKEN_LOGIN === "1") return true;
  return directLoopbackRequest(request);
}

export function allowAdminBearer(request: Request, env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== "production") return true;
  if (env.RELAY_ALLOW_REMOTE_ADMIN_BEARER === "1") return true;
  return directLoopbackRequest(request);
}

export function adminLoginAttemptKey(request: Request, env: NodeJS.ProcessEnv = process.env) {
  return trustedClientIp(request, env);
}

export function adminLoginBlocked(key: string, now = Date.now()) {
  const row = attempts.get(key);
  if (!row) return false;
  if (row.resetAt <= now) {
    attempts.delete(key);
    return false;
  }
  return row.failures >= MAX_FAILURES;
}

export function recordAdminLoginResult(key: string, ok: boolean, now = Date.now()) {
  if (ok) {
    attempts.delete(key);
    return;
  }
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  current.failures += 1;
}

export function resetAdminLoginAttemptsForTests() {
  attempts.clear();
}
