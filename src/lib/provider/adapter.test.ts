import assert from "node:assert/strict";
import { test } from "node:test";
import { chatgptAdapter } from "./chatgpt.ts";
import { geminiAdapter } from "./gemini.ts";
import { getAdapter } from "./index.ts";
import { detectPageState, errorForPageState } from "./page-state.ts";
import { prepareChatRequest, toWebPrompt, turnsFromMessages } from "./prompt-map.ts";
import { applySessionUpdate, canWriteSession, sessionExpired } from "./session-cas.ts";
import { assertGeneratedBytes, assertGeneratedImage, isUiOrOldSrc, pngSize } from "./image-guard.ts";
import { featureDelta, fingerprint } from "./fingerprint.ts";
import { packFor, selectorCandidates } from "./selectors.ts";

test("adapters expose the required surface", () => {
  for (const id of ["chatgpt", "gemini"] as const) {
    const a = getAdapter(id);
    for (const method of [
      "capabilities",
      "validateSession",
      "detectPageState",
      "prepareRequest",
      "normalizeError",
      "verifyModel",
      "extractResult",
      "healthCheck",
      "selectorPack",
      "fingerprint",
    ]) {
      assert.equal(typeof (a as never)[method], "function", `${id}.${method}`);
    }
  }
  assert.equal(chatgptAdapter.capabilities().chat, true);
  assert.equal(geminiAdapter.capabilities().imageGeneration, true);
  assert.equal(geminiAdapter.capabilities().imageEdit, true);
});

test("page state does not map composer miss to session death", () => {
  const authenticated = detectPageState({
    url: "https://chatgpt.com/",
    html: "<main></main>",
    hasComposer: false,
    cookieNames: ["oai-did", "session"],
  });
  assert.equal(authenticated, "AUTHENTICATED");
  const mapped = errorForPageState(authenticated, true);
  assert.equal(mapped.code, "PROVIDER_DOM_CHANGED");
  assert.equal(mapped.polluteAccountPool, false);

  const login = detectPageState({ url: "https://chatgpt.com/auth/login", hasLoginForm: true });
  assert.equal(login, "LOGIN_REQUIRED");
  assert.equal(errorForPageState(login).code, "LOGIN_REQUIRED");

  const challenge = detectPageState({ html: "verify you are human captcha" });
  assert.equal(challenge, "CHALLENGE");
  assert.equal(errorForPageState(challenge).polluteAccountPool, false);

  const composer = detectPageState({ hasComposer: true, hasSend: true, url: "https://chatgpt.com/" });
  assert.equal(composer, "COMPOSER_READY");
});

test("system instruction + 2-turn + 5-turn mapping", () => {
  const two = turnsFromMessages([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(two[0]?.role, "system");
  assert.equal(two[1]?.role, "user");
  const web = toWebPrompt(two);
  assert.match(web, /<relay:SYSTEM>/);
  assert.match(web, /<relay:USER current="true">/);
  assert.doesNotMatch(web, /^system: be terse\nuser: hi$/);

  const five = turnsFromMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: [{ type: "text", text: "u3" }, { type: "image_url", image_url: { url: "data:image/png;base64,aaaa" } }] },
  ]);
  assert.equal(five.length, 6);
  const mapped = prepareChatRequest("chatgpt", { messages: five.map((t) => ({ role: t.role, content: t.text })) });
  assert.match(mapped.webPrompt, /<relay:ASSISTANT>/);
  assert.match(mapped.webPrompt, /<relay:USER current="true">/);
});

test("vision turn keeps image on the user turn", () => {
  const prepared = prepareChatRequest("chatgpt", {
    messages: [
      { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: "data:image/png;base64,abcd" }] },
    ],
  });
  assert.equal(prepared.images.length, 1);
  assert.equal(prepared.turns[0]?.images?.length, 1);
});

test("mixed text/image messages stay structured", () => {
  const prepared = prepareChatRequest("chatgpt", {
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
    ],
  });
  assert.equal(prepared.turns.length, 3);
  assert.equal(prepared.images.length, 1);
  assert.match(prepared.webPrompt, /<relay:ASSISTANT>/);
});

test("session CAS rejects stale worker write", () => {
  assert.equal(canWriteSession(3, 3), true);
  assert.equal(canWriteSession(4, 3), false);
  const stale = applySessionUpdate(
    { id: "a1", platform: "chatgpt", sessionVersion: 4 },
    { accountId: "a1", baseVersion: 3, nextVersion: 4, stateJson: "{}" },
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "STALE_SESSION_UPDATE");
  assert.equal(sessionExpired(1, 10), true);
  assert.equal(sessionExpired(20, 10), false);
});

test("session_refresh_race: first writer wins, stale base is rejected", () => {
  const account = { id: "a1", platform: "chatgpt" as const, sessionVersion: 2 };
  const json = JSON.stringify({
    cookies: [{ name: "__Secure-next-auth.session-token", value: "fresh", expires: Date.now() / 1000 + 86400 }],
  });
  const first = applySessionUpdate(account, { accountId: "a1", baseVersion: 2, nextVersion: 3, stateJson: json });
  assert.equal(first.ok, true);
  const second = applySessionUpdate(
    { ...account, sessionVersion: first.ok ? first.sessionVersion : 2 },
    { accountId: "a1", baseVersion: 2, nextVersion: 3, stateJson: json },
  );
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "STALE_SESSION_UPDATE");
});

test("session_expiration inspect", () => {
  const json = JSON.stringify({
    cookies: [{ name: "__Secure-next-auth.session-token", value: "x", expires: 1 }],
  });
  const decided = applySessionUpdate(
    { id: "a1", platform: "chatgpt", sessionVersion: 0 },
    { accountId: "a1", baseVersion: 0, nextVersion: 1, stateJson: json },
  );
  assert.equal(decided.ok, false);
});

test("gemini rejects svg placeholder and ui images", () => {
  const svg = "data:image/svg+xml;base64,PHN2Zy8+";
  assert.equal(assertGeneratedImage(svg).ok, false);
  assert.equal(isUiOrOldSrc("https://x/favicon.ico"), true);
  assert.equal(isUiOrOldSrc("https://lh3.googleusercontent.com/new", ["https://lh3.googleusercontent.com/old"]), false);
  assert.equal(isUiOrOldSrc("https://lh3.googleusercontent.com/old", ["https://lh3.googleusercontent.com/old"]), true);
  const png = Buffer.alloc(80);
  png[0] = 0x89;
  png[1] = 0x50;
  png[2] = 0x4e;
  png[3] = 0x47;
  png.writeUInt32BE(32, 16);
  png.writeUInt32BE(32, 20);
  assert.equal(pngSize(png)?.width, 32);
  assert.equal(assertGeneratedBytes(png, "image/png").ok, false);
  const big = Buffer.alloc(3_000);
  big[0] = 0x89;
  big[1] = 0x50;
  big[2] = 0x4e;
  big[3] = 0x47;
  big.writeUInt32BE(256, 16);
  big.writeUInt32BE(256, 20);
  assert.equal(assertGeneratedBytes(big, "image/png").ok, true);
  assert.equal(geminiAdapter.extractResult({ ok: true, url: svg }).ok, false);
});

test("selector packs are versioned and bounded", () => {
  const pack = packFor("chatgpt");
  assert.equal(pack.version, "chatgpt-v1");
  const input = selectorCandidates("chatgpt", "input");
  assert.ok(input.length <= 4);
  assert.ok(input.length >= 2);
});

test("model verify accepts UI labels and fails unconfirmed", () => {
  const ok = chatgptAdapter.verifyModel("gpt-5.6", "GPT-5.6");
  assert.equal(ok.ok, true);
  const miss = chatgptAdapter.verifyModel("gpt-5.6", "GPT-4o");
  assert.equal(miss.ok, false);
  const unconfirmed = chatgptAdapter.verifyModel("gpt-5.6", "");
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.equal(unconfirmed.code, "MODEL_SELECTION_UNCONFIRMED");
});

test("fingerprint change on missing composer is critical", () => {
  const prev = fingerprint("chatgpt", "chatgpt-v1", [
    { key: "composer", present: true },
    { key: "send", present: true },
    { key: "assistant", present: true },
  ]);
  const next = fingerprint("chatgpt", "chatgpt-v1", [
    { key: "composer", present: false },
    { key: "send", present: false },
    { key: "assistant", present: true },
  ]);
  const delta = featureDelta(prev, next);
  assert.equal(delta.changed, true);
  assert.ok(delta.missingCritical.includes("composer"));
});
