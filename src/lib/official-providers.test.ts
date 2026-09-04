import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { officialChat, officialImage, resolveOfficialModel } from "./official-providers.ts";
import { resetVertexTokenCacheForTests } from "./vertex-auth.ts";

test("commercial models resolve only to official providers", () => {
  assert.deepEqual(resolveOfficialModel("openai:gpt-5-mini"), { provider: "openai", model: "gpt-5-mini", publicModel: "openai:gpt-5-mini" });
  assert.deepEqual(resolveOfficialModel("google/gemini-3.7-flash"), { provider: "google", model: "gemini-3.7-flash", publicModel: "google/gemini-3.7-flash" });
  assert.deepEqual(resolveOfficialModel("vertex:gemini-3.7-flash"), { provider: "vertex", model: "gemini-3.7-flash", publicModel: "vertex:gemini-3.7-flash" });
  assert.deepEqual(resolveOfficialModel("gpt-5-mini").provider, "openai");
  assert.throws(() => resolveOfficialModel("chatgpt-web-auto"), /MUST_BE_OFFICIAL/);
  assert.throws(() => resolveOfficialModel("chatgpt-llm-image"), /MUST_BE_OFFICIAL/);
});

test("Vertex official adapter exchanges a service-account JWT and uses the regional generateContent endpoint", async () => {
  resetVertexTokenCacheForTests();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const service = JSON.stringify({
    type: "service_account", project_id: "vertex-unit-project", private_key_id: "a".repeat(40),
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    client_email: "relay@vertex-unit-project.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token",
  });
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (String(url) === "https://oauth2.googleapis.com/token") {
      assert.match(String(init?.body), /jwt-bearer/);
      return Response.json({ access_token: "vertex-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    const expectedModel = calls === 2 ? "gemini-3.7-flash" : "gemini-image";
    assert.equal(String(url), `https://us-central1-aiplatform.googleapis.com/v1/projects/vertex-unit-project/locations/us-central1/publishers/google/models/${expectedModel}:generateContent`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer vertex-access-token");
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (calls === 2) {
      assert.ok(Array.isArray(sent.contents));
      return Response.json({ responseId: "v-chat", modelVersion: "gemini-3.7-flash-001", candidates: [{ content: { parts: [{ text: "vertex world" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 } });
    }
    return Response.json({ responseId: "v-image", modelVersion: "gemini-image", candidates: [{ content: { parts: [{ inlineData: { data: "image-bytes" } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } });
  }) as typeof fetch;
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: service, GOOGLE_CLOUD_PROJECT: "vertex-unit-project", GOOGLE_CLOUD_LOCATION: "us-central1" } as NodeJS.ProcessEnv;
  const chat = await officialChat(
    { resolved: resolveOfficialModel("vertex:gemini-3.7-flash"), messages: [{ role: "user", content: "hello" }], tenantId: "tenant" },
    { env, fetcher },
  );
  assert.equal(chat.ok, true, JSON.stringify(chat));
  if (chat.ok) assert.deepEqual([chat.provider, chat.text, chat.promptTokens, chat.completionTokens], ["vertex", "vertex world", 8, 3]);
  const image = await officialImage(
    { resolved: resolveOfficialModel("vertex:gemini-image"), prompt: "cat", n: 1, tenantId: "tenant" },
    { env, fetcher },
  );
  assert.equal(image.ok, true, JSON.stringify(image));
  if (image.ok) assert.deepEqual([image.provider, image.images[0]?.b64_json], ["vertex", "image-bytes"]);
  assert.equal(calls, 3);
});

test("OpenAI official chat uses server credential and authoritative usage", async () => {
  let request: RequestInit | undefined;
  const result = await officialChat(
    { resolved: resolveOfficialModel("openai:gpt-5-mini"), messages: [{ role: "user", content: "hello" }], tenantId: "tenant-secret" },
    {
      env: { OPENAI_API_KEY: "official-secret" } as NodeJS.ProcessEnv,
      fetcher: async (_url, init) => {
        request = init;
        return Response.json({ id: "chat-1", model: "gpt-5-mini", choices: [{ message: { role: "assistant", content: "world" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 7 } });
      },
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([result.text, result.promptTokens, result.completionTokens], ["world", 12, 7]);
  assert.equal(new Headers(request?.headers).get("authorization"), "Bearer official-secret");
  const sent = JSON.parse(String(request?.body));
  assert.equal(sent.store, false);
  assert.match(sent.user, /^tenant_[0-9a-f]{8}$/);
  assert.ok(!String(request?.body).includes("tenant-secret"));
});

test("Google official chat maps messages and usage metadata", async () => {
  const result = await officialChat(
    { resolved: resolveOfficialModel("google:gemini-3.7-flash"), messages: [{ role: "user", content: "hello" }], tenantId: "tenant" },
    {
      env: { GEMINI_API_KEY: "google-secret" } as NodeJS.ProcessEnv,
      fetcher: async (url, init) => {
        assert.match(String(url), /gemini-3.7-flash:generateContent/);
        assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "google-secret");
        return Response.json({ responseId: "g-1", modelVersion: "gemini-3.7-flash-001", candidates: [{ content: { parts: [{ text: "world" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } });
      },
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([result.text, result.promptTokens, result.completionTokens], ["world", 9, 4]);
});

test("official image adapters validate exact result count", async () => {
  const result = await officialImage(
    { resolved: resolveOfficialModel("openai:gpt-image-1"), prompt: "cat", n: 2, tenantId: "tenant" },
    { env: { OPENAI_API_KEY: "secret" } as NodeJS.ProcessEnv, fetcher: async () => Response.json({ data: [{ b64_json: "aaa" }, { b64_json: "bbb" }] }) },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.images.length, 2);
  const missing = await officialImage(
    { resolved: resolveOfficialModel("openai:gpt-image-1"), prompt: "cat", n: 2, tenantId: "tenant" },
    { env: { OPENAI_API_KEY: "secret" } as NodeJS.ProcessEnv, fetcher: async () => Response.json({ data: [{ b64_json: "aaa" }] }) },
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "RESULT_COUNT_MISMATCH");
});

test("Leonardo official adapter creates and polls the documented v1 generation", async () => {
  let calls = 0;
  const modelId = "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3";
  const result = await officialImage(
    { resolved: resolveOfficialModel(`leonardo:${modelId}`), prompt: "cat", n: 1, size: "1024x1024", tenantId: "tenant" },
    {
      env: { LEONARDO_API_KEY: "secret", LEONARDO_POLL_MS: "10" } as NodeJS.ProcessEnv,
      timeoutMs: 10_000,
      fetcher: async (url, init) => {
        calls += 1;
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
        if (calls === 1) {
          assert.equal(String(url), "https://cloud.leonardo.ai/api/rest/v1/generations");
          return Response.json({ sdGenerationJob: { generationId: "12345678-1234-4123-8123-123456789012" } });
        }
        return Response.json({ generations_by_pk: { status: "COMPLETE", generated_images: [{ url: "https://cdn.example/image.png" }] } });
      },
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.images[0]?.url, "https://cdn.example/image.png");
});
