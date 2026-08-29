import { coordIncr, coordSemaphoreAcquire, coordSemaphoreRelease } from "./coord";
import { getSql, type Sql } from "./db";
import { secureToken, sha256 } from "./saas-crypto";
import type { CommercialApiKey, CommercialCapability } from "./commercial-types";
import { uid } from "./utils";

type DbLike = Pick<Sql, "query">;

async function database(db?: DbLike) {
  return db || getSql();
}

function mapKey(row: Record<string, unknown>): CommercialApiKey {
  return {
    commercial: true,
    id: String(row.id),
    tenantId: String(row.tenant_id),
    tenantStatus: row.tenant_status as CommercialApiKey["tenantStatus"],
    tenantPlanId: String(row.plan_id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    scopes: (row.scopes || []) as CommercialCapability[],
    modelAllowlist: (row.model_allowlist || []) as string[],
    requestsPerMinute: Number(row.requests_per_minute || row.plan_rpm || 0),
    concurrencyLimit: Number(row.concurrency_limit || row.plan_concurrency || 0),
    dailyRequestLimit: Number(row.daily_request_limit || 0),
    dailyLimit: Number(row.daily_request_limit || 0),
    monthlySpendLimitMinor: Number(row.monthly_spend_limit_minor || 0),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : typeof row.expires_at === "string" ? row.expires_at : null,
  };
}

export async function createTenantApiKey(
  input: {
    tenantId: string;
    name: string;
    createdBy?: string;
    scopes?: CommercialCapability[];
    modelAllowlist?: string[];
    requestsPerMinute?: number;
    concurrencyLimit?: number;
    dailyRequestLimit?: number;
    monthlySpendLimitMinor?: number;
    expiresAt?: string | null;
  },
  db?: DbLike,
) {
  const sql = await database(db);
  const token = `sk-saas-${secureToken(32)}`;
  const id = uid();
  const scopes = [...new Set((input.scopes || ["chat", "image"]).filter((scope): scope is CommercialCapability => scope === "chat" || scope === "image"))];
  if (!scopes.length) throw new Error("至少选择一个 API Key 权限");
  const allowlist = [...new Set((input.modelAllowlist || []).map((model) => model.trim()).filter(Boolean))].slice(0, 100);
  const prefix = token.slice(0, 16);
  const hint = `${prefix}…${token.slice(-4)}`;
  const rows = await sql.query<{ id: string }>(
    `insert into relay_tenant_api_keys
      (id,tenant_id,name,key_hash,key_prefix,key_hint,enabled,scopes,model_allowlist,
       requests_per_minute,concurrency_limit,daily_request_limit,monthly_spend_limit_minor,
       expires_at,created_by,created_at)
     select $1,t.id,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12,$13,now()
       from relay_tenants t where t.id=$14 and t.status in ('trial','active')
     returning id`,
    [
      id,
      input.name.trim().slice(0, 120) || "Default",
      sha256(token),
      prefix,
      hint,
      scopes,
      allowlist,
      Math.max(0, Math.floor(input.requestsPerMinute || 0)),
      Math.max(0, Math.floor(input.concurrencyLimit || 0)),
      Math.max(0, Math.floor(input.dailyRequestLimit || 0)),
      Math.max(0, Math.floor(input.monthlySpendLimitMinor || 0)),
      input.expiresAt || null,
      input.createdBy || null,
      input.tenantId,
    ],
  );
  if (!rows[0]) throw new Error("租户不可用");
  return { id, token, hint };
}

export async function findTenantApiKey(token: string, db?: DbLike) {
  if (!token.startsWith("sk-saas-") || token.length < 32) return null;
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `select k.*,t.status as tenant_status,t.plan_id,
            coalesce((p.limits->>'requestsPerMinute')::int,0) as plan_rpm,
            coalesce((p.limits->>'concurrency')::int,0) as plan_concurrency
       from relay_tenant_api_keys k
       join relay_tenants t on t.id=k.tenant_id
       join relay_plans p on p.id=t.plan_id
      where k.key_hash=$1 and k.enabled=true and k.revoked_at is null
        and (k.expires_at is null or k.expires_at > now())
      limit 1`,
    [sha256(token)],
  );
  return rows[0] ? mapKey(rows[0]) : null;
}

export async function listTenantApiKeys(tenantId: string, db?: DbLike) {
  const sql = await database(db);
  return sql.query<Record<string, unknown>>(
    `select id,name,key_prefix,key_hint,enabled,scopes,model_allowlist,requests_per_minute,
            concurrency_limit,daily_request_limit,monthly_spend_limit_minor,expires_at,last_used_at,created_at,revoked_at
       from relay_tenant_api_keys where tenant_id=$1 order by created_at desc`,
    [tenantId],
  );
}

export async function revokeTenantApiKey(tenantId: string, keyId: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<{ id: string }>(
    "update relay_tenant_api_keys set enabled=false,revoked_at=now() where id=$1 and tenant_id=$2 and revoked_at is null returning id",
    [keyId, tenantId],
  );
  return Boolean(rows[0]);
}

export async function enforceCommercialKeyLimits(
  key: CommercialApiKey,
  capability: CommercialCapability,
  model: string,
  now = new Date(),
) {
  if (key.tenantStatus !== "trial" && key.tenantStatus !== "active") return { ok: false as const, status: 403, error: "TENANT_SUSPENDED" };
  if (!key.scopes.includes(capability)) return { ok: false as const, status: 403, error: `API_KEY_SCOPE_REQUIRED: ${capability}` };
  if (key.modelAllowlist.length && !key.modelAllowlist.includes(model)) return { ok: false as const, status: 403, error: `MODEL_NOT_ALLOWED: ${model}` };
  const minute = now.toISOString().slice(0, 16);
  const day = now.toISOString().slice(0, 10);
  if (key.requestsPerMinute > 0) {
    const count = await coordIncr(`saas:rl:minute:${key.id}:${minute}`, 120_000);
    if (count > key.requestsPerMinute) return { ok: false as const, status: 429, error: "RATE_LIMITED: requests_per_minute", retryAfter: 60 };
  }
  if (key.dailyRequestLimit > 0) {
    const count = await coordIncr(`saas:rl:day:${key.id}:${day}`, 2 * 86_400_000);
    if (count > key.dailyRequestLimit) return { ok: false as const, status: 429, error: "RATE_LIMITED: daily_request_limit", retryAfter: 3600 };
  }
  return { ok: true as const };
}

export async function recordTenantApiKeyUse(keyId: string, db?: DbLike) {
  const sql = await database(db);
  await sql.query("update relay_tenant_api_keys set last_used_at=now() where id=$1", [keyId]);
}

export async function acquireCommercialConcurrency(key: CommercialApiKey, timeoutMs = 10 * 60_000) {
  const limit = key.concurrencyLimit > 0 ? key.concurrencyLimit : 1;
  const semaphoreKey = `saas:concurrency:${key.id}`;
  const ok = await coordSemaphoreAcquire(semaphoreKey, limit, timeoutMs);
  return { ok, semaphoreKey };
}

export function releaseCommercialConcurrency(semaphoreKey: string) {
  return coordSemaphoreRelease(semaphoreKey);
}
