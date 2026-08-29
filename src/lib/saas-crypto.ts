import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 32;

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function hashSaasPassword(password: string, salt = randomBytes(16)) {
  if (password.length < 10 || password.length > 1024) throw new Error("密码长度必须为 10–1024 个字符");
  const digest = scryptSync(password, salt, KEY_BYTES);
  return `scrypt:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

export function verifySaasPassword(password: string, encoded: string) {
  const [scheme, saltText, digestText, extra] = encoded.split(":");
  if (scheme !== "scrypt" || !saltText || !digestText || extra !== undefined || password.length > 1024) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    if (salt.length < 16 || expected.length !== KEY_BYTES) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function secureToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer) {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let index = 0; index < bits.length; index += 5) {
    out += BASE32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)] || "";
  }
  return out;
}

export function base32Decode(value: string) {
  let bits = "";
  for (const char of value.replace(/=+$/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, at = Date.now(), stepSeconds = 30) {
  const counter = Math.floor(at / 1000 / stepSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, at = Date.now()) {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  return [-1, 0, 1].some((window) => {
    const expected = totpCode(secret, at + window * 30_000);
    return timingSafeEqual(Buffer.from(expected), Buffer.from(normalized));
  });
}
