import { coordIncr, coordSemaphoreAcquire, coordSemaphoreRelease } from "./coord";
import { getSql, type Sql } from "./db";
import { secureToken, sha256 } from "./saas-crypto";
import type { CommercialApiKey, CommercialCapability } from "./commercial-types";
import { uid } from "./utils";
import { cachedCommercialReadiness } from "./commercial-readiness";
import { tenantHasCurrentLegalAcceptance } from "./legal-documents";

type DbLike = Pick<Sql, "query">;
const KEY_ROTATION_COOLDOWN_MS = 60_000;
const MIN_ROTATION_GRACE_SECONDS = 5 * 60;
const MAX_ROTATION_GRACE_SECONDS = 7 * 24 * 60 * 60;

async function database(db?: DbLike) {
  return db || getSql();
}

function mapKey(row: Record<string, unknown>): CommercialApiKey {
  const features = row.plan_features && typeof row.plan_features === "object"
    ? row.plan_features as Record<string, unknown>
    : {};
  const requestedScopes = (row.scopes || []) as CommercialCapability[];
  const effectiveScopes = requestedScopes.filter((scope) => features[scope] !== false);
  const keyModels = (row.model_allowlist || []) as string[];
  const planModels = Array.isArray(features.models) ? features.models.map(String) : [];
  const effectiveModels = planModels.length
    ? keyModels.length ? keyModels.filter((model) => planModels.includes(model)) : planModels
    : keyModels;
  return {
    commercial: true,
    id: String(row.id),
    tenantId: String(row.tenant_id),
    tenantStatus: row.tenant_status as CommercialApiKey["tenantStatus"],
    tenantPlanId: String(row.plan_id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    scopes: effectiveScopes,
    modelAllowlist: effectiveModels,
    modelAccessDenied: planModels.length > 0 && keyModels.length > 0 && effectiveModels.length === 0,
    requestsPerMinute: Number(row.requests_per_minute || row.plan_rpm || 0),
    concurrencyLimit: Number(row.concurrency_limit || row.plan_concurrency || 0),
    dailyRequestLimit: Number(row.daily_request_limit || row.plan_daily_limit || 0),
    dailyLimit: Number(row.daily_request_limit || row.plan_daily_limit || 0),
    monthlySpendLimitMinor: Number(row.monthly_spend_limit_minor || row.plan_monthly_spend || 0),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : typeof row.expires_at === "string" ? row.expires_at : null,
  };
}

function boundedLimit(value: number | undefined, maximum: number, label: string) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0 || number > maximum) throw new Error(`${label}_INVALID`);
  return Math.floor(number);
}

function boundedExpiry(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  const now = Date.now();
  if (!Number.isFinite(timestamp) || timestamp < now + 5 * 60_000 || timestamp > now + 2 * 365 * 24 * 60 * 60_000) {
    throw new Error("API_KEY_EXPIRY_INVALID");
  }
  return new Date(timestamp).toISOString();
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
  if (process.env.NODE_ENV === "production" && process.env.RELAY_COMMERCIAL_ENABLED !== "1") {
    throw new Error("COMMERCIAL_API_DISABLED");
  }
  if (process.env.NODE_ENV === "production" && !(await cachedCommercialReadiness()).ready) {
    throw new Error("COMMERCIAL_NOT_READY");
  }
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
      boundedLimit(input.requestsPerMinute, 1_000_000, "API_KEY_RPM"),
      boundedLimit(input.concurrencyLimit, 10_000, "API_KEY_CONCURRENCY"),
      boundedLimit(input.dailyRequestLimit, 1_000_000_000, "API_KEY_DAILY_LIMIT"),
      boundedLimit(input.monthlySpendLimitMinor, 1_000_000_000_000, "API_KEY_SPEND_LIMIT"),
      boundedExpiry(input.expiresAt),
      input.createdBy || null,
      input.tenantId,
    ],
  );
  if (!rows[0]) throw new Error("租户不可用");
  return { id, token, hint };
}

export async function findTenantApiKey(
  token: string,
  db?: DbLike,
  opts: { env?: NodeJS.ProcessEnv; commercialReady?: () => Promise<boolean> } = {},
) {
  const env = opts.env || process.env;
  if (!token.startsWith("sk-saas-") || token.length < 32) return null;
  if (env.NODE_ENV === "production" && env.RELAY_COMMERCIAL_ENABLED !== "1") return null;
  if (env.NODE_ENV === "production" && !(opts.commercialReady ? await opts.commercialReady() : (await cachedCommercialReadiness()).ready)) return null;
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `select k.*,t.status as tenant_status,t.plan_id,
            coalesce((p.limits->>'requestsPerMinute')::int,0) as plan_rpm,
            coalesce((p.limits->>'concurrency')::int,0) as plan_concurrency,
            coalesce((p.limits->>'dailyRequestLimit')::int,0) as plan_daily_limit,
            coalesce((p.limits->>'monthlySpendMinor')::bigint,0) as plan_monthly_spend,
            p.features as plan_features
       from relay_tenant_api_keys k
       join relay_tenants t on t.id=k.tenant_id
       join relay_plans p on p.id=t.plan_id
      where (k.key_hash=$1 or (k.previous_key_hash=$1 and k.previous_key_expires_at>now()))
        and k.enabled=true and k.revoked_at is null
        and (k.expires_at is null or k.expires_at > now())
      limit 1`,
    [sha256(token)],
  );
  if (!rows[0]) return null;
  if (!await tenantHasCurrentLegalAcceptance(String(rows[0].tenant_id), env, sql)) return null;
  return mapKey(rows[0]);
}

export async function listTenantApiKeys(tenantId: string, db?: DbLike) {
  const sql = await database(db);
  return sql.query<Record<string, unknown>>(
    `select id,name,key_prefix,key_hint,enabled,scopes,model_allowlist,requests_per_minute,
            concurrency_limit,daily_request_limit,monthly_spend_limit_minor,expires_at,last_used_at,created_at,revoked_at,
            previous_key_expires_at,rotated_at,rotation_count,updated_at
       from relay_tenant_api_keys where tenant_id=$1 order by created_at desc`,
    [tenantId],
  );
}

export async function revokeTenantApiKey(tenantId: string, keyId: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<{ id: string }>(
    `update relay_tenant_api_keys set enabled=false,revoked_at=now(),previous_key_hash=null,
       previous_key_expires_at=null,updated_at=now()
      where id=$1 and tenant_id=$2 and revoked_at is null returning id`,
    [keyId, tenantId],
  );
  return Boolean(rows[0]);
}

export async function rotateTenantApiKey(
  tenantId: string,
  keyId: string,
  graceSeconds = 24 * 60 * 60,
  db?: DbLike,
) {
  const grace = Math.floor(Number(graceSeconds));
  if (!Number.isFinite(grace) || grace < MIN_ROTATION_GRACE_SECONDS || grace > MAX_ROTATION_GRACE_SECONDS) {
    throw new Error("API_KEY_ROTATION_GRACE_INVALID");
  }
  const sql = await database(db);
  const current = (await sql.query<{ key_hash: string; rotated_at: string | Date | null }>(
    `select key_hash,rotated_at from relay_tenant_api_keys
      where id=$1 and tenant_id=$2 and enabled=true and revoked_at is null
        and (expires_at is null or expires_at>now())`,
    [keyId, tenantId],
  ))[0];
  if (!current) throw new Error("API_KEY_NOT_ROTATABLE");
  if (current.rotated_at && Date.now() - new Date(current.rotated_at).getTime() < KEY_ROTATION_COOLDOWN_MS) {
    throw new Error("API_KEY_ROTATION_COOLDOWN");
  }
  const token = `sk-saas-${secureToken(32)}`;
  const prefix = token.slice(0, 16);
  const hint = `${prefix}…${token.slice(-4)}`;
  const rows = await sql.query<{ id: string; previous_key_expires_at: string | Date }>(
    `update relay_tenant_api_keys set previous_key_hash=key_hash,
       previous_key_expires_at=least(now()+($5::text||' seconds')::interval,coalesce(expires_at,'infinity'::timestamptz)),
       key_hash=$3,key_prefix=$4,key_hint=$6,rotated_at=now(),rotation_count=rotation_count+1,updated_at=now()
      where id=$1 and tenant_id=$2 and key_hash=$7 and enabled=true and revoked_at is null
        and (expires_at is null or expires_at>now())
        and (rotated_at is null or rotated_at<=now()-interval '60 seconds')
      returning id,previous_key_expires_at`,
    [keyId, tenantId, sha256(token), prefix, grace, hint, current.key_hash],
  );
  if (!rows[0]) throw new Error("API_KEY_CONCURRENTLY_CHANGED");
  return {
    id: keyId,
    token,
    hint,
    previousValidUntil: rows[0].previous_key_expires_at instanceof Date
      ? rows[0].previous_key_expires_at.toISOString()
      : String(rows[0].previous_key_expires_at),
  };
}

export async function enforceCommercialKeyLimits(
  key: CommercialApiKey,
  capability: CommercialCapability,
  model: string,
  now = new Date(),
  db?: DbLike,
) {
  if (key.tenantStatus !== "trial" && key.tenantStatus !== "active") return { ok: false as const, status: 403, error: "TENANT_SUSPENDED" };
  if (!key.scopes.includes(capability)) return { ok: false as const, status: 403, error: `API_KEY_SCOPE_REQUIRED: ${capability}` };
  if (key.modelAccessDenied) return { ok: false as const, status: 403, error: `PLAN_MODEL_NOT_ALLOWED: ${model}` };
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
  if (key.monthlySpendLimitMinor > 0) {
    const sql = await database(db);
    const rows = await sql.query<{ spend: number; reserved: number }>(
      `select coalesce(sum(charged_minor) filter(where status='settled'),0)::bigint as spend,
              coalesce(sum(reserved_minor) filter(where status='reserved'),0)::bigint as reserved
         from relay_usage_charges
        where api_key_id=$1 and created_at >= date_trunc('month',$2::timestamptz)`,
      [key.id, now.toISOString()],
    );
    if (Number(rows[0]?.spend || 0) + Number(rows[0]?.reserved || 0) >= key.monthlySpendLimitMinor) {
      return { ok: false as const, status: 402, error: "MONTHLY_SPEND_LIMIT_REACHED" };
    }
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
