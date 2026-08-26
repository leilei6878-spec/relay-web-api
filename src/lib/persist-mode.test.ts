import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonAllowedFor, persistenceMode, pgSotActive } from "./persist-mode.ts";

test("production SoT is always postgres", () => {
  const env = { NODE_ENV: "production", RELAY_SOT: "file" } as NodeJS.ProcessEnv;
  assert.equal(persistenceMode(env), "postgres");
  assert.equal(jsonAllowedFor("scheduling", env), false);
  assert.equal(jsonAllowedFor("import", env), true);
  assert.equal(jsonAllowedFor("fixture", env), true);
  assert.equal(jsonAllowedFor("bootstrap", env), true);
});

test("dev without DATABASE_URL uses file bootstrap", () => {
  const env = { NODE_ENV: "development", RELAY_SKIP_DB: "1" } as NodeJS.ProcessEnv;
  assert.equal(persistenceMode(env), "file");
  assert.equal(jsonAllowedFor("scheduling", env), true);
});

test("RELAY_SOT=postgres forces postgres even in test", () => {
  const env = { NODE_ENV: "test", RELAY_SOT: "postgres", RELAY_SKIP_DB: "1" } as NodeJS.ProcessEnv;
  assert.equal(persistenceMode(env), "postgres");
  assert.equal(jsonAllowedFor("scheduling", env), false);
});

test("pgSotActive requires postgres mode and a SQL backend", () => {
  assert.equal(pgSotActive({ NODE_ENV: "production", RELAY_SKIP_DB: "1", DATABASE_URL: "postgres://x" } as NodeJS.ProcessEnv), false);
  assert.equal(
    pgSotActive({ NODE_ENV: "test", RELAY_SOT: "postgres", RELAY_SQL_HTTP_URL: "http://127.0.0.1:19010" } as NodeJS.ProcessEnv),
    true,
  );
  assert.equal(pgSotActive({ NODE_ENV: "test", RELAY_SKIP_DB: "1" } as NodeJS.ProcessEnv), false);
});
