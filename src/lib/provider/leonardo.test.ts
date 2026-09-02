import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, FAILURE_MATRIX, normalizeError } from "../fault-matrix.ts";
import { eligibilityReason, listEligible } from "../eligibility.ts";
import { getAdapter } from "./index.ts";
import { detectPageState, errorForPageState } from "./page-state.ts";
import { accountEligibleForModel, leonardoAdapter } from "./leonardo.ts";
import {
  accountHasLeonardoModel,
  isLeonardoModel,
  mapLogicalModel,
  pickGeminiLabel,
  sizeToAspect,
  validateLeonardoParams,
} from "./leonardo-models.ts";
import { inspectSession } from "../session-probe.ts";
import { loginHelperScript, parseStorageState, summarizeStorageState } from "../session-file.ts";
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
    availableModelsObservedAt: partial.availableModelsObservedAt,
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
  assert.equal(sizeToAspect("1264x848"), "3:2");
  assert.equal(sizeToAspect("1376x768"), "16:9");
  assert.equal(sizeToAspect("1584x672"), "21:9");
  assert.equal(sizeToAspect("5504x3072"), "16:9");
});

test("validate n/size/quality/refs", () => {
  assert.equal(validateLeonardoParams({ n: 9, logical: "leonardo-gemini" }).ok, false);
  assert.equal(validateLeonardoParams({ n: 1, images: new Array(7).fill("data:image/png;base64,aa"), logical: "leonardo-gpt-image-2" }).ok, false);
  assert.equal(validateLeonardoParams({ n: 2, size: "1024x1024", quality: "HIGH", logical: "leonardo-gpt-image-2" }).ok, true);
  const ar = validateLeonardoParams({ n: 1, size: "16:9", logical: "leonardo-gemini" });
  assert.equal(ar.ok, true);
  if (ar.ok) {
    assert.equal(ar.aspect, "16:9");
    assert.equal(ar.size, "1376x768");
  }
  const gptLand = validateLeonardoParams({ n: 1, size: "1536x1024", logical: "leonardo-gpt-image-2", model: "gpt-image-1" });
  assert.equal(gptLand.ok, true);
  if (gptLand.ok) {
    assert.equal(gptLand.aspect, "3:2");
    assert.equal(gptLand.size, "1264x848");
  }
  assert.equal(isLeonardoModel("gemini-image"), false);
  assert.equal(isLeonardoModel("gpt-image-1"), true);
  assert.equal(isLeonardoModel("gemini-2.5-flash-image"), true);
  assert.equal(isLeonardoModel("nano-banana-2"), true);
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
  const missing = acc({ id: "m", availableModels: ["FLUX"], availableModelsObservedAt: new Date().toISOString() });
  assert.equal(eligibilityReason(missing, proxies, settings, Date.now(), "leonardo-gpt-image-2"), "模型不可用（leonardo-gpt-image-2）");
  const unknown = acc({ id: "u" });
  assert.equal(eligibilityReason(unknown, proxies, settings, Date.now(), "leonardo-gemini"), null);
  const gpt = acc({ id: "g", availableModels: ["GPT Image 2", "Nano Banana"] });
  assert.equal(accountHasLeonardoModel(gpt, "leonardo-gpt-image-2"), true);
  const list = listEligible([exhausted, missing, gpt], proxies, settings, "leonardo", [], Date.now(), "leonardo-gpt-image-2");
  assert.deepEqual(list.map((a) => a.id), ["g"]);
  assert.equal(accountEligibleForModel(exhausted, "leonardo-gemini").ok, false);
  const legacyPartial = acc({ id: "legacy", availableModels: ["Nano Banana 2"] });
  assert.equal(accountHasLeonardoModel(legacyPartial, "leonardo-gpt-image-2"), true);
  const stale = acc({
    id: "stale",
    availableModels: ["Nano Banana 2"],
    availableModelsObservedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
  });
  assert.equal(accountHasLeonardoModel(stale, "leonardo-gpt-image-2"), true);
  const fresh = acc({
    id: "fresh",
    availableModels: ["Nano Banana 2"],
    availableModelsObservedAt: new Date().toISOString(),
  });
  assert.equal(accountHasLeonardoModel(fresh, "leonardo-gpt-image-2"), false);
});

test("Leonardo model verification never accepts the other model family", () => {
  assert.equal(leonardoAdapter.verifyModel("leonardo-gpt-image-2", "Nano Banana 2").ok, false);
  assert.equal(leonardoAdapter.verifyModel("leonardo-gemini", "GPT Image 2").ok, false);
  assert.equal(leonardoAdapter.verifyModel("leonardo-gpt-image-2", "GPT Image 2").ok, true);
  assert.equal(leonardoAdapter.verifyModel("leonardo-gemini", "Nano Banana 2").ok, true);
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
  assert.ok(leonardoAdapter.selectorPack().fileInput?.includes('button[aria-label="Add reference to generation"]'));
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
  assert.match(guest.reason || "", /anonymous-id/);
  const summary = summarizeStorageState(guestJson, "leonardo");
  assert.equal(summary.ok, false);
  assert.ok(summary.cookieNames.includes("anonymous-id"));
  assert.equal(summary.authNames.length, 0);
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

test("leonardo canva + analytics cookies are not a session", () => {
  const json = JSON.stringify({
    cookies: [
      { name: "CDI", domain: "www.canva.com", value: "x", expires: Date.now() / 1000 + 86400 },
      { name: "ASI", domain: "www.canva.com", value: "x", expires: Date.now() / 1000 + 3600 },
      { name: "anonymous-id", domain: "app.leonardo.ai", value: "x", expires: Date.now() / 1000 + 86400 },
      { name: "_landing_host", domain: ".leonardo.ai", value: "app.leonardo.ai", expires: Date.now() / 1000 + 3600 },
      { name: "__Secure-better-auth.oauth_state", domain: "app.leonardo.ai", value: "abc", expires: Date.now() / 1000 + 600 },
      { name: "XSRF-TOKEN", domain: "auth.leonardo.ai", value: "t", expires: -1 },
      { name: "__stripe_sid", domain: ".app.leonardo.ai", value: "s", expires: Date.now() / 1000 + 1800 },
      { name: "intercom-session-xc8vmlt4", domain: ".leonardo.ai", value: "", expires: Date.now() / 1000 + 86400 },
    ],
  });
  const guest = inspectSession(json, "leonardo");
  assert.equal(guest.ok, false);
  assert.match(guest.reason || "", /未完成|Session Cookie|Canva/);
  const parsed = parseStorageState(json, "leonardo");
  assert.equal(parsed.ok, false);
});

test("leonardo better-auth session cookie counts as a session", () => {
  const json = JSON.stringify({
    cookies: [
      { name: "anonymous-id", domain: "app.leonardo.ai", value: "x", expires: Date.now() / 1000 + 86400 * 30 },
      {
        name: "__Secure-better-auth.session_token",
        domain: "app.leonardo.ai",
        value: "tok",
        expires: Date.now() / 1000 + 86400,
      },
    ],
  });
  const ok = inspectSession(json, "leonardo");
  assert.equal(ok.ok, true);
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
  assert.match(py, /人工登录阶段不会连接自动化/);
  assert.match(py, /登录期间助手不会读取或操作浏览器/);
  assert.match(py, /disable-cn-redirect/);
  assert.match(py, /canva\.cn/);
  assert.match(py, /to_canva_com/);
  assert.match(py, /attach_canva_com_guard/);
  assert.match(py, /CANVA_COM/);
  assert.match(py, /connect_over_cdp/);
  assert.match(py, /user-data-dir=/);
  assert.match(py, /clone_chrome_profile/);
  assert.match(py, /chrome-login/);
  assert.match(py, /专用 Chrome/);
  assert.match(py, /proxy-pac-url=/);
  assert.equal(py.includes("完全退出 Chrome"), false);
  assert.equal(/CANVA_COM,\s*\]/.test(py), false);
  assert.match(py, /disable-popup-blocking/);
  assert.match(py, /callbackUrl/);
  assert.match(py, /oauth_busy/);
  assert.match(py, /click_canva_sso/);
  assert.match(py, /click_idp_sso/);
  assert.match(py, /canva_sso_labels/);
  assert.match(py, /canva_ready/);
  assert.match(py, /canva_has_session/);
  assert.match(py, /必须用 Canva 授权/);
  assert.match(py, /Network.*Cookies/);
  assert.match(py, /ensure_canva_and_leonardo_tabs/);
  assert.match(py, /已打开 Leonardo 标签/);
  assert.match(py, /session_token/);
  assert.match(py, /拒绝保存/);
  assert.match(py, /Continue with Canva/);
  assert.equal(py.includes("Hotmail / Outlook 请在 Leonardo 点 Microsoft"), false);
  assert.equal(py.includes("return ms + canva"), false);
  const hotmail = loginHelperScript(
    acc({ email: "AssanteFerraiolo98@hotmail.com", status: "pending_login", sessionPath: null }),
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
  assert.match(hotmail, /必须用 Canva 授权/);
  assert.match(hotmail, /不要点 Microsoft/);
  assert.equal(hotmail.includes("请在 Leonardo 点 Microsoft"), false);
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
  assert.match(py, /使用本机 %s/);
  assert.match(py, /10808/);
  assert.match(py, /不必从 GitHub/);
  assert.match(py, /disable-cn-redirect/);
  assert.match(py, /proxy-pac-url/);
  assert.match(py, /SOCKS5 /);
  assert.match(py, /拦截 canva\.cn/);
  const hosts = py.match(/IDP_HOSTS = \[[\s\S]*?\]/);
  assert.ok(hosts);
  assert.doesNotMatch(hosts[0], /canva\.com/);
});
