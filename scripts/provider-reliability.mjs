#!/usr/bin/env node
/**
 * Provider reliability workload (no live ChatGPT/Gemini session required).
 * Runs adapter, page-state, image-guard, session CAS, SSE, concurrency, worker compile.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const files = [
  "src/lib/provider/adapter.test.ts",
  "src/lib/provider/concurrency.test.ts",
  "src/lib/provider/sse-contract.test.ts",
  "src/lib/fault-matrix.test.ts",
  "src/lib/worker-script.test.ts",
  "src/lib/circuit.test.ts",
  "src/lib/sse-runtime.test.ts",
  "src/lib/media-store.test.ts",
];

const started = Date.now();
const env = { ...process.env, RELAY_SKIP_DB: "1" };
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-ts-ext.mjs", "--test", "--test-reporter=spec", ...files],
  { encoding: "utf8", env, cwd: "/workspace" },
);
const report = {
  at: new Date().toISOString(),
  durationMs: Date.now() - started,
  status: result.status,
  live_chatgpt: "NOT_EXECUTED",
  live_gemini: "NOT_EXECUTED",
  stdout: (result.stdout || "").slice(-4000),
  stderr: (result.stderr || "").slice(-2000),
};
mkdirSync("/workspace/storage", { recursive: true });
writeFileSync("/workspace/storage/provider-reliability.json", JSON.stringify(report, null, 2));
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status === 0 ? 0 : 1);
