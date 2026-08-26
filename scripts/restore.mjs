#!/usr/bin/env node
/**
 * Restore a backup directory produced by scripts/backup.mjs.
 *   node scripts/restore.mjs --from /tmp/relay-backup [--dry-run]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const fromIdx = process.argv.indexOf("--from");
if (fromIdx < 0) {
  console.error("usage: node scripts/restore.mjs --from <backup-dir> [--dry-run]");
  process.exit(1);
}
const dry = process.argv.includes("--dry-run");
const from = resolve(process.argv[fromIdx + 1]);
const manifestPath = join(from, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("manifest.json missing — not a Relay backup");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
console.log("restore plan", manifest);
if (dry) {
  console.log("dry-run complete");
  process.exit(0);
}
mkdirSync("storage", { recursive: true });
for (const name of ["control-plane.json", "api-keys.json", "usage.json"]) {
  const src = join(from, name);
  if (existsSync(src)) copyFileSync(src, join("storage", name));
}
const sql = join(from, "relay.sql");
if (existsSync(sql) && process.env.DATABASE_URL) {
  const r = spawnSync("psql", [process.env.DATABASE_URL, "-f", sql], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
}
console.log("restore complete");
