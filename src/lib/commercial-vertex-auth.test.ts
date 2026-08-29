import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import {
  parseVertexServiceAccount,
  resetVertexTokenCacheForTests,
  vertexAccessToken,
  vertexGenerateContentEndpoint,
} from "./vertex-auth.ts";

function serviceAccount() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const json = JSON.stringify({
    type: "service_account", project_id: "vertex-auth-project", private_key_id: "b".repeat(40),
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    client_email: "relay@vertex-auth-project.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token",
  });
  return { json, publicKey };
}

test("Vertex service-account OAuth signs a bounded RS256 assertion and caches only the access token", async () => {
  resetVertexTokenCacheForTests();
  const { json, publicKey } = serviceAccount();
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [headerRaw, claimsRaw, signatureRaw] = form.get("assertion")!.split(".");
    const header = JSON.parse(Buffer.from(headerRaw!, "base64url").toString()) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(claimsRaw!, "base64url").toString()) as Record<string, unknown>;
    assert.deepEqual([header.alg, header.typ], ["RS256", "JWT"]);
    assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
    assert.equal(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
    assert.ok(Number(claims.exp) - Number(claims.iat) <= 3600);
    assert.equal(verify("RSA-SHA256", Buffer.from(`${headerRaw}.${claimsRaw}`), publicKey, Buffer.from(signatureRaw!, "base64url")), true);
    return Response.json({ access_token: "short-lived-access", token_type: "Bearer", expires_in: 3600 });
  }) as typeof fetch;
  const first = await vertexAccessToken(json, { fetcher, nowMs: 2_000_000_000_000 });
  const second = await vertexAccessToken(json, { fetcher, nowMs: 2_000_000_010_000 });
  assert.equal(first, "short-lived-access");
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test("Vertex credentials and endpoint construction reject arbitrary token or service URLs", () => {
  const { json } = serviceAccount();
  assert.equal(parseVertexServiceAccount(json).project_id, "vertex-auth-project");
  const changed = JSON.stringify({ ...JSON.parse(json), token_uri: "https://attacker.example/token" });
  assert.throws(() => parseVertexServiceAccount(changed), /TOKEN_URI_FORBIDDEN/);
  assert.equal(
    vertexGenerateContentEndpoint("vertex-auth-project", "global", "gemini-3.7-flash"),
    "https://aiplatform.googleapis.com/v1/projects/vertex-auth-project/locations/global/publishers/google/models/gemini-3.7-flash:generateContent",
  );
  assert.throws(() => vertexGenerateContentEndpoint("bad/project", "us-central1", "model"), /PROJECT_ID_INVALID/);
  assert.throws(() => vertexGenerateContentEndpoint("vertex-auth-project", "https://evil", "model"), /LOCATION_INVALID/);
});
