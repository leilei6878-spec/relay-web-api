import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findApiKey, primaryApiKey } from "./api-keys";
import { defaultSelectors, listEligible } from "./eligibility";
import type { Account, GatewaySettings, Proxy } from "./types";
import { usageToday } from "./usage";

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

function later(a?: string | null, b?: string | null) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export async function writeControlPlane(plane: Omit<ControlPlane, "savedAt">) {
  await mkdir(DIR, { recursive: true });
  let prev: ControlPlane | null = null;
  try {
    prev = JSON.parse(await readFile(PLANE, "utf8")) as ControlPlane;
  } catch {
    prev = null;
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
    };
  });
  const body: ControlPlane = {
    ...plane,
    accounts,
    settings: { ...fallbackSettings, ...plane.settings },
    savedAt: new Date().toISOString(),
  };
  await writeFile(PLANE, JSON.stringify(body), "utf8");
  return { ok: true as const };
}

export async function readControlPlane(): Promise<ControlPlane> {
  try {
    const raw = JSON.parse(await readFile(PLANE, "utf8")) as ControlPlane;
    return { ...raw, settings: { ...fallbackSettings, ...raw.settings } };
  } catch {
    return { accounts: [], proxies: [], settings: fallbackSettings, savedAt: "" };
  }
}

export async function patchAccount(id: string, patch: Partial<Account>) {
  const plane = await readControlPlane();
  const accounts = plane.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a));
  await mkdir(DIR, { recursive: true });
  await writeFile(
    PLANE,
    JSON.stringify({ ...plane, accounts, savedAt: new Date().toISOString() }),
    "utf8",
  );
}

export async function pickAccount(platform: "chatgpt" | "gemini", exclude: string[] = []) {
  const plane = await readControlPlane();
  const now = Date.now();
  const minGap = plane.settings.intervalMinMs || 0;
  const list = listEligible(plane.accounts, plane.proxies, plane.settings, platform, exclude);
  const ready = list.filter((a) => !a.lastUsedAt || now - Date.parse(a.lastUsedAt) >= minGap);
  return ready[0] ?? list[0] ?? null;
}

export async function ensureApiKey() {
  return primaryApiKey();
}

export function bearerToken(request: Request) {
  const header = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : header).trim();
}

export async function assertApiKey(request: Request, scope?: "chat" | "image") {
  const got = bearerToken(request);
  const rec = await findApiKey(got);
  if (!rec) return { ok: false as const, status: 401, error: "无效的 API Key" };
  if (!rec.enabled) return { ok: false as const, status: 401, error: "API Key 已停用" };
  if (scope && rec.scopes.length && !rec.scopes.includes(scope)) {
    return { ok: false as const, status: 403, error: "此 Key 没有该接口权限" };
  }
  if (rec.dailyLimit > 0) {
    const used = await usageToday(rec.id);
    if (used >= rec.dailyLimit) {
      return { ok: false as const, status: 429, error: `今日额度已用完（${rec.dailyLimit}）` };
    }
  }
  return { ok: true as const, key: rec.key, record: rec };
}