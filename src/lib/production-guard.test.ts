import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertProductionFailClosed, runProductionReadinessCheck } from "./production-guard.ts";

test("non-production allows PGLite / memory / local media", () => {
  const report = runProductionReadinessCheck({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.equal(report.production, false);
  assert.equal(report.ready, true);
  assert.equal(report.items.find((i) => i.id === "database")?.status, "degraded");
});

test("production missing DATABASE_URL / REDIS_URL / secrets / media is not ready", () => {
  const report = runProductionReadinessCheck({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.equal(report.production, true);
  assert.equal(report.ready, false);
  const ids = report.blockers.join(" ");
  assert.match(ids, /database/);
  assert.match(ids, /redis/);
  assert.match(ids, /admin_auth|secret_store/);
  assert.match(ids, /media_store/);
  assert.match(ids, /worker/);
});

test("production mock mode is forbidden even when infra is set", () => {
  const report = runProductionReadinessCheck({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x",
    REDIS_URL: "redis://x",
    RELAY_ADMIN_TOKEN: "ad-relay-aaaaaaaaaaaaaaaaaaaaaaaa",
    RELAY_WORKER_TOKEN: "wk-relay-aaaaaaaaaaaaaaaaaaaaaaaa",
    RELAY_S3_BUCKET: "b",
    RELAY_S3_ACCESS_KEY: "k",
    RELAY_S3_SECRET_KEY: "s",
    RELAY_ALLOW_MOCK: "1",
  } as NodeJS.ProcessEnv);
  assert.equal(report.ready, false);
  assert.equal(report.mockForbidden, true);
});

test("production fully configured is ready", () => {
  const report = runProductionReadinessCheck({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x",
    REDIS_URL: "redis://x",
    RELAY_ADMIN_TOKEN: "ad-relay-aaaaaaaaaaaaaaaaaaaaaaaa",
    RELAY_WORKER_TOKEN: "wk-relay-aaaaaaaaaaaaaaaaaaaaaaaa",
    RELAY_SECRETS_KEY: "test-encryption-key-not-for-prod",
    RELAY_S3_BUCKET: "b",
    RELAY_S3_ACCESS_KEY: "k",
    RELAY_S3_SECRET_KEY: "s",
  } as NodeJS.ProcessEnv);
  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
});

test("production missing encryption key is not ready", () => {
  const report = runProductionReadinessCheck({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x",
    REDIS_URL: "redis://x",
    RELAY_ADMIN_TOKEN: "ad-relay-aaaaaaaaaaaaaaaaaaaaaaaa",
    RELAY_WORKER_TOKEN: "wk-relay-aaaaaaaaaaaaaaaaaaaaaaaa",
    RELAY_S3_BUCKET: "b",
    RELAY_S3_ACCESS_KEY: "k",
    RELAY_S3_SECRET_KEY: "s",
  } as NodeJS.ProcessEnv);
  assert.equal(report.ready, false);
  assert.match(report.blockers.join(" "), /encryption_key|secret_store/);
});

test("assertProductionFailClosed throws in production without env", () => {
  assert.throws(() => assertProductionFailClosed({ NODE_ENV: "production" } as NodeJS.ProcessEnv), /PRODUCTION_FAIL_CLOSED/);
  assert.doesNotThrow(() => assertProductionFailClosed({ NODE_ENV: "development" } as NodeJS.ProcessEnv));
});

test("child process NODE_ENV=production without DATABASE_URL exits fail-closed", () => {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--import",
      "./scripts/register-ts-ext.mjs",
      "-e",
      `process.env.NODE_ENV='production'; delete process.env.DATABASE_URL;
       const { assertProductionFailClosed } = await import('./src/lib/production-guard.ts');
       try { assertProductionFailClosed(); process.exit(2); }
       catch (e) { console.log(String(e)); process.exit(0); }`,
    ],
    { encoding: "utf8", cwd: process.cwd() },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /PRODUCTION_FAIL_CLOSED/);
  assert.match(r.stdout, /DATABASE_URL/);
});
