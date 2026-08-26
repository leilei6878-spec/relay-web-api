import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, FAILURE_MATRIX, normalizeError } from "../fault-matrix.ts";
import { eligibilityReason, listEligible } from "../eligibility.ts";
import { getAdapter } from "./index.ts";
import { detectPageState, errorForPageState } from "./page-state.ts";
import { accountEligibleForModel, leonardoAdapter } from "./leonardo.ts";
import {
  accountHasLeonardoModel,
  mapLogicalModel,
  pickGeminiLabel,
  sizeToAspect,
  validateLeonardoParams,
} from "./leonardo-models.ts";
import { packFor } from "./selectors.ts";
import type { Account, GatewaySettings, Proxy } from "../types.ts";

const settings: GatewaySettings = {
  maxRetry: 3,
  failThreshold: 5,
  coolDownSeconds: 300,
  intervalMinMs: 0,
  intervalMaxMs: 0,
  concurrencyPerWorker: 3,
  enforceProxy: true,
  replyTimeoutMs: 90_000,
  allowPreviewFallback: false,
  chatgptSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
  geminiSelectors: { input: [], send: [], assistant: [], streamingStop: [] },
};

function acc(partial: Partial<Account>): Account {
  return {
    id: partial.id || "a1",
    platform: "leonardo",
    email: partial.email || "leo@test.local",
    remark: "",
    status: partial.status || "healthy",
    proxyId: partial.proxyId ?? "px-1",
    sessionPath: partial.sessionPath ?? "storage/sessions/a1.json",
    failCount: 0,
    totalRequests: 0,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
    tokenState: partial.tokenState,
    availableModels: partial.availableModels,
  };
}

test("leonardo adapter surface and fail-closed extract", () => {
  const a = getAdapter("leonardo");
  assert.equal(a.capabilities().imageGeneration, true);
  assert.equal(a.capabilities().chat, false);
  assert.deepEqual(a.capabilities().models, ["leonardo-gpt-image-2", "leonardo-gemini"]);
  assert.equal(a.healthCheck().backend_mode, "web_account");
  const mock = a.extractResult({ ok: true, url: "data:image/svg+xml;base64,AAAA", mode: "mock" });
  assert.equal(mock.ok, false);
  const empty = a.extractResult({ ok: true, url: "" });
  assert.equal(empty.ok, false);
});

test("logical model mapping is not hardcoded to one gemini web name", () => {
  assert.equal(mapLogicalModel("leonardo-gpt-image-2").webId, "gpt-image-2");
  const gem = mapLogicalModel("leonardo-gemini");
  assert.equal(gem.logical, "leonardo-gemini");
  const pick = pickGeminiLabel(["FLUX", "Nano Banana 2", "Seedream"]);
  assert.match(pick, /Nano Banana/);
  assert.equal(sizeToAspect("1024x1024"), "1:1");
  assert.equal(sizeToAspect("768x1376"), "9:16");
});

test("validate n/size/quality/refs", () => {
  assert.equal(validateLeonardoParams({ n: 9, logical: "leonardo-gemini" }).ok, false);
  assert.equal(validateLeonardoParams({ n: 1, images: new Array(7).fill("data:image/png;base64,aa"), logical: "leonardo-gpt-image-2" }).ok, false);
  assert.equal(validateLeonardoParams({ n: 2, size: "1024x1024", quality: "HIGH", logical: "leonardo-gpt-image-2" }).ok, true);
});

test("page states: login, image ready, token exhausted, queue", () => {
  const login = detectPageState({ url: "https://app.leonardo.ai/auth/login", hasLoginForm: true }, "leonardo");
  assert.equal(login, "LOGIN_REQUIRED");
  assert.equal(errorForPageState(login).polluteAccountPool, true);

  const ready = detectPageState(
    { url: "https://app.leonardo.ai/generate", hasComposer: true, hasSend: true },
    "leonardo",
  );
  assert.equal(ready, "IMAGE_GENERATOR_READY");

  const token = detectPageState({ url: "https://app.leonardo.ai/generate", html: "out of tokens" }, "leonardo");
  assert.equal(token, "TOKEN_EXHAUSTED");
  assert.equal(errorForPageState(token).code, "LEONARDO_TOKEN_EXHAUSTED");
  assert.equal(errorForPageState(token).polluteAccountPool, true);

  const queue = detectPageState({ html: "queue is full" }, "leonardo");
  assert.equal(queue, "QUEUE_FULL");

  const dom = errorForPageState("IMAGE_GENERATOR_READY", true);
  assert.equal(dom.code, "PROVIDER_DOM_CHANGED");
  assert.equal(dom.polluteAccountPool, false);
});

test("scheduler skips token exhausted and missing model, allows unknown capability", () => {
  const proxies: Proxy[] = [
    {
      id: "px-1",
      name: "p",
      type: "socks5",
      host: "127.0.0.1",
      port: 18080,
      username: "",
      stickySessionId: "s",
      region: "",
      status: "active",
      maxAccounts: 8,
      remark: "",
      createdAt: new Date().toISOString(),
    },
  ];
  const exhausted = acc({ id: "ex", tokenState: "TOKEN_EXHAUSTED" });
  assert.equal(eligibilityReason(exhausted, proxies, settings), "额度用尽");
  const missing = acc({ id: "m", availableModels: ["FLUX"] });
  assert.equal(eligibilityReason(missing, proxies, settings, Date.now(), "leonardo-gpt-image-2"), "模型不可用（leonardo-gpt-image-2）");
  const unknown = acc({ id: "u" });
  assert.equal(eligibilityReason(unknown, proxies, settings, Date.now(), "leonardo-gemini"), null);
  const gpt = acc({ id: "g", availableModels: ["GPT Image 2", "Nano Banana"] });
  assert.equal(accountHasLeonardoModel(gpt, "leonardo-gpt-image-2"), true);
  const list = listEligible([exhausted, missing, gpt], proxies, settings, "leonardo", [], Date.now(), "leonardo-gpt-image-2");
  assert.deepEqual(list.map((a) => a.id), ["g"]);
  assert.equal(accountEligibleForModel(exhausted, "leonardo-gemini").ok, false);
});

test("leonardo error taxonomy maps to switch vs circuit", () => {
  const required = [
    "LEONARDO_LOGIN_REQUIRED",
    "LEONARDO_SESSION_EXPIRED",
    "LEONARDO_CHALLENGE",
    "LEONARDO_TOKEN_EXHAUSTED",
    "LEONARDO_QUEUE_FULL",
    "LEONARDO_RATE_LIMITED",
    "LEONARDO_ACCOUNT_RESTRICTED",
    "LEONARDO_MODEL_UNAVAILABLE",
    "LEONARDO_DOM_CHANGED",
    "LEONARDO_GENERATION_FAILED",
    "LEONARDO_GENERATION_TIMEOUT",
    "LEONARDO_RESULT_NOT_FOUND",
    "LEONARDO_DOWNLOAD_FAILED",
    "LEONARDO_PROXY_UNAVAILABLE",
  ];
  for (const code of required) {
    assert.ok(FAILURE_MATRIX[code as keyof typeof FAILURE_MATRIX], code);
  }
  const login = decide("LEONARDO_LOGIN_REQUIRED");
  assert.equal(login.switch_account, true);
  assert.equal(login.account_health_effect, "invalid");
  const token = decide("LEONARDO_TOKEN_EXHAUSTED");
  assert.equal(token.switch_account, true);
  const dom = decide("LEONARDO_DOM_CHANGED: composer missing");
  assert.equal(dom.switch_account, false);
  assert.equal(dom.account_health_effect, "none");
  assert.equal(dom.provider_circuit_effect, "trip");
  assert.equal(normalizeError("LEONARDO_RESULT_NOT_FOUND"), "LEONARDO_RESULT_NOT_FOUND");
});

test("selector pack is recon-based and versioned", () => {
  const pack = packFor("leonardo");
  assert.equal(pack.version, "leonardo-image-v1");
  assert.ok(pack.input.includes("#home-prompt-textarea"));
  assert.ok(pack.send.some((s) => s.includes("Generate")));
  assert.ok(pack.modelSwitcher?.some((s) => s.includes("Model:")));
  assert.ok(leonardoAdapter.selectorPack().fileInput?.includes('button[aria-label="Add image reference"]'));
});

test("historical / ui images are not treated as results", () => {
  const gate = leonardoAdapter.extractResult({
    ok: true,
    url: "https://cdn.leonardo.ai/favicon.ico",
  });
  assert.equal(gate.ok, false);
});
