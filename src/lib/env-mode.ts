/** Environment classification. Production is fail-closed; preview/dev/test may degrade. */

export function nodeEnv() {
  return (process.env.NODE_ENV || "").trim().toLowerCase();
}

export function isProduction() {
  return nodeEnv() === "production";
}

export function isTestEnv() {
  return nodeEnv() === "test" || process.env.RELAY_TEST === "1" || process.env.RELAY_SKIP_DB === "1";
}

export function mockModeEnabled(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.RELAY_ALLOW_MOCK === "1" ||
    env.RELAY_DEMO_MODE === "true" ||
    env.RELAY_TEST_MODE === "1" ||
    env.RELAY_TEST_URL === "self"
  );
}

/** Canonical names plus the production-config-contract aliases from .env.example. */
const ALIASES: Record<string, string[]> = {
  RELAY_ADMIN_TOKEN: ["ADMIN_SECRET"],
  RELAY_WORKER_TOKEN: ["WORKER_SIGNING_KEY"],
  RELAY_SECRETS_KEY: ["SESSION_ENCRYPTION_KEY"],
  RELAY_PUBLIC_URL: ["PUBLIC_BASE_URL"],
  RELAY_S3_BUCKET: ["S3_BUCKET"],
  RELAY_S3_ENDPOINT: ["S3_ENDPOINT"],
  RELAY_S3_REGION: ["S3_REGION"],
  RELAY_S3_ACCESS_KEY: ["S3_ACCESS_KEY", "AWS_ACCESS_KEY_ID"],
  RELAY_S3_SECRET_KEY: ["S3_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"],
  RELAY_S3_PUBLIC_BASE: ["S3_PUBLIC_BASE"],
};

export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env) {
  const keys = [name, ...(ALIASES[name] || [])];
  for (const k of keys) {
    const v = env[k];
    if (v && v.trim()) return v.trim();
  }
  return "";
}
