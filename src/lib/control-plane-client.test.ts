import assert from "node:assert/strict";
import { test } from "node:test";
import { createPendingAccount, persistControlPlane, type ControlPlaneWrite } from "./control-plane-client.ts";
import { defaultSettings } from "./store.ts";

const plane: ControlPlaneWrite = { accounts: [], proxies: [], settings: defaultSettings };

test("pending account creation normalizes input and starts fail-closed", () => {
  const account = createPendingAccount({
    platform: "gemini",
    email: "  qa@example.invalid  ",
    remark: "  live matrix  ",
    proxyId: "",
  });
  assert.equal(account.email, "qa@example.invalid");
  assert.equal(account.remark, "live matrix");
  assert.equal(account.status, "pending_login");
  assert.equal(account.proxyId, null);
  assert.equal(account.sessionPath, null);
});

test("control-plane client waits for an acknowledged server write", async () => {
  let request: RequestInit | undefined;
  const result = await persistControlPlane(plane, async (_url, init) => {
    request = init;
    return Response.json({ ok: true });
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(request?.method, "PUT");
  assert.equal(request?.credentials, "include");
  assert.deepEqual(JSON.parse(String(request?.body)), plane);
});

test("control-plane client exposes expired login and protected-write failures", async () => {
  const expired = await persistControlPlane(
    plane,
    async () => Response.json({ error: "unauthorized" }, { status: 401 }),
  );
  assert.deepEqual(expired, { ok: false, status: 401, error: "unauthorized" });

  const skipped = await persistControlPlane(
    plane,
    async () => Response.json({ ok: true, skipped: "real-accounts-protected" }),
  );
  assert.deepEqual(skipped, {
    ok: false,
    status: 200,
    error: "服务器拒绝保存：real-accounts-protected",
  });
});
