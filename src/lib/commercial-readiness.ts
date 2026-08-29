import { getSql, type Sql } from "./db";

export type CommercialReadiness = {
  enabled: boolean;
  ready: boolean;
  blockers: string[];
  officialProviders: { openai: boolean; google: boolean; leonardo: boolean };
  activePrices: number;
  onlineWorkers: number;
  gatewayReplicas: number;
  offsiteBackupConfigured: boolean;
  legalApproved: boolean;
  registrationEnabled: boolean;
};

export async function commercialReadiness(env: NodeJS.ProcessEnv = process.env, db?: Pick<Sql, "query">): Promise<CommercialReadiness> {
  const enabled = env.RELAY_COMMERCIAL_ENABLED === "1";
  const officialProviders = {
    openai: Boolean(env.OPENAI_API_KEY?.trim()),
    google: Boolean(env.GEMINI_API_KEY?.trim() || (env.GOOGLE_CLOUD_PROJECT?.trim() && env.GOOGLE_APPLICATION_CREDENTIALS?.trim())),
    leonardo: Boolean(env.LEONARDO_API_KEY?.trim()),
  };
  let activePrices = 0;
  let onlineWorkers = 0;
  try {
    const sql = db || await getSql();
    const rows = await sql.query<{ count: number }>(
      "select count(*)::int as count from relay_price_book where status='active' and effective_from <= now() and (effective_to is null or effective_to > now())",
    );
    activePrices = Number(rows[0]?.count || 0);
    const workers = await sql.query<{ count: number }>(
      "select count(*)::int as count from relay_workers where draining=false and last_beat > now()-interval '45 seconds'",
    );
    onlineWorkers = Number(workers[0]?.count || 0);
  } catch {
    activePrices = 0;
    onlineWorkers = 0;
  }
  const gatewayReplicas = Math.max(1, Number(env.RELAY_GATEWAY_REPLICA_COUNT || 1));
  const minWorkers = Math.max(1, Number(env.RELAY_COMMERCIAL_MIN_WORKERS || 2));
  const offsiteBackupConfigured = Boolean(env.RELAY_BACKUP_S3_ENDPOINT?.trim() && env.RELAY_BACKUP_S3_BUCKET?.trim());
  const legalApproved = env.RELAY_LEGAL_APPROVED === "1";
  const blockers: string[] = [];
  if (enabled && !Object.values(officialProviders).some(Boolean)) blockers.push("no official provider credential configured");
  if (enabled && activePrices === 0) blockers.push("no active commercial price book rows");
  if (enabled && !env.RELAY_PUBLIC_URL?.startsWith("https://")) blockers.push("RELAY_PUBLIC_URL must be HTTPS");
  if (enabled && !env.REDIS_URL?.trim()) blockers.push("Redis required for commercial rate/concurrency limits");
  if (enabled && onlineWorkers < minWorkers) blockers.push(`online workers ${onlineWorkers}/${minWorkers}`);
  if (enabled && gatewayReplicas < 2) blockers.push("at least two gateway replicas required");
  if (enabled && !offsiteBackupConfigured) blockers.push("offsite backup target not configured");
  if (enabled && !legalApproved) blockers.push("commercial legal approval not recorded");
  if (enabled && env.RELAY_SAAS_REGISTRATION_ENABLED === "1" && !env.RELAY_EMAIL_WEBHOOK_URL?.trim()) blockers.push("email verification delivery not configured");
  return {
    enabled,
    ready: enabled && blockers.length === 0,
    blockers,
    officialProviders,
    activePrices,
    onlineWorkers,
    gatewayReplicas,
    offsiteBackupConfigured,
    legalApproved,
    registrationEnabled: enabled && env.RELAY_SAAS_REGISTRATION_ENABLED === "1",
  };
}

let cached: { at: number; value: CommercialReadiness } | null = null;

export async function cachedCommercialReadiness(env: NodeJS.ProcessEnv = process.env) {
  if (cached && Date.now() - cached.at < 10_000) return cached.value;
  const value = await commercialReadiness(env);
  cached = { at: Date.now(), value };
  return value;
}

export function resetCommercialReadinessCacheForTests() {
  cached = null;
}
