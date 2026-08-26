#!/usr/bin/env node
/**
 * Backup control-plane JSON + optional pg_dump.
 *   node scripts/backup.mjs --out /tmp/relay-backup
 */
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const outIdx = process.argv.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? process.argv[outIdx + 1] : `storage/backups/backup-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

const files = ["storage/control-plane.json", "storage/api-keys.json", "storage/usage.json"];
const copied = [];
for (const f of files) {
  if (existsSync(f)) {
    const dest = join(outDir, f.replace("storage/", ""));
    copyFileSync(f, dest);
    copied.push(f);
  }
}

const manifest = {
  at: new Date().toISOString(),
  files: copied,
  databaseUrlSet: Boolean(process.env.DATABASE_URL),
  pgDump: null,
};
if (process.env.DATABASE_URL) {
  const dump = join(outDir, "relay.sql");
  const r = spawnSync("pg_dump", [process.env.DATABASE_URL, "-f", dump], { encoding: "utf8" });
  manifest.pgDump = r.status === 0 ? dump : { error: r.stderr || "pg_dump missing" };
}

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ok: true, outDir, ...manifest }, null, 2));
