import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isProduction, readEnv } from "./env-mode";

const FILE = resolve("storage", "secrets.json");
type Bag = Record<string, string>;

function keyBuf(env: NodeJS.ProcessEnv = process.env) {
  const secret = readEnv("RELAY_SECRETS_KEY", env);
  if (!secret) {
    if (isProduction()) {
      throw new Error("PRODUCTION_FAIL_CLOSED: RELAY_SECRETS_KEY required; plaintext secrets are forbidden");
    }
    return null;
  }
  return scryptSync(secret, "relay-secrets-v1", 32);
}

function encrypt(plain: string, env: NodeJS.ProcessEnv = process.env) {
  const key = keyBuf(env);
  if (!key) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(raw: string, env: NodeJS.ProcessEnv = process.env) {
  if (!raw.startsWith("enc:v1:")) return raw;
  const key = keyBuf(env);
  if (!key) throw new Error("RELAY_SECRETS_KEY required to read encrypted secret");
  const parts = raw.split(":");
  const iv = Buffer.from(parts[2] || "", "base64");
  const tag = Buffer.from(parts[3] || "", "base64");
  const data = Buffer.from(parts[4] || "", "base64");
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

export function encryptSecretValue(value: string, env: NodeJS.ProcessEnv = process.env) {
  return encrypt(value, env);
}

export function decryptSecretValue(value: string, env: NodeJS.ProcessEnv = process.env) {
  return decrypt(value, env);
}

async function load(): Promise<Bag> {
  try {
    const bag = JSON.parse(await readFile(FILE, "utf8")) as Bag;
    const out: Bag = {};
    for (const [k, v] of Object.entries(bag)) out[k] = decrypt(v);
    return out;
  } catch {
    return {};
  }
}

async function save(bag: Bag) {
  await mkdir(resolve("storage"), { recursive: true });
  const stored: Bag = {};
  for (const [k, v] of Object.entries(bag)) stored[k] = encrypt(v);
  await writeFile(FILE, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
}

export async function putSecret(key: string, value: string) {
  const bag = await load();
  if (value) bag[key] = value;
  else delete bag[key];
  await save(bag);
}

export async function getSecret(key: string) {
  const bag = await load();
  return bag[key] || "";
}

export function proxySecretKey(proxyId: string) {
  return `proxy:${proxyId}:password`;
}

export function publicProxy<T extends { password?: string; username?: string }>(proxy: T): T {
  const copy = { ...proxy };
  if ("password" in copy) copy.password = copy.password ? "***" : "";
  return copy;
}
