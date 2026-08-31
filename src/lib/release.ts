/** Release identity. Bump SCHEMA_VERSION when adding migrations/*.sql. */

export const APP_VERSION = "0.10.0-rc24";
export const API_VERSION = "v1";
export const SCHEMA_VERSION = 24;
export const SELECTOR_PACK = {
  chatgpt: "chatgpt-v1",
  gemini: "gemini-v1",
} as const;

function commitFromEnv(env: NodeJS.ProcessEnv) {
  const value = (
    env.RELAY_RELEASE_SHA ||
    env.VERCEL_GIT_COMMIT_SHA ||
    env.GITHUB_SHA ||
    env.SOURCE_VERSION ||
    env.COMMIT_SHA ||
    ""
  ).trim();
  return /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : "unknown";
}

function timeFromEnv(env: NodeJS.ProcessEnv) {
  const value = (env.RELAY_BUILD_TIME || env.VERCEL_GIT_COMMIT_DATE || "").trim();
  if (!value) return "unknown";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "unknown";
}

export function releaseIdentity(env: NodeJS.ProcessEnv = process.env) {
  return {
    version: APP_VERSION,
    api: API_VERSION,
    schema: SCHEMA_VERSION,
    commit: commitFromEnv(env),
    buildTime: timeFromEnv(env),
  } as const;
}
