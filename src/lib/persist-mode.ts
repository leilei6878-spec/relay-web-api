import { isProduction, readEnv } from "./env-mode";

export type PersistenceMode = "file" | "postgres";

/**
 * Source of Truth selector.
 * Production always uses postgres. JSON is never a scheduling input there.
 * JSON remains valid for: migration import, test fixtures, development bootstrap.
 */
export function persistenceMode(env: NodeJS.ProcessEnv = process.env): PersistenceMode {
  if (isProduction() || env.NODE_ENV === "production") return "postgres";
  const forced = (env.RELAY_SOT || "").trim().toLowerCase();
  if (forced === "postgres") return "postgres";
  if (forced === "file") return "file";
  if (env.RELAY_SKIP_DB === "1") return "file";
  if (readEnv("DATABASE_URL", env) || readEnv("RELAY_SQL_HTTP_URL", env)) return "postgres";
  return "file";
}

export function jsonAllowedFor(
  purpose: "scheduling" | "import" | "fixture" | "bootstrap",
  env: NodeJS.ProcessEnv = process.env,
) {
  if (purpose === "scheduling") return persistenceMode(env) === "file";
  return true;
}

export function redisRequired(env: NodeJS.ProcessEnv = process.env) {
  return isProduction() || env.NODE_ENV === "production" || env.RELAY_REQUIRE_REDIS === "1";
}

/** True when this process must use Postgres row operations as the scheduling SoT. */
export function pgSotActive(env: NodeJS.ProcessEnv = process.env) {
  if (env.RELAY_SKIP_DB === "1") return false;
  if (persistenceMode(env) !== "postgres") return false;
  return Boolean(readEnv("DATABASE_URL", env) || readEnv("RELAY_SQL_HTTP_URL", env));
}
