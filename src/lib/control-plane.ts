import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultSelectors, listEligible } from "./eligibility";
import type { Account, GatewaySettings, Proxy } from "./types";

const DIR = resolve("storage");
const PLANE = resolve(DIR, "control-plane.json");
const KEYS = resolve(DIR, "api-keys.json");

const fallbackSettings: GatewaySettings = {
  maxRetry: 3,
  failThreshold: 5,
  coolDownSeconds: 300,
  intervalMinMs: 800,
  intervalMaxMs: 2500,
  concurrencyPerWorker: 3,
  enforceProxy: true,
  replyTimeoutMs: 90_000,
  chatgptSelectors: defaultSelectors.chatgpt,
  geminiSelectors: defaultSelectors.gemini,
};

export type ControlPlane = {
  accounts: Account[];
  proxies: Proxy[];
  settings: GatewaySettings;
  savedAt: string;
};

export async function writeControlPlane(plane: Omit<ControlPlane, "savedAt">) {
  await mkdir(DIR, { recursive: true });
  const body: ControlPlane = { ...plane, savedAt: new Date().toISOString() };
  await writeFile(PLANE, JSON.stringify(body), "utf8");
  return { ok: true as const };
}

export async function readControlPlane(): Promise<ControlPlane> {
  try {
    return JSON.parse(await readFile(PLANE, "utf8")) as ControlPlane;
  } catch {
    return { accounts: [], proxies: [], settings: fallbackSettings, savedAt: "" };
  }
}

export async function pickAccount(platform: "chatgpt" | "gemini", exclude: string[] = []) {
  const plane = await readControlPlane();
  return listEligible(plane.accounts, plane.proxies, plane.settings, platform, exclude)[0] ?? null;
}

export async function ensureApiKey() {
  await mkdir(DIR, { recursive: true });
  try {
    const raw = JSON.parse(await readFile(KEYS, "utf8")) as { apiKey?: string };
    if (raw.apiKey) return raw.apiKey;
  } catch {
    /* create */
  }
  const apiKey = `sk-relay-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  await writeFile(KEYS, JSON.stringify({ apiKey }, null, 2), { encoding: "utf8", mode: 0o600 });
  return apiKey;
}

export function bearerToken(request: Request) {
  const header = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : header).trim();
}

export async function assertApiKey(request: Request) {
  const key = await ensureApiKey();
  const got = bearerToken(request);
  if (!got || got !== key) {
    return { ok: false as const, status: 401, error: "无效的 API Key" };
  }
  return { ok: true as const, key };
}
