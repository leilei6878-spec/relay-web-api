import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const tests = readdirSync(join(root, "src/lib"))
  .filter((name) => (name.startsWith("saas-") || name.startsWith("commercial-") || name === "official-providers.test.ts") && name.endsWith(".test.ts"))
  .map((name) => join("src/lib", name))
  .sort();

const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./scripts/register-ts-ext.mjs", "--test", ...tests], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, RELAY_TEST: "1", RELAY_SKIP_DB: "1", NODE_ENV: "test" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
