import assert from "node:assert/strict";
import { test } from "node:test";
import "./test-env.ts";
import { createApiKey } from "./api-keys.ts";
import { ADMIN_COOKIE, classify, ensureAdminToken } from "./authz.ts";

process.env.RELAY_SKIP_DB = "1";

test("customer Authorization wins over admin cookie", async () => {
  const admin = await ensureAdminToken();
  const row = await createApiKey({ name: "authz-priority" });
  const req = new Request("http://127.0.0.1/v1/chat/completions", {
    headers: {
      Authorization: `Bearer ${row.key}`,
      Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}`,
    },
  });
  const p = await classify(req);
  assert.equal(p?.kind, "customer");
  if (p?.kind === "customer") assert.equal(p.record.key, row.key);
});

test("admin cookie without bearer is admin", async () => {
  const admin = await ensureAdminToken();
  const req = new Request("http://127.0.0.1/api/admin/metrics", {
    headers: { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}` },
  });
  const p = await classify(req);
  assert.equal(p?.kind, "admin");
});

test("unknown bearer does not fall back to admin cookie", async () => {
  const admin = await ensureAdminToken();
  const req = new Request("http://127.0.0.1/v1/chat/completions", {
    headers: {
      Authorization: "Bearer sk-relay-not-a-real-key-000000",
      Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}`,
    },
  });
  const p = await classify(req);
  assert.equal(p, null);
});
