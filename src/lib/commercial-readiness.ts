import { getSql, type Sql } from "./db";
import { effectiveCommercialEnv } from "./commercial-config";
import { commercialEvidenceStatus } from "./commercial-evidence";
import { parseVertexServiceAccount, validateVertexProjectLocation } from "./vertex-auth";
import { adminMfaConfigured as validAdminMfaConfig } from "./admin-password";

export type CommercialReadiness = {
  enabled: boolean;
  ready: boolean;
  blockers: string[];
  officialProviders: { openai: boolean; google: boolean; vertex: boolean; leonardo: boolean };
  activeProviders: string[];
  missingProviderCredentials: string[];
  activePrices: number;
  missingCanaries: number;
  evidenceTotal: number;
  missingEvidence: string[];
  onlineWorkers: number;
  gatewayReplicas: number;
  offsiteBackupConfigured: boolean;
  legalApproved: boolean;
  adminMfaRequired: boolean;
  adminMfaConfigured: boolean;
  customerPrivilegedMfaRequired: boolean;
  tenantAuditConfigured: boolean;
  alertDeliveryConfigured: boolean;
  registrationEnabled: boolean;
  paymentProvider: string;
  paymentReady: boolean;
  taxMode: string;
};

function validOffsiteTarget(env: NodeJS.ProcessEnv) {
  const endpoint = env.RELAY_BACKUP_S3_ENDPOINT?.trim() || "";
  const bucket = env.RELAY_BACKUP_S3_BUCKET?.trim() || "";
  if (!endpoint || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) return false;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname || !["", "/"].includes(parsed.pathname)) return false;
    const normalized = parsed.toString().replace(/\/$/, "");
    const sourceEndpoint = (env.RELAY_S3_ENDPOINT || "").trim().replace(/\/$/, "");
    const sourceBucket = (env.RELAY_S3_BUCKET || "").trim();
    return normalized !== sourceEndpoint || bucket !== sourceBucket;
  } catch {
    return false;
  }
}

export async function commercialReadiness(env: NodeJS.ProcessEnv = process.env, db?: Pick<Sql, "query">): Promise<CommercialReadiness> {
  if (env === process.env) env = await effectiveCommercialEnv(env, db);
  const enabled = env.RELAY_COMMERCIAL_ENABLED === "1";
  let vertexConfigured = false;
  try {
    const service = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || "";
    const credentials = parseVertexServiceAccount(service);
    validateVertexProjectLocation(env.GOOGLE_CLOUD_PROJECT?.trim() || credentials.project_id, env.GOOGLE_CLOUD_LOCATION?.trim() || "us-central1");
    vertexConfigured = true;
  } catch {
    vertexConfigured = false;
  }
  const officialProviders = {
    openai: Boolean(env.OPENAI_API_KEY?.trim()),
    google: Boolean(env.GEMINI_API_KEY?.trim()),
    vertex: vertexConfigured,
    leonardo: Boolean(env.LEONARDO_API_KEY?.trim()),
  };
  let activePrices = 0;
  let activeProviders: string[] = [];
  let missingCanaries = 0;
  let evidenceTotal = 0;
  let missingEvidence: string[] = [];
  let evidenceUnavailable = false;
  let onlineWorkers = 0;
  try {
    const sql = db || await getSql();
    const rows = await sql.query<{ count: number }>(
      "select count(*)::int as count from relay_price_book where status='active' and effective_from <= now() and (effective_to is null or effective_to > now())",
    );
    activePrices = Number(rows[0]?.count || 0);
    const providerRows = await sql.query<{ provider: string }>(
      "select distinct provider from relay_price_book where status='active' and effective_from<=now() and (effective_to is null or effective_to>now()) order by provider",
    );
    activeProviders = providerRows.map((row) => String(row.provider));
    const canaryHours = Math.max(1, Math.min(168, Number(env.RELAY_PROVIDER_CANARY_MAX_AGE_HOURS || 24)));
    const canaries = await sql.query<{ count: number }>(
      `select count(*)::int as count from relay_price_book p
        where p.status='active' and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now())
          and not exists (
            select 1 from relay_provider_sandbox_runs r
             where r.provider=p.provider and r.model=p.model and r.capability=p.capability and r.currency=p.currency
               and r.mode='live' and r.status='passed'
               and r.finished_at > now()-($1::text||' hours')::interval
          )`,
      [canaryHours],
    );
    missingCanaries = Number(canaries[0]?.count || 0);
    const workers = await sql.query<{ count: number }>(
      "select count(*)::int as count from relay_workers where draining=false and last_beat > now()-interval '45 seconds'",
    );
    onlineWorkers = Number(workers[0]?.count || 0);
    const evidence = await commercialEvidenceStatus(env, sql);
    evidenceTotal = evidence.length;
    missingEvidence = evidence.filter((item) => !item.valid).map((item) => `${item.requirement}:${item.subject}:${item.reason}`);
  } catch {
    activePrices = 0;
    activeProviders = [];
    missingCanaries = 0;
    evidenceTotal = 0;
    missingEvidence = [];
    evidenceUnavailable = true;
    onlineWorkers = 0;
  }
  const gatewayReplicas = Math.max(1, Number(env.RELAY_GATEWAY_REPLICA_COUNT || 1));
  const missingProviderCredentials = activeProviders.filter((provider) => !officialProviders[provider as keyof typeof officialProviders]);
  const minWorkers = Math.max(1, Number(env.RELAY_COMMERCIAL_MIN_WORKERS || 2));
  const offsiteBackupConfigured = validOffsiteTarget(env);
  const legalApproved = env.RELAY_LEGAL_APPROVED === "1";
  const adminMfaRequired = env.RELAY_REQUIRE_ADMIN_MFA === "1";
  const adminMfaConfigured = validAdminMfaConfig(env);
  const customerPrivilegedMfaRequired = env.RELAY_REQUIRE_PRIVILEGED_SAAS_MFA === "1";
  const tenantAuditConfigured = (env.RELAY_AUDIT_HASH_KEY?.trim() || env.RELAY_SECRETS_KEY?.trim() || "").length >= 32;
  let alertDeliveryConfigured = false;
  try {
    const alertUrl = new URL(env.RELAY_ALERT_WEBHOOK_URL?.trim() || "");
    alertDeliveryConfigured = alertUrl.protocol === "https:" && !alertUrl.username && !alertUrl.password &&
      !alertUrl.search && !alertUrl.hash && Boolean(alertUrl.hostname) &&
      (env.RELAY_ALERT_WEBHOOK_SECRET?.trim() || "").length >= 32;
  } catch {
    alertDeliveryConfigured = false;
  }
  const paymentProvider = (env.RELAY_PAYMENT_PROVIDER || "disabled").trim();
  const stripeSecret = env.STRIPE_SECRET_KEY?.trim() || "";
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || "";
  const stripeLiveKey = /^(sk|rk)_live_/.test(stripeSecret);
  const taxMode = (env.RELAY_TAX_MODE || "unconfigured").trim();
  const taxReady = ["stripe_automatic", "approved_exempt"].includes(taxMode);
  const paymentReady = paymentProvider === "stripe" && Boolean(stripeSecret && stripeWebhookSecret) &&
    (env.NODE_ENV !== "production" || stripeLiveKey) && taxReady;
  const blockers: string[] = [];
  if (enabled && !Object.values(officialProviders).some(Boolean)) blockers.push("no official provider credential configured");
  if (enabled && missingProviderCredentials.length > 0) blockers.push(`official credential missing for active provider(s): ${missingProviderCredentials.join(",")}`);
  if (enabled && activePrices === 0) blockers.push("no active commercial price book rows");
  if (enabled && missingCanaries > 0) blockers.push(`${missingCanaries} active price route(s) lack recent live provider canary evidence`);
  if (enabled && evidenceUnavailable) blockers.push("commercial launch evidence ledger unavailable");
  if (enabled && !evidenceUnavailable && missingEvidence.length > 0) blockers.push(`${missingEvidence.length} commercial launch evidence requirement(s) missing, failed, revoked or expired`);
  if (enabled && !env.RELAY_PUBLIC_URL?.startsWith("https://")) blockers.push("RELAY_PUBLIC_URL must be HTTPS");
  if (enabled && !env.REDIS_URL?.trim()) blockers.push("Redis required for commercial rate/concurrency limits");
  if (enabled && onlineWorkers < minWorkers) blockers.push(`online workers ${onlineWorkers}/${minWorkers}`);
  if (enabled && gatewayReplicas < 2) blockers.push("at least two gateway replicas required");
  if (enabled && !offsiteBackupConfigured) blockers.push("offsite backup target not configured");
  if (enabled && !legalApproved) blockers.push("commercial legal approval not recorded");
  if (enabled && !adminMfaRequired) blockers.push("administrator MFA hard gate not enabled");
  if (enabled && !adminMfaConfigured) blockers.push("administrator TOTP secret missing or invalid");
  if (enabled && !customerPrivilegedMfaRequired) blockers.push("privileged customer MFA hard gate not enabled");
  if (enabled && !tenantAuditConfigured) blockers.push("tenant audit HMAC key missing or shorter than 32 characters");
  if (enabled && !alertDeliveryConfigured) blockers.push("signed alert Webhook delivery not configured");
  if (enabled && paymentProvider !== "stripe") blockers.push("Stripe payment provider not configured");
  if (enabled && paymentProvider === "stripe" && (!stripeSecret || !stripeWebhookSecret)) blockers.push("Stripe API or webhook secret missing");
  if (enabled && env.NODE_ENV === "production" && paymentProvider === "stripe" && !stripeLiveKey) blockers.push("Stripe live restricted/secret key required");
  if (enabled && !taxReady) blockers.push("tax mode requires Stripe Tax or documented approved exemption");
  if (enabled && env.RELAY_SAAS_REGISTRATION_ENABLED === "1" && !env.RELAY_EMAIL_WEBHOOK_URL?.trim()) blockers.push("email verification delivery not configured");
  return {
    enabled,
    ready: enabled && blockers.length === 0,
    blockers,
    officialProviders,
    activeProviders,
    missingProviderCredentials,
    activePrices,
    missingCanaries,
    evidenceTotal,
    missingEvidence,
    onlineWorkers,
    gatewayReplicas,
    offsiteBackupConfigured,
    legalApproved,
    adminMfaRequired,
    adminMfaConfigured,
    customerPrivilegedMfaRequired,
    tenantAuditConfigured,
    alertDeliveryConfigured,
    registrationEnabled: enabled && env.RELAY_SAAS_REGISTRATION_ENABLED === "1",
    paymentProvider,
    paymentReady,
    taxMode,
  };
}

let cached: { at: number; value: CommercialReadiness } | null = null;

export async function cachedCommercialReadiness(env: NodeJS.ProcessEnv = process.env) {
  if (cached && Date.now() - cached.at < 5_000) return cached.value;
  const value = await commercialReadiness(env);
  cached = { at: Date.now(), value };
  return value;
}

export function resetCommercialReadinessCacheForTests() {
  cached = null;
}
