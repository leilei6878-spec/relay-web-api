import { mockModeEnabled, readEnv } from "./env-mode";
import { releaseIdentity } from "./release";

export type CheckId =
  | "database"
  | "redis"
  | "secret_store"
  | "media_store"
  | "worker"
  | "migrations"
  | "admin_auth"
  | "provider_config"
  | "encryption_key"
  | "release_identity";

export type CheckStatus = "ok" | "missing" | "degraded" | "forbidden";

export type CheckItem = {
  id: CheckId;
  required: boolean;
  status: CheckStatus;
  detail: string;
};

export type ProductionReadinessReport = {
  production: boolean;
  ready: boolean;
  mockForbidden: boolean;
  blockers: string[];
  items: CheckItem[];
};

const REQUIRED_IN_PRODUCTION: CheckId[] = [
  "database",
  "redis",
  "secret_store",
  "media_store",
  "worker",
  "migrations",
  "admin_auth",
  "provider_config",
  "encryption_key",
  "release_identity",
];

function item(
  id: CheckId,
  production: boolean,
  status: CheckStatus,
  okDetail: string,
  badDetail: string,
): CheckItem {
  const required = production && REQUIRED_IN_PRODUCTION.includes(id);
  return {
    id,
    required,
    status: status === "ok" ? "ok" : status,
    detail: status === "ok" ? okDetail : badDetail,
  };
}

/** Pure env check. Safe to call from tests without opening sockets. */
export function runProductionReadinessCheck(env: NodeJS.ProcessEnv = process.env): ProductionReadinessReport {
  const production = (env.NODE_ENV || "").trim().toLowerCase() === "production";
  const db = readEnv("DATABASE_URL", env);
  const redis = readEnv("REDIS_URL", env);
  const admin = readEnv("RELAY_ADMIN_TOKEN", env);
  const worker = readEnv("RELAY_WORKER_TOKEN", env);
  const s3Bucket = readEnv("RELAY_S3_BUCKET", env);
  const s3Key = readEnv("RELAY_S3_ACCESS_KEY", env) || readEnv("AWS_ACCESS_KEY_ID", env);
  const s3Secret = readEnv("RELAY_S3_SECRET_KEY", env) || readEnv("AWS_SECRET_ACCESS_KEY", env);
  const enc = readEnv("RELAY_SECRETS_KEY", env);
  const mock = mockModeEnabled(env);
  const mediaOk = Boolean(s3Bucket && s3Key && s3Secret);
  const chatgpt = readEnv("RELAY_PROVIDER_CHATGPT", env) !== "off";
  const gemini = readEnv("RELAY_PROVIDER_GEMINI", env) !== "off";
  const providerOk = chatgpt && gemini && !mock;
  const release = releaseIdentity(env);

  const items: CheckItem[] = [
    item(
      "database",
      production,
      db ? "ok" : production ? "missing" : "degraded",
      "DATABASE_URL set (Postgres)",
      production ? "DATABASE_URL missing — PGLite fallback is forbidden" : "PGLite / file fallback allowed in non-production",
    ),
    item(
      "redis",
      production,
      redis ? "ok" : production ? "missing" : "degraded",
      "REDIS_URL set",
      production ? "REDIS_URL missing — memory lock fallback is forbidden" : "in-process memory coord allowed in non-production",
    ),
    item(
      "secret_store",
      production,
      admin && worker && enc ? "ok" : production ? "missing" : "degraded",
      "Admin + worker tokens + RELAY_SECRETS_KEY provided via env",
      production
        ? "RELAY_ADMIN_TOKEN, RELAY_WORKER_TOKEN and RELAY_SECRETS_KEY must be set (file mint forbidden)"
        : "dev may mint tokens into storage/*.txt",
    ),
    item(
      "encryption_key",
      production,
      enc ? "ok" : production ? "missing" : "degraded",
      "RELAY_SECRETS_KEY set",
      production ? "RELAY_SECRETS_KEY required; plaintext secrets.json is forbidden" : "dev may store plaintext secrets",
    ),
    item(
      "media_store",
      production,
      mediaOk ? "ok" : production ? "missing" : "degraded",
      "Object storage configured (S3/R2/OSS/MinIO)",
      production
        ? "RELAY_S3_BUCKET + access key/secret required; local disk is not production-stable"
        : "LocalMediaStore allowed in non-production",
    ),
    item(
      "worker",
      production,
      worker ? "ok" : production ? "missing" : "degraded",
      "RELAY_WORKER_TOKEN set",
      production ? "Worker secret infrastructure incomplete" : "dev may mint worker token",
    ),
    item(
      "migrations",
      production,
      db ? "ok" : production ? "missing" : "degraded",
      "migrations applied against Postgres at deploy (npm run db:migrate)",
      production ? "Cannot migrate without DATABASE_URL" : "PGLite applies migrations/*.sql in preview",
    ),
    item(
      "admin_auth",
      production,
      admin ? "ok" : production ? "missing" : "degraded",
      "RELAY_ADMIN_TOKEN set",
      production ? "Admin secret missing" : "dev may mint admin token",
    ),
    item(
      "provider_config",
      production,
      providerOk ? "ok" : production ? (mock ? "forbidden" : "missing") : mock ? "degraded" : "ok",
      "ChatGPT + Gemini provider config enabled",
      production
        ? mock
          ? "Mock/Test/Demo mode is forbidden in production"
          : "Provider config disabled"
        : "Mock mode allowed in non-production",
    ),
    item(
      "release_identity",
      production,
      release.commit !== "unknown" ? "ok" : production ? "missing" : "degraded",
      `Release commit ${release.commit}`,
      production
        ? "RELAY_RELEASE_SHA (or a supported platform commit SHA) must identify the deployed commit"
        : "Commit identity unavailable in this development process",
    ),
  ];

  if (mock && production) {
    const has = items.find((i) => i.id === "provider_config" && i.status === "forbidden");
    if (!has) {
      items.push({
        id: "provider_config",
        required: true,
        status: "forbidden",
        detail: "Mock/Test/Demo mode is forbidden in production (RELAY_ALLOW_MOCK / RELAY_DEMO_MODE / RELAY_TEST_URL=self)",
      });
    }
  }

  const blockers = items
    .filter((i) => i.required && i.status !== "ok")
    .map((i) => `${i.id}: ${i.detail}`);
  if (production && mock) {
    const msg = "mock: Mock/Test mode is forbidden in production";
    if (!blockers.includes(msg)) blockers.push(msg);
  }

  return {
    production,
    ready: blockers.length === 0,
    mockForbidden: production && mock,
    blockers,
    items,
  };
}

export function assertProductionFailClosed(env: NodeJS.ProcessEnv = process.env) {
  if ((env.NODE_ENV || "").trim().toLowerCase() !== "production") return;
  const report = runProductionReadinessCheck(env);
  if (!report.ready) {
    const text = report.blockers.join("; ");
    throw new Error(`PRODUCTION_FAIL_CLOSED: ${text}`);
  }
}

let booted = false;

/** Call from server request paths. No-op in development. Throws in production if not ready. */
export function bootProductionGuard() {
  if (booted) return;
  booted = true;
  assertProductionFailClosed();
  if (process.env.RELAY_TEST !== "1") {
    void import("./provider-canary-scheduler").then((m) => m.startProviderCanaryScheduler()).catch(() => undefined);
    void import("./account-check-scheduler").then((m) => m.startAccountCheckScheduler()).catch(() => undefined);
    void import("./account-analytics").then((m) => m.startAvailabilitySnapshotScheduler()).catch(() => undefined);
    void import("./account-inspections").then((m) => m.startInspectionCleanupScheduler()).catch(() => undefined);
    void import("./commercial-monitor").then((m) => m.startCommercialMonitor()).catch(() => undefined);
    void import("./data-retention").then((m) => m.startDataRetentionScheduler()).catch(() => undefined);
  }
}

export function resetProductionGuardForTests() {
  booted = false;
}
