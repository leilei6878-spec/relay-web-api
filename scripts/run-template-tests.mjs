import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

const tests = [
  join("scripts", "backup-restore.test.mjs"),
  join("scripts", "browser-smoke-verdict.test.mjs"),
  join("scripts", "migrate-json.test.mjs"),
  join("scripts", "migration-plan.test.mjs"),
  join("scripts", "openapi-contract.test.mjs"),
  join("scripts", "pg-cutover.test.mjs"),
  join("scripts", "pg-reclaim.test.mjs"),
  join("scripts", "qa-hardening.test.mjs"),
  join("scripts", "secret-scan.test.mjs"),
  join("scripts", "sign-out-plan.test.mjs"),
  join("src", "lib", "app-data", "app-data.test.ts"),
  join("src", "lib", "auth", "gate-identity.test.ts"),
].sort();

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--import",
    "./scripts/register-ts-ext.mjs",
    "--test",
    ...tests,
  ],
  { cwd: root, stdio: "inherit", env: process.env },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
