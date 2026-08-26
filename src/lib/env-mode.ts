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

export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env) {
  const v = env[name];
  return v && v.trim() ? v.trim() : "";
}
