import { createHmac } from "node:crypto";
import { effectiveCommercialEnv } from "./commercial-config";
import { getSql, type Sql } from "./db";
import type { SaasSession } from "./saas-auth";
import { uid } from "./utils";
import { trustedClientIp } from "./client-network";

type DbLike = Pick<Sql, "query">;
type Outcome = "started" | "succeeded" | "failed";

const sensitiveKey = /token|secret|password|cookie|authorization|api.?key|credential|email|ip.?address|user.?agent/i;
const secretValue = /(?:\bsk-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._-]{12,}|\b[^\s@]+@[^\s@]+\.[^\s@]+\b)/i;
const safeMetadata = /^[A-Za-z0-9._:-]+$/;

function database(db?: DbLike) {
  return db || getSql();
}

async function auditKey(db?: DbLike) {
  const env = await effectiveCommercialEnv(process.env, db);
  const key = env.RELAY_AUDIT_HASH_KEY?.trim() || env.RELAY_SECRETS_KEY?.trim() || "";
  if (process.env.NODE_ENV === "production" && key.length < 32) {
    throw new Error("TENANT_AUDIT_UNAVAILABLE");
  }
  return key || "relay-development-audit-key";
}

function hmac(value: string, key: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function cleanDetail(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return secretValue.test(value) ? "[REDACTED]" : value.slice(0, 200);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => cleanDetail(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveKey.test(key)).slice(0, 30)
      .map(([key, item]) => [key.slice(0, 80), cleanDetail(item, depth + 1)]));
  }
  return null;
}

function cleanDetailJson(value: Record<string, unknown>) {
  const serialized = JSON.stringify(cleanDetail(value));
  return Buffer.byteLength(serialized, "utf8") <= 8_192
    ? serialized
    : JSON.stringify({ truncated: true });
}

function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id") || "";
  return /^[A-Za-z0-9._:-]{8,160}$/.test(supplied) ? supplied : uid();
}

function errorCode(error: unknown) {
  const raw = error instanceof Error ? error.message : "TENANT_MUTATION_FAILED";
  return (raw.split(":", 1)[0] || "TENANT_MUTATION_FAILED").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

function metadata(value: string, min: number, max: number) {
  if (value.length < min || value.length > max || !safeMetadata.test(value)) {
    throw new Error("TENANT_AUDIT_INVALID_METADATA");
  }
  return value;
}

function targetId(value: string | null | undefined, key: string) {
  if (!value) return null;
  const normalized = value.trim();
  if (normalized.length <= 200 && safeMetadata.test(normalized)) return normalized;
  return `hmac:${hmac(normalized, key)}`;
}

async function writeTenantAuditEvent(input: {
  request: Request;
  session: SaasSession;
  operationId: string;
  requestId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  outcome: Outcome;
  errorCode?: string | null;
  detail?: Record<string, unknown>;
  hashKey: string;
}, db?: DbLike) {
  const sql = await database(db);
  const ip = trustedClientIp(input.request);
  const userAgent = (input.request.headers.get("user-agent") || "unknown").slice(0, 1024);
  await sql.query(
    `insert into relay_tenant_audit_events
      (id,tenant_id,actor_user_id,actor_role,session_id,operation_id,action,target_type,target_id,
       outcome,error_code,request_id,ip_hmac,user_agent_hmac,detail,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,now())`,
    [uid(), input.session.tenantId, input.session.userId, input.session.role, input.session.sessionId, input.operationId,
      metadata(input.action, 3, 120), metadata(input.targetType, 3, 80), targetId(input.targetId, input.hashKey),
      input.outcome, input.errorCode?.slice(0, 120) || null, input.requestId, hmac(ip, input.hashKey), hmac(userAgent, input.hashKey),
      cleanDetailJson(input.detail || {})],
  );
}

export async function auditedTenantMutation<T>(
  request: Request,
  session: SaasSession,
  input: {
    action: string;
    targetType: string;
    targetId?: string | null;
    detail?: Record<string, unknown>;
    resultTargetId?: (result: T) => string | null | undefined;
  },
  mutate: () => Promise<T>,
  db?: DbLike,
) {
  const operationId = uid();
  const auditRequestId = requestId(request);
  const { resultTargetId, ...eventInput } = input;
  let hashKey: string;
  try {
    hashKey = await auditKey(db);
  } catch (error) {
    throw new Error("TENANT_AUDIT_UNAVAILABLE", { cause: error });
  }
  const common = { request, session, operationId, requestId: auditRequestId, hashKey, ...eventInput };
  try {
    await writeTenantAuditEvent({ ...common, outcome: "started" }, db);
  } catch (error) {
    if (error instanceof Error && error.message === "TENANT_AUDIT_INVALID_METADATA") throw error;
    throw new Error("TENANT_AUDIT_UNAVAILABLE", { cause: error });
  }
  let result: T;
  try {
    result = await mutate();
  } catch (error) {
    await writeTenantAuditEvent({ ...common, outcome: "failed", errorCode: errorCode(error) }, db).catch(() => undefined);
    throw error;
  }
  try {
    await writeTenantAuditEvent({
      ...common,
      targetId: resultTargetId?.(result) || common.targetId || null,
      outcome: "succeeded",
    }, db);
  } catch {
    // The durable `started` event makes this ambiguity observable to the
    // commercial monitor. Do not turn a completed external/payment mutation
    // into a client-visible failure that could trigger a duplicate retry.
    console.error("[tenant-audit] terminal outcome write failed", { operationId, action: input.action });
  }
  return result;
}

export async function listTenantAuditEvents(tenantId: string, limit = 100, db?: DbLike) {
  const sql = await database(db);
  return sql.query<Record<string, unknown>>(
    `select id,tenant_id,actor_user_id,actor_role,session_id,operation_id,action,target_type,target_id,
            outcome,error_code,request_id,ip_hmac,user_agent_hmac,detail,created_at
       from relay_tenant_audit_events where tenant_id=$1 order by created_at desc,id desc limit $2`,
    [tenantId, Math.max(1, Math.min(500, Math.floor(limit)))],
  );
}
