import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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

export function hashAdminPassword(password: string, salt = randomBytes(16)) {
  if (!password || password.length > 1024) throw new Error("invalid administrator password");
  const digest = scryptSync(password, salt, KEY_BYTES);
  return `${PREFIX}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
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
  const [prefix, saltText, digestText, extra] = encoded.split("$");
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

export function adminLoginAttemptKey(request: Request) {
  const forwarded = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for") || "unknown";
  return forwarded.split(",", 1)[0]!.trim().slice(0, 128) || "unknown";
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
