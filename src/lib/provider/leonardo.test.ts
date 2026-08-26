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
import { inspectSession } from "../session-probe.ts";
import { loginHelperScript, parseStorageState } from "../session-file.ts";
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

test("leonardo landing cookies are not a session", () => {
  const guestJson = JSON.stringify({
    cookies: [
      { name: "anonymous-id", domain: "app.leonardo.ai", value: "x", expires: Date.now() / 1000 + 86400 },
      { name: "_landing_host", domain: ".leonardo.ai", value: "app.leonardo.ai", expires: Date.now() / 1000 + 3600 },
      { name: "_landing_time", domain: ".leonardo.ai", value: "1", expires: Date.now() / 1000 + 3600 },
      { name: "__cf_bm", domain: ".paddle.com", value: "cf", expires: Date.now() / 1000 + 3600 },
    ],
  });
  const guest = inspectSession(guestJson, "leonardo");
  assert.equal(guest.ok, false);
  assert.match(guest.reason || "", /未完成|游客/);
  const parsed = parseStorageState(guestJson, "leonardo");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /未完成|游客/);
  const inferred = parseStorageState(guestJson);
  assert.equal(inferred.ok, false);
});

test("leonardo cognito cookies count as a session", () => {
  const json = JSON.stringify({
    cookies: [
      { name: "anonymous-id", domain: "app.leonardo.ai", value: "x", expires: Date.now() / 1000 + 86400 * 30 },
      {
        name: "CognitoIdentityServiceProvider.abc.user.accessToken",
        domain: "app.leonardo.ai",
        value: "eyJ",
        expires: Date.now() / 1000 + 3600,
      },
      {
        name: "CognitoIdentityServiceProvider.abc.user.idToken",
        domain: "app.leonardo.ai",
        value: "eyJ",
        expires: Date.now() / 1000 + 3600,
      },
      { name: "CognitoIdentityServiceProvider.abc.LastAuthUser", domain: "app.leonardo.ai", value: "user" },
    ],
  });
  const ok = inspectSession(json, "leonardo");
  assert.equal(ok.ok, true);
  const parsed = parseStorageState(json, "leonardo");
  assert.equal(parsed.ok, true);
});

test("leonardo login helper waits for Sign In to disappear, not the public composer", () => {
  const py = loginHelperScript(
    acc({ status: "pending_login", sessionPath: null }),
    {
      id: "px-1",
      name: "Japan",
      type: "http",
      host: "127.0.0.1",
      port: 9,
      username: "",
      stickySessionId: "s",
      region: "JP",
      status: "active",
      maxAccounts: 8,
      remark: "",
      createdAt: new Date().toISOString(),
    },
    "",
  );
  assert.match(py, /app\.leonardo\.ai\/generate/);
  assert.match(py, /PLATFORM == "leonardo"/);
  assert.match(py, /sign_in_visible/);
  assert.match(py, /leonardo_cookies_ok/);
  assert.match(py, /没有写入 state\.json/);
  assert.match(py, /游客首页也有输入框/);
  assert.match(py, /disable-cn-redirect/);
  assert.match(py, /canva\.cn/);
  assert.match(py, /to_canva_com/);
  assert.match(py, /attach_canva_com_guard/);
  assert.match(py, /CANVA_COM/);
  assert.match(py, /connect_over_cdp/);
  assert.match(py, /user-data-dir=/);
  assert.match(py, /Accept all cookies/);
  assert.match(py, /完全退出 Chrome/);
});

test("leonardo SS helper pins canva.com through the bound node", () => {
  const py = loginHelperScript(
    acc({ status: "pending_login", sessionPath: null }),
    {
      id: "px-1",
      name: "Japan",
      type: "ss",
      host: "127.0.0.1",
      port: 8443,
      username: "",
      stickySessionId: "s",
      region: "JP",
      status: "active",
      maxAccounts: 8,
      remark: "",
      createdAt: new Date().toISOString(),
      method: "2022-blake3-aes-128-gcm",
    },
    "secret",
  );
  assert.match(py, /Leonardo 登录用绑定节点/);
  assert.match(py, /disable-cn-redirect/);
  assert.match(py, /proxy-pac-url/);
  assert.match(py, /SOCKS5 /);
  assert.match(py, /拦截 canva\.cn/);
  const hosts = py.match(/IDP_HOSTS = \[[\s\S]*?\]/);
  assert.ok(hosts);
  assert.doesNotMatch(hosts[0], /canva\.com/);
});
