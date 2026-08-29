import { createHash, createSign } from "node:crypto";

export type VertexServiceAccount = {
  type: "service_account";
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseVertexServiceAccount(value: string) {
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(value)); } catch { throw new Error("VERTEX_SERVICE_ACCOUNT_JSON_INVALID"); }
  const credentials: VertexServiceAccount = {
    type: String(raw.type) as "service_account",
    project_id: String(raw.project_id || ""),
    private_key_id: String(raw.private_key_id || ""),
    private_key: String(raw.private_key || ""),
    client_email: String(raw.client_email || ""),
    token_uri: raw.token_uri ? String(raw.token_uri) : undefined,
  };
  if (credentials.type !== "service_account" || !/^[a-z][a-z0-9-]{4,62}$/.test(credentials.project_id) ||
      !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(credentials.client_email) ||
      !/^[a-f0-9]{20,80}$/i.test(credentials.private_key_id) || !credentials.private_key.includes("BEGIN PRIVATE KEY")) {
    throw new Error("VERTEX_SERVICE_ACCOUNT_FIELDS_INVALID");
  }
  if (credentials.token_uri && credentials.token_uri !== "https://oauth2.googleapis.com/token") {
    throw new Error("VERTEX_TOKEN_URI_FORBIDDEN");
  }
  return credentials;
}

export function validateVertexProjectLocation(project: string, location: string) {
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(project)) throw new Error("VERTEX_PROJECT_ID_INVALID");
  if (location !== "global" && !/^[a-z]+-[a-z]+[0-9]$/.test(location)) throw new Error("VERTEX_LOCATION_INVALID");
  return { project, location };
}

function jwtAssertion(credentials: VertexServiceAccount, nowSeconds: number) {
  const tokenUri = "https://oauth2.googleapis.com/token";
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: credentials.private_key_id })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: tokenUri,
    iat: nowSeconds - 30,
    exp: nowSeconds + 3300,
  })).toString("base64url");
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(credentials.private_key).toString("base64url")}`;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function vertexAccessToken(
  serviceAccountJson: string,
  opts: { fetcher?: typeof fetch; nowMs?: number; useCache?: boolean } = {},
) {
  const credentials = parseVertexServiceAccount(serviceAccountJson);
  const nowMs = opts.nowMs ?? Date.now();
  const cacheKey = createHash("sha256").update(`${credentials.client_email}:${credentials.private_key_id}:${credentials.private_key}`).digest("hex");
  const cached = tokenCache.get(cacheKey);
  if (opts.useCache !== false && cached && cached.expiresAt > nowMs + 60_000) return cached.token;
  const assertion = jwtAssertion(credentials, Math.floor(nowMs / 1000));
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await (opts.fetcher || fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const token = typeof body.access_token === "string" ? body.access_token : "";
  const expiresIn = Math.max(60, Math.min(3600, Number(body.expires_in || 0)));
  if (!response.ok || !token || body.token_type !== "Bearer") throw new Error(`VERTEX_OAUTH_FAILED:${response.status}`);
  if (opts.useCache !== false) tokenCache.set(cacheKey, { token, expiresAt: nowMs + expiresIn * 1000 });
  return token;
}

export function vertexGenerateContentEndpoint(project: string, location: string, model: string) {
  validateVertexProjectLocation(project, location);
  if (!/^[A-Za-z0-9._-]{2,200}$/.test(model)) throw new Error("VERTEX_MODEL_ID_INVALID");
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

export function resetVertexTokenCacheForTests() {
  tokenCache.clear();
}
