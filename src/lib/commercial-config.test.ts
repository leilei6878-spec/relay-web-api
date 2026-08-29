import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  activateCommercialConfigVersion,
  createCommercialConfigVersion,
  effectiveCommercialEnv,
  listCommercialConfig,
  resetCommercialConfigCache,
  testCommercialConfigVersion,
} from "./commercial-config.ts";
import { officialChat, resolveOfficialModel } from "./official-providers.ts";

process.env.RELAY_SECRETS_KEY ||= "commercial-config-unit-encryption-key";

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql",
    "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql", "0011_commercial_launch_evidence.sql",
  ]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return { pg, db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows } };
}

test("commercial secrets are encrypted, tested, activated, rotated and rolled back without disclosure", async () => {
  const { pg, db } = await database();
  const first = await createCommercialConfigVersion({ key: "providers.openai.apiKey", value: "first-unit-provider-key", reason: "initial", actor: "admin-a" }, db);
  assert.equal(first.secret, true);
  assert.equal(first.value, null);
  assert.match(String(first.secretHint), /^firs…-key$/);
  const stored = await pg.query<{ secret_ciphertext: string }>("select secret_ciphertext from relay_commercial_config_versions where id=$1", [first.id]);
  assert.match(stored.rows[0]!.secret_ciphertext, /^enc:v1:/);
  assert.ok(!stored.rows[0]!.secret_ciphertext.includes("first-unit-provider-key"));
  const testedFirst = await testCommercialConfigVersion(first.id, "admin-a", {
    db,
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://api.openai.com/v1/models");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer first-unit-provider-key");
      return Response.json({ object: "list", data: [{ id: "gpt-unit" }] });
    }) as typeof fetch,
  });
  assert.equal(testedFirst.validationStatus, "passed");
  await activateCommercialConfigVersion(first.id, "admin-b", db);
  let effective = await effectiveCommercialEnv({ OPENAI_API_KEY: "environment-key" } as NodeJS.ProcessEnv, db);
  assert.equal(effective.OPENAI_API_KEY, "first-unit-provider-key");
  const official = await officialChat(
    { resolved: resolveOfficialModel("openai:gpt-unit"), messages: [{ role: "user", content: "hello" }], tenantId: "tenant-config" },
    {
      db,
      fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer first-unit-provider-key");
        return Response.json({ id: "chatcmpl-config", model: "gpt-unit", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }) as typeof fetch,
    },
  );
  assert.equal(official.ok, true);

  const second = await createCommercialConfigVersion({ key: "providers.openai.apiKey", value: "second-unit-provider-key", reason: "rotation", actor: "admin-a" }, db);
  await testCommercialConfigVersion(second.id, "admin-a", { db, fetcher: (async () => Response.json({ data: [] })) as typeof fetch });
  await activateCommercialConfigVersion(second.id, "admin-b", db);
  effective = await effectiveCommercialEnv({ OPENAI_API_KEY: "environment-key" } as NodeJS.ProcessEnv, db);
  assert.equal(effective.OPENAI_API_KEY, "second-unit-provider-key");
  await activateCommercialConfigVersion(first.id, "admin-b", db);
  effective = await effectiveCommercialEnv({ OPENAI_API_KEY: "environment-key" } as NodeJS.ProcessEnv, db);
  assert.equal(effective.OPENAI_API_KEY, "first-unit-provider-key");
  const history = await listCommercialConfig(db);
  const openai = history.find((entry) => entry.key === "providers.openai.apiKey")!;
  assert.equal(openai.versions.length, 2);
  assert.ok(openai.versions.every((version) => version.value === null));
  assert.ok(!JSON.stringify(openai).includes("unit-provider-key"));
  await assert.rejects(() => pg.query("delete from relay_commercial_config_versions where id=$1", [first.id]), /append-only/);
  await assert.rejects(() => pg.query("update relay_commercial_config_versions set secret_ciphertext='changed' where id=$1", [first.id]), /immutable/);
  resetCommercialConfigCache();
  await pg.close();
});

test("hard gates require deployment authorization while safe values hot-reload", async () => {
  const { pg, db } = await database();
  const enabled = await createCommercialConfigVersion({ key: "commercial.enabled", value: true, reason: "desired launch", actor: "admin" }, db);
  await activateCommercialConfigVersion(enabled.id, "admin", db);
  const provider = await createCommercialConfigVersion({ key: "payments.provider", value: "stripe", reason: "payment selection", actor: "admin" }, db);
  await activateCommercialConfigVersion(provider.id, "admin", db);
  const closed = await effectiveCommercialEnv({ RELAY_COMMERCIAL_ENABLED: "0", RELAY_PAYMENT_PROVIDER: "disabled" } as NodeJS.ProcessEnv, db);
  assert.equal(closed.RELAY_COMMERCIAL_ENABLED, "0");
  assert.equal(closed.RELAY_PAYMENT_PROVIDER, "stripe");
  const opened = await effectiveCommercialEnv({ RELAY_COMMERCIAL_ENABLED: "1", RELAY_PAYMENT_PROVIDER: "disabled" } as NodeJS.ProcessEnv, db);
  assert.equal(opened.RELAY_COMMERCIAL_ENABLED, "1");
  await assert.rejects(
    () => createCommercialConfigVersion({ key: "email.webhookUrl", value: "http://insecure.test", reason: "bad", actor: "admin" }, db),
    /HTTPS_URL_REQUIRED/,
  );
  await assert.rejects(
    () => createCommercialConfigVersion({ key: "email.webhookUrl", value: "https://127.0.0.1/hook", reason: "bad", actor: "admin" }, db),
    /PRIVATE_ADDRESS_FORBIDDEN/,
  );
  await assert.rejects(
    () => createCommercialConfigVersion({ key: "providers.unknown.endpoint", value: "https://evil.test", reason: "bad", actor: "admin" }, db),
    /CONFIG_KEY_NOT_ALLOWED/,
  );
  await pg.close();
});

test("Webhook connection testing rejects DNS results that resolve into private networks", async () => {
  const { pg, db } = await database();
  const draft = await createCommercialConfigVersion({ key: "alerts.webhookUrl", value: "https://hooks.example.test/relay", reason: "SSRF test", actor: "admin" }, db);
  let fetched = false;
  const tested = await testCommercialConfigVersion(draft.id, "admin", {
    db,
    resolver: async () => [{ address: "10.0.0.7", family: 4 }],
    fetcher: (async () => { fetched = true; return Response.json({ ok: true }); }) as typeof fetch,
  });
  assert.equal(tested.validationStatus, "failed");
  assert.equal(fetched, false);
  const publicDraft = await createCommercialConfigVersion({ key: "alerts.webhookUrl", value: "https://hooks.example.test/relay", reason: "public test", actor: "admin" }, db);
  const publicTest = await testCommercialConfigVersion(publicDraft.id, "admin", {
    db,
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    fetcher: (async () => Response.json({ ok: true })) as typeof fetch,
  });
  assert.equal(publicTest.validationStatus, "passed");
  await pg.close();
});

test("connection tests use fixed official read-only endpoints and sanitize failures", async () => {
  const { pg, db } = await database();
  const cases = [
    ["providers.google.apiKey", "google-unit-key", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { models: [{ name: "models/gemini-unit" }] }],
    ["providers.leonardo.apiKey", "leonardo-unit-key", "https://cloud.leonardo.ai/api/rest/v2/models", { models: [{ id: "unit" }] }],
    ["payments.stripe.secretKey", "stripe-unit-key", "https://api.stripe.com/v1/balance", { object: "balance" }],
  ] as const;
  for (const [key, value, expectedUrl, response] of cases) {
    const version = await createCommercialConfigVersion({ key, value, reason: "connection", actor: "admin" }, db);
    const tested = await testCommercialConfigVersion(version.id, "admin", {
      db,
      fetcher: (async (url: string | URL | Request) => {
        assert.equal(String(url), expectedUrl);
        return Response.json(response);
      }) as typeof fetch,
    });
    assert.equal(tested.validationStatus, "passed");
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const vertexService = JSON.stringify({
    type: "service_account", project_id: "config-vertex-project", private_key_id: "c".repeat(40),
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    client_email: "relay@config-vertex-project.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token",
  });
  const vertex = await createCommercialConfigVersion({ key: "providers.vertex.serviceAccountJson", value: vertexService, reason: "Vertex connection", actor: "admin" }, db);
  const testedVertex = await testCommercialConfigVersion(vertex.id, "admin", {
    db,
    fetcher: (async (url: string | URL | Request) => {
      assert.equal(String(url), "https://oauth2.googleapis.com/token");
      return Response.json({ access_token: "vertex-config-token", token_type: "Bearer", expires_in: 3600 });
    }) as typeof fetch,
  });
  assert.equal(testedVertex.validationStatus, "passed");
  await activateCommercialConfigVersion(vertex.id, "admin", db);
  const vertexProject = await createCommercialConfigVersion({ key: "providers.vertex.projectId", value: "config-vertex-project", reason: "Vertex project", actor: "admin" }, db);
  const vertexLocation = await createCommercialConfigVersion({ key: "providers.vertex.location", value: "us-central1", reason: "Vertex location", actor: "admin" }, db);
  await activateCommercialConfigVersion(vertexProject.id, "admin", db);
  await activateCommercialConfigVersion(vertexLocation.id, "admin", db);
  let vertexCalls = 0;
  const dynamicVertex = await officialChat(
    { resolved: resolveOfficialModel("vertex:gemini-config"), messages: [{ role: "user", content: "hello" }], tenantId: "tenant-config" },
    {
      db,
      fetcher: (async (url: string | URL | Request) => {
        vertexCalls += 1;
        if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "dynamic-vertex-token", token_type: "Bearer", expires_in: 3600 });
        assert.equal(String(url), "https://us-central1-aiplatform.googleapis.com/v1/projects/config-vertex-project/locations/us-central1/publishers/google/models/gemini-config:generateContent");
        return Response.json({ candidates: [{ content: { parts: [{ text: "dynamic vertex" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
      }) as typeof fetch,
    },
  );
  assert.equal(dynamicVertex.ok, true);
  assert.equal(vertexCalls, 2);
  const failed = await createCommercialConfigVersion({ key: "providers.google.apiKey", value: "failing-google-key", reason: "failure", actor: "admin" }, db);
  const testedFailure = await testCommercialConfigVersion(failed.id, "admin", {
    db, fetcher: (async () => Response.json({ error: { message: "contains-sensitive-provider-detail" } }, { status: 401 })) as typeof fetch,
  });
  assert.equal(testedFailure.validationStatus, "failed");
  assert.ok(!JSON.stringify(testedFailure.testDetail).includes("contains-sensitive-provider-detail"));
  await pg.close();
});
