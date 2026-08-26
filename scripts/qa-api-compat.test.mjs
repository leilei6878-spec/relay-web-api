import assert from "node:assert/strict";
import { test } from "node:test";

const base = process.env.RELAY_TEST_BASE || "http://127.0.0.1:8080";

async function json(path, opts = {}) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
}

async function live() {
  try {
    await fetch(base + "/api/runtime", { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

test("runtime does not leak secrets", async (t) => {
  if (!(await live())) {
    t.skip("server not running");
    return;
  }
  const { status, body } = await json("/api/runtime");
  assert.equal(status, 200);
  assert.equal(body.apiKey, undefined);
  assert.equal(body.workerToken, undefined);
  assert.ok("workerOnline" in body);
});

test("customer key cannot poll worker", async (t) => {
  if (!(await live())) {
    t.skip("server not running");
    return;
  }
  const { status } = await json("/api/worker/next", { headers: { Authorization: "Bearer sk-relay-not-a-worker" } });
  assert.equal(status, 401);
});

test("unsupported chat params are rejected", async (t) => {
  if (!(await live())) {
    t.skip("server not running");
    return;
  }
  const session = await fetch(base + "/api/admin/session");
  const cookie = session.headers.get("set-cookie") || "";
  const invoked = await json("/api/admin/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      path: "/v1/chat/completions",
      payload: { model: "gpt-5.6", messages: [{ role: "user", content: "hi" }], temperature: 0.2 },
    }),
  });
  assert.equal(invoked.status, 400);
  assert.match(JSON.stringify(invoked.body), /unsupported parameter/);
});

test("responses endpoint exists", async (t) => {
  if (!(await live())) {
    t.skip("server not running");
    return;
  }
  const res = await json("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
    body: JSON.stringify({ model: "gpt-5.6", input: "hi" }),
  });
  assert.notEqual(res.status, 404);
});

test("models list includes capabilities", async (t) => {
  if (!(await live())) {
    t.skip("server not running");
    return;
  }
  const { status, body } = await json("/v1/models");
  assert.equal(status, 200);
  assert.equal(body.object, "list");
  const chat = body.data.find((m) => m.id === "gpt-5.6");
  assert.ok(chat);
  assert.equal(chat.capabilities.chat, true);
  assert.equal(chat.capabilities.vision, true);
  const img = body.data.find((m) => m.id === "gemini-image");
  assert.equal(img.capabilities.image_generation, true);
  assert.equal(img.capabilities.image_edit, true);
});

test("responses rejects unsupported params", async (t) => {
  if (!(await live())) {
    t.skip("server not running");
    return;
  }
  const session = await fetch(base + "/api/admin/session");
  const cookie = session.headers.get("set-cookie") || "";
  const invoked = await json("/api/admin/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      path: "/v1/responses",
      payload: { model: "gpt-5.6", input: "hi", temperature: 0.2, tools: [] },
    }),
  });
  assert.equal(invoked.status, 400);
  assert.match(JSON.stringify(invoked.body), /unsupported parameter/);
});

test("image edits reject mask", async (t) => {
  if (!(await live())) {
    t.skip("server not running");
    return;
  }
  const session = await fetch(base + "/api/admin/session");
  const cookie = session.headers.get("set-cookie") || "";
  const invoked = await json("/api/admin/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      path: "/v1/images/edits",
      payload: { prompt: "make blue", image: "data:image/png;base64,aaa", mask: "data:image/png;base64,bbb" },
    }),
  });
  assert.equal(invoked.status, 400);
  assert.match(JSON.stringify(invoked.body), /mask/);
});
