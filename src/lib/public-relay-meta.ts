const PRIVATE_RELAY_META_KEYS = new Set([
  "accountEmail",
  "account_email",
  "workerId",
  "worker_id",
  "accountId",
  "account_id",
  "proxyId",
  "proxy_id",
]);

/**
 * Enforces the public API boundary for Relay's diagnostic extension object.
 * Account identity and internal topology stay available to server-side audit
 * logs, but must never be serialized to an API caller.
 */
export function publicRelayMeta<T extends Record<string, unknown>>(meta: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([key]) => !PRIVATE_RELAY_META_KEYS.has(key)));
}
