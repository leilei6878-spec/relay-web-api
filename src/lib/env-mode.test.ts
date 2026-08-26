import assert from "node:assert/strict";
import { test } from "node:test";
import { readEnv } from "./env-mode.ts";

test("readEnv accepts production-contract aliases", () => {
  const env = {
    ADMIN_SECRET: "ad-relay-from-alias",
    SESSION_ENCRYPTION_KEY: "enc-from-alias",
    WORKER_SIGNING_KEY: "wk-from-alias",
    PUBLIC_BASE_URL: "https://alias.example",
    S3_BUCKET: "bucket-from-alias",
  } as NodeJS.ProcessEnv;
  assert.equal(readEnv("RELAY_ADMIN_TOKEN", env), "ad-relay-from-alias");
  assert.equal(readEnv("RELAY_SECRETS_KEY", env), "enc-from-alias");
  assert.equal(readEnv("RELAY_WORKER_TOKEN", env), "wk-from-alias");
  assert.equal(readEnv("RELAY_PUBLIC_URL", env), "https://alias.example");
  assert.equal(readEnv("RELAY_S3_BUCKET", env), "bucket-from-alias");
});

test("canonical name wins over alias", () => {
  const env = {
    RELAY_ADMIN_TOKEN: "canonical",
    ADMIN_SECRET: "alias",
  } as NodeJS.ProcessEnv;
  assert.equal(readEnv("RELAY_ADMIN_TOKEN", env), "canonical");
});
