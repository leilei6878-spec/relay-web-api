import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const tests = [
  ...readdirSync(join(root, "src", "lib"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join("src", "lib", entry.name)),
  ...readdirSync(join(root, "src", "lib", "provider"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join("src", "lib", "provider", entry.name)),
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
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, RELAY_SKIP_DB: "1", RELAY_TEST: "1" },
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
