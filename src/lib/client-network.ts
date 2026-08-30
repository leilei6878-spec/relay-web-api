import { isIP } from "node:net";

export const TRUSTED_CLIENT_IP_HEADERS = ["x-real-ip", "x-forwarded-for", "cf-connecting-ip"] as const;
export type TrustedClientIpHeader = typeof TRUSTED_CLIENT_IP_HEADERS[number];

function configuredHeader(env: NodeJS.ProcessEnv): TrustedClientIpHeader | null {
  const production = (env.NODE_ENV || "").trim().toLowerCase() === "production";
  const trusted = env.RELAY_TRUST_PROXY_HEADERS === "1";
  if (production && !trusted) return null;
  if (!production && env.RELAY_TRUST_PROXY_HEADERS === "0") return null;
  const raw = (env.RELAY_CLIENT_IP_HEADER || (production ? "" : "x-real-ip")).trim().toLowerCase();
  return TRUSTED_CLIENT_IP_HEADERS.includes(raw as TrustedClientIpHeader) ? raw as TrustedClientIpHeader : null;
}

export function trustedProxyNetworkConfigured(env: NodeJS.ProcessEnv = process.env) {
  return env.RELAY_TRUST_PROXY_HEADERS === "1" && configuredHeader(env) !== null;
}

function canonicalIp(raw: string) {
  let value = raw.trim().replace(/^"|"$/g, "");
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.toLowerCase().startsWith("::ffff:")) {
    const mapped = value.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }
  return isIP(value) ? value.toLowerCase() : "unknown";
}

/**
 * Resolve client identity only from the one header that the deployment's
 * trusted edge is configured to overwrite. Competing forwarding headers are
 * intentionally ignored so a client cannot inject a higher-priority value.
 */
export function trustedClientIp(request: Request, env: NodeJS.ProcessEnv = process.env) {
  const header = configuredHeader(env);
  if (!header) return "unknown";
  const raw = request.headers.get(header) || "";
  const candidate = header === "x-forwarded-for" ? raw.split(",", 1)[0]! : raw;
  return canonicalIp(candidate).slice(0, 128);
}

