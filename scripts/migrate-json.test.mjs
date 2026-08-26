import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("migrate-json dry-run reports counts and writes nothing", () => {
  const dir = join(tmpdir(), `relay-mig-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const plane = join(dir, "control-plane.json");
  writeFileSync(
    plane,
    JSON.stringify({
      accounts: [{ id: "ac-1", platform: "chatgpt", email: "a@test", status: "healthy", createdAt: new Date().toISOString() }],
      proxies: [{ id: "px-1", name: "p", type: "http", host: "127.0.0.1", port: 9, status: "active" }],
      settings: { maxRetry: 3 },
    }),
  );
  const r = spawnSync(process.execPath, ["scripts/migrate-json.mjs", "--dry-run"], {
    env: { ...process.env, RELAY_PLANE: plane },
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /accounts: 1/);
  assert.match(r.stdout, /proxies: 1/);
  assert.match(r.stdout, /dry-run/);
});
