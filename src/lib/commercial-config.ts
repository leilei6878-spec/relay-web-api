import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getSql, type Sql } from "./db";
import { decryptSecretValue, encryptSecretValue } from "./secrets";
import { base32Decode } from "./saas-crypto";
import { uid } from "./utils";
import { validateVertexProjectLocation, vertexAccessToken } from "./vertex-auth";

type DbLike = Pick<Sql, "query">;
type ConfigKind = "boolean" | "integer" | "enum" | "json" | "string" | "url" | "secret";
type ConnectionTest = "openai" | "google" | "vertex" | "leonardo" | "stripe" | "stripe_webhook" | "webhook";
type Resolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;

export type CommercialConfigDefinition = {
  key: string;
  label: string;
  group: "launch" | "security" | "providers" | "payments" | "delivery" | "retention";
  kind: ConfigKind;
  envName: string;
  secret?: boolean;
  hardGate?: boolean;
  test?: ConnectionTest;
  allowed?: readonly string[];
  min?: number;
  max?: number;
  description: string;
};

export const COMMERCIAL_CONFIG_CATALOG: readonly CommercialConfigDefinition[] = [
  { key: "commercial.enabled", label: "商业流量", group: "launch", kind: "boolean", envName: "RELAY_COMMERCIAL_ENABLED", hardGate: true, description: "数据库配置只能在部署环境硬门禁允许时开启商业流量。" },
  { key: "registration.enabled", label: "客户注册", group: "launch", kind: "boolean", envName: "RELAY_SAAS_REGISTRATION_ENABLED", hardGate: true, description: "数据库配置和部署硬门禁必须同时开启。" },
  { key: "legal.approved", label: "法务批准", group: "launch", kind: "boolean", envName: "RELAY_LEGAL_APPROVED", hardGate: true, description: "仅记录经过外部法务批准的期望状态，不能替代真实批准。" },
  { key: "security.adminMfaRequired", label: "管理员 MFA 强制", group: "security", kind: "boolean", envName: "RELAY_REQUIRE_ADMIN_MFA", hardGate: true, description: "商业上线必须由部署硬门禁和配置版本共同开启；开启后高风险管理操作要求 TOTP 会话。" },
  { key: "security.adminTotpSecret", label: "管理员 TOTP Secret", group: "security", kind: "secret", envName: "RELAY_ADMIN_TOTP_SECRET", secret: true, description: "Base32 TOTP Secret；AES-256-GCM 加密且只显示提示。" },
  { key: "security.adminSessionHours", label: "管理员会话小时", group: "security", kind: "integer", envName: "RELAY_ADMIN_SESSION_HOURS", min: 1, max: 24, description: "管理员浏览器会话固定有效期，不滑动续期。" },
  { key: "security.customerPrivilegedMfaRequired", label: "客户高风险操作 MFA", group: "security", kind: "boolean", envName: "RELAY_REQUIRE_PRIVILEGED_SAAS_MFA", hardGate: true, description: "商业上线必须开启；Owner/Admin/Billing/Developer 的密钥、资金、套餐和成员变更要求当前会话已验证 MFA。" },
  { key: "security.customerMfaMaxAgeHours", label: "客户 MFA 有效小时", group: "security", kind: "integer", envName: "RELAY_SAAS_MFA_MAX_AGE_HOURS", min: 1, max: 168, description: "高风险租户操作接受的最近 MFA 验证窗口；过期后必须重新登录。" },
  { key: "security.auditHashKey", label: "租户审计 HMAC Key", group: "security", kind: "secret", envName: "RELAY_AUDIT_HASH_KEY", secret: true, description: "对审计中的 IP 与 User-Agent 做不可逆 HMAC；可版本化替换，商业环境至少 32 个字符。" },
  { key: "providers.openai.apiKey", label: "OpenAI API Key", group: "providers", kind: "secret", envName: "OPENAI_API_KEY", secret: true, test: "openai", description: "服务端官方 OpenAI API 凭证。" },
  { key: "providers.google.apiKey", label: "Google Gemini API Key", group: "providers", kind: "secret", envName: "GEMINI_API_KEY", secret: true, test: "google", description: "服务端官方 Gemini API 凭证。" },
  { key: "providers.vertex.serviceAccountJson", label: "Vertex Service Account", group: "providers", kind: "secret", envName: "GOOGLE_SERVICE_ACCOUNT_JSON", secret: true, test: "vertex", description: "Vertex AI 专用服务账号 JSON；只用于短期 OAuth Token。" },
  { key: "providers.vertex.projectId", label: "Vertex Project ID", group: "providers", kind: "string", envName: "GOOGLE_CLOUD_PROJECT", description: "Google Cloud 项目 ID。" },
  { key: "providers.vertex.location", label: "Vertex Location", group: "providers", kind: "string", envName: "GOOGLE_CLOUD_LOCATION", description: "Vertex 区域，例如 us-central1 或 global。" },
  { key: "providers.leonardo.apiKey", label: "Leonardo API Key", group: "providers", kind: "secret", envName: "LEONARDO_API_KEY", secret: true, test: "leonardo", description: "服务端 Leonardo Production API 凭证。" },
  { key: "providers.leonardo.modelMap", label: "Leonardo 模型映射", group: "providers", kind: "json", envName: "LEONARDO_MODEL_MAP_JSON", description: "逻辑模型到官方模型 UUID 的 JSON 对象。" },
  { key: "payments.provider", label: "支付渠道", group: "payments", kind: "enum", envName: "RELAY_PAYMENT_PROVIDER", allowed: ["disabled", "stripe"], description: "只允许内置并经过验签的支付适配器。" },
  { key: "payments.stripe.secretKey", label: "Stripe Secret Key", group: "payments", kind: "secret", envName: "STRIPE_SECRET_KEY", secret: true, test: "stripe", description: "Stripe 服务端 live/restricted key。" },
  { key: "payments.stripe.webhookSecret", label: "Stripe Webhook Secret", group: "payments", kind: "secret", envName: "STRIPE_WEBHOOK_SECRET", secret: true, test: "stripe_webhook", description: "用于原始请求体 Webhook 验签。" },
  { key: "payments.maxRechargeMinor", label: "单次充值上限", group: "payments", kind: "integer", envName: "RELAY_STRIPE_MAX_RECHARGE_MINOR", min: 100, max: 100_000_000, description: "最小货币单位，例如 USD cents。" },
  { key: "tax.mode", label: "税务模式", group: "payments", kind: "enum", envName: "RELAY_TAX_MODE", allowed: ["unconfigured", "stripe_automatic", "approved_exempt"], description: "Stripe Tax 或书面批准的免税销售范围。" },
  { key: "email.webhookUrl", label: "邮件投递 Webhook", group: "delivery", kind: "url", envName: "RELAY_EMAIL_WEBHOOK_URL", test: "webhook", description: "只允许 HTTPS；连接测试会发送一条配置测试事件。" },
  { key: "alerts.webhookUrl", label: "告警 Webhook", group: "delivery", kind: "url", envName: "RELAY_ALERT_WEBHOOK_URL", test: "webhook", description: "只允许 HTTPS；用于持久告警投递。" },
  { key: "retention.requestContentDays", label: "请求内容保留天数", group: "retention", kind: "integer", envName: "RELAY_REQUEST_CONTENT_RETENTION_DAYS", min: 1, max: 365, description: "到期后清除请求与供应商结果内容。" },
  { key: "retention.sessionDays", label: "会话保留天数", group: "retention", kind: "integer", envName: "RELAY_SESSION_RETENTION_DAYS", min: 1, max: 365, description: "已撤销或过期 SaaS 会话的保留期。" },
  { key: "retention.operationalDays", label: "运营数据保留天数", group: "retention", kind: "integer", envName: "RELAY_OPERATIONAL_RETENTION_DAYS", min: 7, max: 730, description: "账号检查等运营数据保留期。" },
  { key: "retention.auditDays", label: "运营审计保留天数", group: "retention", kind: "integer", envName: "RELAY_AUDIT_RETENTION_DAYS", min: 90, max: 2555, description: "短期平台运营审计保留期；租户高风险审计与资金账本不受此项删除。" },
] as const;

const definitions = new Map(COMMERCIAL_CONFIG_CATALOG.map((definition) => [definition.key, definition]));

function dbOrDefault(db?: DbLike) {
  return db || getSql();
}

function definitionFor(key: string) {
  const definition = definitions.get(key);
  if (!definition) throw new Error("CONFIG_KEY_NOT_ALLOWED");
  return definition;
}

function privateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && [0, 2].includes(c)) ||
      (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (isIP(normalized) === 6) {
    if (normalized.startsWith("::ffff:")) return privateAddress(normalized.slice(7));
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  return false;
}

function rejectPrivateWebhookLiteral(parsed: URL) {
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || privateAddress(host)) {
    throw new Error("CONFIG_WEBHOOK_PRIVATE_ADDRESS_FORBIDDEN");
  }
}

export async function assertPublicCommercialWebhookUrl(value: string, resolver: Resolver = lookup as Resolver) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) throw new Error("CONFIG_HTTPS_URL_REQUIRED");
  rejectPrivateWebhookLiteral(parsed);
  const addresses = await resolver(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error("CONFIG_WEBHOOK_PRIVATE_ADDRESS_FORBIDDEN");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeValue(definition: CommercialConfigDefinition, value: unknown) {
  if (definition.kind === "secret") {
    const secret = definition.key === "security.adminTotpSecret"
      ? String(value || "").replace(/\s+/g, "").toUpperCase()
      : String(value || "").trim();
    if (secret.length < 8 || secret.length > 20_000) throw new Error("CONFIG_SECRET_INVALID");
    if (definition.key === "security.adminTotpSecret") {
      if (!/^[A-Z2-7]{16,128}$/.test(secret) || base32Decode(secret).length < 10) throw new Error("CONFIG_ADMIN_TOTP_SECRET_INVALID");
    }
    if (definition.key === "security.auditHashKey" && secret.length < 32) throw new Error("CONFIG_AUDIT_HASH_KEY_INVALID");
    return secret;
  }
  if (definition.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error("CONFIG_BOOLEAN_REQUIRED");
    return value;
  }
  if (definition.kind === "integer") {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < (definition.min ?? Number.MIN_SAFE_INTEGER) || parsed > (definition.max ?? Number.MAX_SAFE_INTEGER)) {
      throw new Error("CONFIG_INTEGER_OUT_OF_RANGE");
    }
    return parsed;
  }
  if (definition.kind === "enum") {
    const text = String(value || "");
    if (!definition.allowed?.includes(text)) throw new Error("CONFIG_ENUM_INVALID");
    return text;
  }
  if (definition.kind === "url") {
    const text = String(value || "").trim();
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) throw new Error("CONFIG_HTTPS_URL_REQUIRED");
    rejectPrivateWebhookLiteral(parsed);
    return parsed.toString().replace(/\/$/, "");
  }
  if (definition.kind === "string") {
    const text = String(value || "").trim();
    if (definition.key === "providers.vertex.projectId") validateVertexProjectLocation(text, "global");
    if (definition.key === "providers.vertex.location") validateVertexProjectLocation("valid-project", text);
    return text;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONFIG_JSON_OBJECT_REQUIRED");
  const serialized = JSON.stringify(value);
  if (serialized.length > 50_000) throw new Error("CONFIG_JSON_TOO_LARGE");
  if (definition.key === "providers.leonardo.modelMap") {
    for (const [logical, model] of Object.entries(value as Record<string, unknown>)) {
      if (!logical.trim() || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(model))) throw new Error("CONFIG_LEONARDO_MODEL_MAP_INVALID");
    }
  }
  return value;
}

function secretHint(value: string) {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function publicVersion(row: Record<string, unknown>) {
  return {
    id: String(row.id), configKey: String(row.config_key), version: Number(row.version), status: String(row.status),
    value: row.secret_ciphertext ? null : row.value_json, secret: Boolean(row.secret_ciphertext), secretHint: row.secret_hint || null,
    validationStatus: String(row.validation_status), testDetail: row.test_detail || {}, reason: String(row.reason || ""),
    createdBy: String(row.created_by), testedBy: row.tested_by || null, activatedBy: row.activated_by || null,
    createdAt: row.created_at, testedAt: row.tested_at || null, activatedAt: row.activated_at || null, retiredAt: row.retired_at || null,
  };
}

export async function createCommercialConfigVersion(
  input: { key: string; value: unknown; reason: string; actor: string },
  db?: DbLike,
) {
  const definition = definitionFor(input.key);
  const normalized = normalizeValue(definition, input.value);
  if (input.reason.trim().length < 3) throw new Error("CONFIG_REASON_REQUIRED");
  if (definition.secret && !process.env.RELAY_SECRETS_KEY?.trim()) throw new Error("CONFIG_SECRET_ENCRYPTION_KEY_REQUIRED");
  const id = uid();
  const secret = definition.secret ? String(normalized) : null;
  const initialValidation = definition.test ? "untested" : "passed";
  const sql = await dbOrDefault(db);
  const rows = await sql.query<Record<string, unknown>>(
    `with next as (
       select coalesce(max(version),0)+1 as version from relay_commercial_config_versions where config_key=$1
     ) insert into relay_commercial_config_versions
       (id,config_key,version,status,value_json,secret_ciphertext,secret_hint,validation_status,reason,created_by,created_at,updated_at)
       select $2,$1,version,'draft',$3::jsonb,$4,$5,$6,$7,$8,now(),now() from next returning *`,
    [definition.key, id, secret ? null : JSON.stringify(normalized), secret ? encryptSecretValue(secret) : null,
      secret ? secretHint(secret) : null, initialValidation, input.reason.trim().slice(0, 500), input.actor.slice(0, 120)],
  );
  if (!rows[0]) throw new Error("CONFIG_VERSION_CREATE_FAILED");
  await sql.query(
    `insert into relay_commercial_audit(id,actor_type,actor_id,action,target_type,target_id,detail)
     values ($1,'admin',$2,'config.create','commercial_config',$3,$4::jsonb)`,
    [uid(), input.actor.slice(0, 120), id, JSON.stringify({ key: definition.key, version: rows[0].version, secret: Boolean(secret) })],
  );
  resetCommercialConfigCache();
  return publicVersion(rows[0]);
}

async function testConnection(definition: CommercialConfigDefinition, value: unknown, fetcher: typeof fetch, resolver?: Resolver) {
  if (!definition.test) return { ok: true, detail: { mode: "schema" } };
  if (definition.test === "stripe_webhook") {
    return /^whsec_[A-Za-z0-9_]+$/.test(String(value))
      ? { ok: true, detail: { mode: "format" } }
      : { ok: false, detail: { code: "STRIPE_WEBHOOK_SECRET_FORMAT" } };
  }
  if (definition.test === "vertex") {
    await vertexAccessToken(String(value), { fetcher, useCache: false });
    return { ok: true, detail: { mode: "oauth" } };
  }
  let url = "";
  let headers: Record<string, string> = {};
  let method = "GET";
  let body: string | undefined;
  if (definition.test === "openai") {
    url = "https://api.openai.com/v1/models";
    headers = { Authorization: `Bearer ${String(value)}` };
  } else if (definition.test === "google") {
    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
    headers = { "x-goog-api-key": String(value) };
  } else if (definition.test === "leonardo") {
    url = "https://cloud.leonardo.ai/api/rest/v2/models";
    headers = { Authorization: `Bearer ${String(value)}`, accept: "application/json" };
  } else if (definition.test === "stripe") {
    url = "https://api.stripe.com/v1/balance";
    headers = { Authorization: `Bearer ${String(value)}` };
  } else {
    url = await assertPublicCommercialWebhookUrl(String(value), resolver);
    method = "POST";
    headers = { "Content-Type": "application/json" };
    body = JSON.stringify({ type: "relay.configuration.test", at: new Date().toISOString() });
  }
  const response = await fetcher(url, { method, headers, body, signal: AbortSignal.timeout(10_000) });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) return { ok: false, detail: { code: "CONNECTION_HTTP_ERROR", status: response.status } };
  const count = Array.isArray(parsed.data) ? parsed.data.length : Array.isArray(parsed.models) ? parsed.models.length : undefined;
  return { ok: true, detail: { mode: "connection", status: response.status, ...(count === undefined ? {} : { count }) } };
}

export async function testCommercialConfigVersion(
  id: string,
  actor: string,
  opts: { db?: DbLike; fetcher?: typeof fetch; resolver?: Resolver } = {},
) {
  const sql = await dbOrDefault(opts.db);
  const rows = await sql.query<Record<string, unknown>>("select * from relay_commercial_config_versions where id=$1", [id]);
  const row = rows[0];
  if (!row || row.status !== "draft") throw new Error("CONFIG_DRAFT_NOT_FOUND");
  const definition = definitionFor(String(row.config_key));
  const value = row.secret_ciphertext ? decryptSecretValue(String(row.secret_ciphertext)) : row.value_json;
  let result: { ok: boolean; detail: Record<string, unknown> };
  try {
    result = await testConnection(definition, value, opts.fetcher || fetch, opts.resolver);
  } catch (error) {
    result = { ok: false, detail: { code: error instanceof Error ? error.name || "CONNECTION_FAILED" : "CONNECTION_FAILED" } };
  }
  const updated = await sql.query<Record<string, unknown>>(
    `update relay_commercial_config_versions set validation_status=$2,test_detail=$3::jsonb,tested_by=$4,tested_at=now(),updated_at=now()
      where id=$1 and status='draft' returning *`,
    [id, result.ok ? "passed" : "failed", JSON.stringify(result.detail), actor.slice(0, 120)],
  );
  await sql.query(
    `insert into relay_commercial_audit(id,actor_type,actor_id,action,target_type,target_id,detail)
     values ($1,'admin',$2,'config.test','commercial_config',$3,$4::jsonb)`,
    [uid(), actor.slice(0, 120), id, JSON.stringify({ key: row.config_key, version: row.version, result: result.ok ? "passed" : "failed" })],
  );
  resetCommercialConfigCache();
  return publicVersion(updated[0]!);
}

export async function activateCommercialConfigVersion(id: string, actor: string, db?: DbLike) {
  const sql = await dbOrDefault(db);
  const rows = await sql.query<Record<string, unknown>>(
    `with target as (
       select * from relay_commercial_config_versions where id=$1 and status in ('draft','retired') and validation_status='passed' for update
     ), retired as (
       update relay_commercial_config_versions c set status='retired',retired_at=now(),updated_at=now()
        from target t where c.config_key=t.config_key and c.status='active' returning c.id
     ), retired_done as (
       select count(*) as count from retired
     ), activated as (
       update relay_commercial_config_versions c set status='active',activated_by=$2,activated_at=now(),retired_at=null,updated_at=now()
        from target t,retired_done d where c.id=t.id returning c.*
     ) select * from activated`,
    [id, actor.slice(0, 120)],
  );
  if (!rows[0]) throw new Error("CONFIG_VERSION_NOT_VALIDATED");
  await sql.query(
    `insert into relay_commercial_audit(id,actor_type,actor_id,action,target_type,target_id,detail)
     values ($1,'admin',$2,'config.activate','commercial_config',$3,$4::jsonb)`,
    [uid(), actor.slice(0, 120), id, JSON.stringify({ key: rows[0].config_key, version: rows[0].version })],
  );
  resetCommercialConfigCache();
  return publicVersion(rows[0]);
}

export async function listCommercialConfig(db?: DbLike) {
  const rows = await (await dbOrDefault(db)).query<Record<string, unknown>>(
    "select * from relay_commercial_config_versions order by config_key,version desc",
  );
  const byKey = new Map<string, ReturnType<typeof publicVersion>[]>();
  for (const row of rows) {
    const key = String(row.config_key);
    const versions = byKey.get(key) || [];
    versions.push(publicVersion(row));
    byKey.set(key, versions);
  }
  return COMMERCIAL_CONFIG_CATALOG.map((definition) => ({
    ...definition,
    envConfigured: Boolean(process.env[definition.envName]?.trim()),
    hardGateOpen: definition.hardGate ? process.env[definition.envName] === "1" : null,
    versions: byKey.get(definition.key) || [],
    active: (byKey.get(definition.key) || []).find((version) => version.status === "active") || null,
  }));
}

let effectiveCache: { at: number; rows: Record<string, unknown>[] } | null = null;

async function activeRows(db?: DbLike) {
  if (!db && effectiveCache && Date.now() - effectiveCache.at < 5_000) return effectiveCache.rows;
  const rows = await (await dbOrDefault(db)).query<Record<string, unknown>>(
    "select * from relay_commercial_config_versions where status='active'",
  );
  if (!db) effectiveCache = { at: Date.now(), rows };
  return rows;
}

function envValue(definition: CommercialConfigDefinition, value: unknown) {
  if (definition.kind === "boolean") return value ? "1" : "0";
  if (definition.kind === "json") return JSON.stringify(value || {});
  return String(value ?? "");
}

export async function effectiveCommercialEnv(baseEnv: NodeJS.ProcessEnv = process.env, db?: DbLike) {
  const result = { ...baseEnv };
  for (const row of await activeRows(db)) {
    const definition = definitions.get(String(row.config_key));
    if (!definition) continue;
    const value = row.secret_ciphertext ? decryptSecretValue(String(row.secret_ciphertext)) : row.value_json;
    if (definition.hardGate) {
      result[definition.envName] = baseEnv[definition.envName] === "1" && value === true ? "1" : "0";
    } else {
      result[definition.envName] = envValue(definition, value);
    }
  }
  return result;
}

export function resetCommercialConfigCache() {
  effectiveCache = null;
}
