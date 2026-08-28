import { audit } from "./audit";
import { patchAccount, readControlPlane } from "./control-plane";
import { accountHealthReason, eligibilityReason, isLocked, proxyOf } from "./eligibility";
import type { Account, AccountIpState, AccountStatus, Platform } from "./types";

export type AccountExpiryFilter = "all" | "expired" | "24h" | "7d" | "none";

export type AccountQuery = {
  q?: string;
  platform?: "all" | Platform;
  status?: "all" | AccountStatus;
  proxyId?: string;
  batch?: string;
  ipState?: "all" | AccountIpState;
  expiry?: AccountExpiryFilter;
  sort?: "email" | "createdAt" | "expiresAt" | "lastProbeAt" | "lastUsedAt" | "healthScore";
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

export type AccountOperationalRow = Account & {
  available: boolean;
  schedulable: boolean;
  availabilityReason: string | null;
  schedulingReason: string | null;
  busy: boolean;
  proxyName: string;
  proxyRegion: string;
  expectedIp: string | null;
};

function time(value?: string | null) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function expiryMatches(account: Account, filter: AccountExpiryFilter, now: number) {
  const expires = time(account.expiresAt);
  if (filter === "all") return true;
  if (filter === "none") return !expires;
  if (!expires) return false;
  if (filter === "expired") return expires <= now;
  return expires > now && expires <= now + (filter === "24h" ? 86_400_000 : 7 * 86_400_000);
}

export function accountOperationalView(
  input: Awaited<ReturnType<typeof readControlPlane>>,
  query: AccountQuery = {},
  now = Date.now(),
) {
  const all = input.accounts.map<AccountOperationalRow>((account) => {
    const proxy = proxyOf(account, input.proxies);
    const availabilityReason = accountHealthReason(account, input.proxies, input.settings, now);
    const schedulingReason = eligibilityReason(account, input.proxies, input.settings, now);
    return {
      ...account,
      available: !availabilityReason,
      schedulable: !schedulingReason,
      availabilityReason,
      schedulingReason,
      busy: isLocked(account, now),
      proxyName: proxy?.name || "",
      proxyRegion: proxy?.region || "",
      expectedIp: proxy?.lastCheckIp || account.loginIp || null,
    };
  });

  const needle = (query.q || "").trim().toLowerCase();
  const expiry = query.expiry || "all";
  let rows = all.filter((account) => {
    if (query.platform && query.platform !== "all" && account.platform !== query.platform) return false;
    if (query.status && query.status !== "all" && account.status !== query.status) return false;
    if (query.proxyId && account.proxyId !== query.proxyId) return false;
    if (query.batch && account.batch !== query.batch) return false;
    if (query.ipState && query.ipState !== "all" && (account.ipState || "unknown") !== query.ipState) return false;
    if (!expiryMatches(account, expiry, now)) return false;
    if (!needle) return true;
    const haystack = [
      account.email,
      account.remark,
      account.batch,
      ...(account.tags || []),
      account.proxyName,
      account.proxyRegion,
      account.loginIp,
      account.lastProbeIp,
      account.expectedIp,
      ...(account.availableModels || []),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  });

  const sort = query.sort || "createdAt";
  const direction = query.direction === "asc" ? 1 : -1;
  rows = rows.sort((a, b) => {
    if (sort === "email") return direction * a.email.localeCompare(b.email);
    if (sort === "healthScore") return direction * ((a.healthScore || 0) - (b.healthScore || 0));
    return direction * (time(a[sort]) - time(b[sort]));
  });

  const pageSize = Math.max(10, Math.min(200, Number(query.pageSize) || 50));
  const page = Math.max(1, Number(query.page) || 1);
  const start = (page - 1) * pageSize;
  const in24h = (account: Account) => {
    const expires = time(account.expiresAt);
    return expires > now && expires <= now + 86_400_000;
  };
  const in7d = (account: Account) => {
    const expires = time(account.expiresAt);
    return expires > now && expires <= now + 7 * 86_400_000;
  };

  return {
    rows: rows.slice(start, start + pageSize),
    total: rows.length,
    page,
    pageSize,
    stats: {
      total: all.length,
      available: all.filter((account) => account.available).length,
      schedulable: all.filter((account) => account.schedulable).length,
      busy: all.filter((account) => account.busy).length,
      expiring24h: all.filter(in24h).length,
      expiring7d: all.filter(in7d).length,
      invalid: all.filter((account) => account.status === "invalid" || account.status === "banned").length,
      ipDrift: all.filter((account) => account.ipState === "drift").length,
      pendingCheck: all.filter((account) => !account.lastProbeAt || time(account.nextProbeAt) <= now).length,
    },
    facets: {
      batches: [...new Set(all.map((account) => account.batch || "").filter(Boolean))].sort(),
      tags: [...new Set(all.flatMap((account) => account.tags || []))].sort(),
    },
  };
}

function normalizedDate(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("日期格式无效");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("日期格式无效");
  return date.toISOString();
}

function normalizedTags(value: unknown) {
  if (!Array.isArray(value)) throw new Error("标签格式无效");
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
    .slice(0, 20)
    .map((item) => item.slice(0, 40));
}

const STATUSES = new Set<AccountStatus>(["pending_login", "healthy", "cooling", "probing", "invalid", "banned"]);

export function normalizeAccountOperationsPatch(raw: Record<string, unknown>): Partial<Account> {
  const patch: Partial<Account> = {};
  if ("email" in raw) {
    const email = String(raw.email || "").trim();
    if (!email || email.length > 320) throw new Error("邮箱不能为空");
    patch.email = email;
  }
  if ("remark" in raw) patch.remark = String(raw.remark || "").trim().slice(0, 2000);
  if ("batch" in raw) patch.batch = String(raw.batch || "").trim().slice(0, 80);
  if ("tags" in raw) patch.tags = normalizedTags(raw.tags);
  if ("expiresAt" in raw) patch.expiresAt = normalizedDate(raw.expiresAt);
  if ("autoCheck" in raw) patch.autoCheck = Boolean(raw.autoCheck);
  if ("proxyId" in raw) patch.proxyId = raw.proxyId ? String(raw.proxyId) : null;
  if ("loginIp" in raw) patch.loginIp = raw.loginIp ? String(raw.loginIp).trim().slice(0, 64) : null;
  if ("status" in raw) {
    const status = String(raw.status) as AccountStatus;
    if (!STATUSES.has(status)) throw new Error("账号状态无效");
    patch.status = status;
  }
  return patch;
}

export async function updateAccountOperations(id: string, raw: Record<string, unknown>) {
  const plane = await readControlPlane();
  const account = plane.accounts.find((item) => item.id === id);
  if (!account) return { ok: false as const, status: 404, error: "账号不存在" };
  let patch: Partial<Account>;
  try {
    patch = normalizeAccountOperationsPatch(raw);
  } catch (error) {
    return { ok: false as const, status: 400, error: error instanceof Error ? error.message : "账号资料无效" };
  }
  await patchAccount(id, patch);
  await audit("account.update", JSON.stringify({ accountId: id, fields: Object.keys(patch) }));
  const next = await readControlPlane();
  return { ok: true as const, account: next.accounts.find((item) => item.id === id) };
}

export async function bulkUpdateAccountOperations(ids: string[], raw: Record<string, unknown>) {
  const unique = [...new Set(ids.map(String).filter(Boolean))].slice(0, 500);
  if (!unique.length) return { ok: false as const, status: 400, error: "没有选择账号" };
  let patch: Partial<Account>;
  try {
    patch = normalizeAccountOperationsPatch(raw);
  } catch (error) {
    return { ok: false as const, status: 400, error: error instanceof Error ? error.message : "批量资料无效" };
  }
  const plane = await readControlPlane();
  const existing = new Set(plane.accounts.map((account) => account.id));
  let updated = 0;
  for (const id of unique) {
    if (!existing.has(id)) continue;
    await patchAccount(id, patch);
    updated += 1;
  }
  await audit("account.bulk-update", JSON.stringify({ accountIds: unique, fields: Object.keys(patch), updated }));
  return { ok: true as const, updated };
}
