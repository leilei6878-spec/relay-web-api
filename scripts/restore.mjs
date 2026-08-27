#!/usr/bin/env node
/** Restore and verify a version-2 backup produced by scripts/backup.mjs. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

function flagValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    /* Windows and some mounted filesystems do not expose POSIX modes. */
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value)) throw new Error(`unsafe manifest path: ${String(value)}`);
  const normalized = normalize(value.replaceAll("/", sep));
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error(`unsafe manifest path: ${value}`);
  return normalized;
}

const fromValue = flagValue("--from");
if (!fromValue) throw new Error("usage: node scripts/restore.mjs --from <backup-dir> [--storage DIR] [--dry-run]");
const dryRun = process.argv.includes("--dry-run");
const from = resolve(fromValue);
const storageRoot = resolve(flagValue("--storage") || process.env.RELAY_STORAGE_DIR || "storage");
const manifestPath = join(from, "manifest.json");
if (!existsSync(manifestPath)) throw new Error("manifest.json missing — not a Relay backup");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.kind !== "relay-web-api-backup" || manifest.version !== 2) {
  throw new Error("unsupported backup manifest; expected relay-web-api-backup version 2");
}
if (manifest.complete !== true || (manifest.errors || []).length) throw new Error("backup manifest is incomplete");
if (!Array.isArray(manifest.files)) throw new Error("backup manifest files must be an array");

const verifiedFiles = [];
for (const entry of manifest.files) {
  const rel = safeRelativePath(entry.path);
  const source = join(from, "storage", rel);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`backup file missing: ${entry.path}`);
  const bytes = statSync(source).size;
  const digest = sha256(source);
  if (bytes !== entry.bytes) throw new Error(`backup size mismatch: ${entry.path}`);
  if (digest !== entry.sha256) throw new Error(`backup checksum mismatch: ${entry.path}`);
  verifiedFiles.push({ rel, source, bytes, sha256: digest });
}

const database = manifest.database || {};
let dumpPath = null;
if (database.status === "dumped") {
  const dumpName = safeRelativePath(database.dump);
  dumpPath = join(from, dumpName);
  if (!existsSync(dumpPath) || !statSync(dumpPath).isFile()) throw new Error("database dump is missing");
  if (statSync(dumpPath).size !== database.bytes || sha256(dumpPath) !== database.sha256) {
    throw new Error("database dump checksum mismatch");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to restore this database backup");
} else if (database.required) {
  throw new Error(`required database dump is unavailable (status=${database.status || "missing"})`);
}

const plan = {
  ok: true,
  dryRun,
  from,
  storageRoot,
  files: verifiedFiles.map((entry) => ({ path: entry.rel.split(sep).join("/"), bytes: entry.bytes })),
  database: database.status || "not_configured",
  warnings: manifest.warnings || [],
};

if (dryRun) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  if (dumpPath) {
    const bin = process.env.PG_RESTORE_BIN || "pg_restore";
    const result = spawnSync(
      bin,
      ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", process.env.DATABASE_URL, dumpPath],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`pg_restore failed: ${result.error?.message || result.stderr?.trim() || `exit ${String(result.status)}`}`);
    }
  }
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  safeMode(storageRoot, 0o700);
  for (const entry of verifiedFiles) {
    const destination = join(storageRoot, entry.rel);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(entry.source, destination);
    safeMode(destination, 0o600);
  }
  console.log(JSON.stringify({ ...plan, restored: true }, null, 2));
}
