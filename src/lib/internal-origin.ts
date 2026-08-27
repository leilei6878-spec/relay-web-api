/** Loopback origin for server-side nested fetches. Never reuse the public preview URL. */
export function internalGatewayOrigin(requestUrl?: string) {
  const env = (process.env.RELAY_INTERNAL_ORIGIN || "").trim().replace(/\/$/, "");
  if (env) return env;
  if (requestUrl) {
    try {
      const u = new URL(requestUrl);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return u.origin;
    } catch {
      /* ignore */
    }
  }
  const port = process.env.PORT || "8080";
  return `http://127.0.0.1:${port}`;
}
