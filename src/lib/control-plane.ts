import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { primaryApiKey } from "./api-keys";
import { assertCustomer } from "./authz";
import { isCanaryAccount } from "./canary";
import { getCircuit } from "./circuit";
import { coordIncr } from "./coord";
import { defaultSelectors, listEligible } from "./eligibility";
import { persistenceMode, pgSotActive } from "./persist-mode";
import { getSecret, proxySecretKey, putSecret } from "./secrets";
import type { Account, GatewaySettings, Proxy } from "./types";

const DIR = resolve("storage");
const PLANE = resolve(DIR, "control-plane.json");

export const fallbackSettings: GatewaySettings = {
  maxRetry: 3,
  failThreshold: 5,
  coolDownSeconds: 300,
  intervalMinMs: 800,
  intervalMaxMs: 2500,
  concurrencyPerWorker: 3,
  enforceProxy: true,
  replyTimeoutMs: 90_000,
  allowPreviewFallback: false,
  chatgptSelectors: defaultSelectors.chatgpt,
  geminiSelectors: defaultSelectors.gemini,
};

export type ControlPlane = {
  accounts: Account[];
  proxies: Proxy[];
  settings: GatewaySettings;
  savedAt: string;
};

async function syncDb(plane: ControlPlane) {
  if (process.env.RELAY_SKIP_DB === "1") return;
  const { dbSyncPlane, safeDb } = await import("./relay-db");
  await safeDb(() => dbSyncPlane(plane));
}

async function loadDb() {
  if (process.env.RELAY_SKIP_DB === "1") return null;
  const { dbLoadPlane, safeDb } = await import("./relay-db");
  return safeDb(() => dbLoadPlane());
}

function later(a?: string | null, b?: string | null) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function stripProxySecrets(proxies: Proxy[]): Proxy[] {
  return proxies.map((p) => {
    const copy = { ...p };
    delete copy.password;
    return copy;
  });
}

export async function writeControlPlane(plane: Omit<ControlPlane, "savedAt">) {
  await mkdir(DIR, { recursive: true });
  let prev: ControlPlane | null = null;
  if (persistenceMode() === "postgres" && process.env.RELAY_SKIP_DB !== "1") {
    prev = (await loadDb()) as ControlPlane | null;
  }
  if (!prev) {
    try {
      prev = JSON.parse(await readFile(PLANE, "utf8")) as ControlPlane;
    } catch {
      prev = null;
    }
  }
  const oldById = new Map((prev?.accounts || []).map((a) => [a.id, a]));
  const accounts = plane.accounts.map((a) => {
    const old = oldById.get(a.id);
    if (!old) return a;
    const sessionChanged = a.sessionPath !== old.sessionPath;
    const serverProbeNewer =
      Boolean(old.lastProbeAt) && Date.parse(old.lastProbeAt || "") >= Date.parse(a.lastProbeAt || "");
    return {
      ...a,
      failCount: Math.max(a.failCount || 0, old.failCount || 0),
      totalRequests: Math.max(a.totalRequests || 0, old.totalRequests || 0),
      lockedUntil: later(a.lockedUntil, old.lockedUntil),
      lastUsedAt: later(a.lastUsedAt, old.lastUsedAt),
      lastProbeAt: later(a.lastProbeAt, old.lastProbeAt),
      lastError: serverProbeNewer ? old.lastError : a.lastError || old.lastError,
      sessionWarning: serverProbeNewer ? old.sessionWarning : a.sessionWarning ?? old.sessionWarning,
      status: sessionChanged ? a.status : serverProbeNewer ? old.status : a.status,
      sessionVersion: Math.max(a.sessionVersion || 0, old.sessionVersion || 0),
    };
  });
  for (const proxy of plane.proxies) {
    const pw = proxy.password || "";
    if (pw && pw !== "***") await putSecret(proxySecretKey(proxy.id), pw);
  }
  const body: ControlPlane = {
    ...plane,
    accounts,
    proxies: stripProxySecrets(plane.proxies),
    settings: { ...fallbackSettings, ...plane.settings },
    savedAt: new Date().toISOString(),
  };
  if (persistenceMode() === "file" || process.env.RELAY_SKIP_DB === "1") {
    await writeFile(PLANE, JSON.stringify(body), "utf8");
  }
  await syncDb(body);
  return { ok: true as const };
}

async function recoverCooling(plane: ControlPlane) {
  const now = Date.now();
  let changed = false;
  const accounts = plane.accounts.map((a) => {
    if (a.status !== "cooling") return a;
    if (a.lockedUntil && Date.parse(a.lockedUntil) > now) return a;
    changed = true;
    return { ...a, status: "probing" as const, lockedUntil: null };
  });
  if (!changed) return plane;
  const next = { ...plane, accounts, savedAt: new Date().toISOString() };
  if (persistenceMode() === "file" || process.env.RELAY_SKIP_DB === "1") {
    await writeFile(PLANE, JSON.stringify(next), "utf8");
  }
  await syncDb(next);
  return next;
}

export async function readControlPlane(): Promise<ControlPlane> {
  if (persistenceMode() === "postgres" && process.env.RELAY_SKIP_DB !== "1") {
    const fromDb = await loadDb();
    if (fromDb && (fromDb.accounts.length || fromDb.proxies.length || fromDb.settings)) {
      return recoverCooling({
        ...fromDb,
        settings: { ...fallbackSettings, ...(fromDb.settings || {}) },
      });
    }
  }
  try {
    const raw = JSON.parse(await readFile(PLANE, "utf8")) as ControlPlane;
    const plane = { ...raw, settings: { ...fallbackSettings, ...raw.settings } };
    return recoverCooling(plane);
  } catch {
    const fromDb = await loadDb();
    if (fromDb && (fromDb.accounts.length || fromDb.proxies.length)) {
      return recoverCooling({
        ...fromDb,
        settings: { ...fallbackSettings, ...(fromDb.settings || {}) },
      });
    }
    return { accounts: [], proxies: [], settings: fallbackSettings, savedAt: "" };
  }
}

export async function patchAccount(id: string, patch: Partial<Account>) {
  if (pgSotActive()) {
    const { dbPatchAccount } = await import("./relay-db");
    await dbPatchAccount(id, patch as Record<string, unknown>);
    return;
  }
  const plane = await readControlPlane();
  const accounts = plane.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a));
  await mkdir(DIR, { recursive: true });
  const next = { ...plane, accounts, savedAt: new Date().toISOString() };
  if (persistenceMode() === "file" || process.env.RELAY_SKIP_DB === "1") {
    await writeFile(PLANE, JSON.stringify(next), "utf8");
  }
  await syncDb(next);
}

export async function pickAccount(platform: "chatgpt" | "gemini", exclude: string[] = []) {
  const plane = await readControlPlane();
  const now = Date.now();
  const minGap = plane.settings.intervalMinMs || 0;
  const circuit = await getCircuit(platform);
  const list = listEligible(plane.accounts, plane.proxies, plane.settings, platform, exclude);
  if (circuit.state === "OPEN" || circuit.state === "HALF_OPEN") {
    const canaries = list.filter((a) => isCanaryAccount(a));
    return canaries[0] ?? null;
  }
  const ready = list.filter((a) => !a.lastUsedAt || now - Date.parse(a.lastUsedAt) >= minGap);
  return ready[0] ?? list[0] ?? null;
}

export async function boundProxySecret(proxyId: string | null | undefined) {
  if (!proxyId) return "";
  return (await getSecret(proxySecretKey(proxyId))) || "";
}

export async function ensureApiKey() {
  return primaryApiKey();
}

export async function assertApiKey(request: Request, scope?: "chat" | "image") {
  const auth = await assertCustomer(request, scope);
  if (!auth.ok) return auth;
  if (auth.record.dailyLimit > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const n = await coordIncr(`rl:day:${auth.record.id}:${day}`, 86_400_000);
    if (n > auth.record.dailyLimit) {
      return { ok: false as const, status: 429, error: `今日额度已用完（${auth.record.dailyLimit}）` };
    }
  }
  return { ok: true as const, key: auth.key, record: auth.record };
}
