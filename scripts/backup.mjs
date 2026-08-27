#!/usr/bin/env node
/**
 * Create a verified Relay backup. Production backups are incomplete unless
 * pg_dump succeeds; session and encrypted-secret files are included.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`backup refuses symlink: ${path}`);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const storageRoot = resolve(flagValue("--storage") || process.env.RELAY_STORAGE_DIR || "storage");
const outDir = resolve(flagValue("--out") || join(storageRoot, "backups", `backup-${Date.now()}`));
const requireDb = process.argv.includes("--require-db") || process.env.NODE_ENV === "production";
const manifestPath = join(outDir, "manifest.json");
mkdirSync(outDir, { recursive: true, mode: 0o700 });
safeMode(outDir, 0o700);

const manifest = {
  version: 2,
  kind: "relay-web-api-backup",
  at: new Date().toISOString(),
  complete: false,
  storageRoot: "storage",
  files: [],
  databaseUrlSet: Boolean(process.env.DATABASE_URL),
  database: {
    required: requireDb || Boolean(process.env.DATABASE_URL),
    status: "not_configured",
    dump: null,
    sha256: null,
    bytes: 0,
  },
  external: {
    environmentSecrets: "BACK_UP_SEPARATELY",
    objectMedia: "BACK_UP_BUCKET_SEPARATELY",
  },
  warnings: [],
  errors: [],
};

try {
  const fixed = [
    "control-plane.json",
    "api-keys.json",
    "usage.json",
    "jobs.json",
    "secrets.json",
    "admin-token.txt",
    "worker-token.txt",
  ];
  const sources = [
    ...fixed.map((name) => join(storageRoot, name)).filter((path) => existsSync(path)),
    ...listFiles(join(storageRoot, "sessions")),
  ];
  for (const source of sources) {
    const rel = relative(storageRoot, source);
    if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error(`unsafe backup path: ${source}`);
    const dest = join(outDir, "storage", rel);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(source, dest);
    safeMode(dest, 0o600);
    const stats = statSync(dest);
    manifest.files.push({ path: rel.split(sep).join("/"), bytes: stats.size, sha256: sha256(dest) });
  }

  if (!manifest.files.some((entry) => entry.path === "secrets.json")) {
    manifest.warnings.push("storage/secrets.json was absent");
  }
  if (!manifest.files.some((entry) => entry.path.startsWith("sessions/"))) {
    manifest.warnings.push("no storage/sessions files were present");
  }

  if (process.env.DATABASE_URL) {
    const dumpName = "relay.dump";
    const dumpPath = join(outDir, dumpName);
    const bin = process.env.PG_DUMP_BIN || "pg_dump";
    const result = spawnSync(
      bin,
      ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpPath, process.env.DATABASE_URL],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.error || result.status !== 0 || !existsSync(dumpPath) || statSync(dumpPath).size === 0) {
      manifest.database.status = "failed";
      manifest.errors.push(
        `pg_dump failed: ${result.error?.message || result.stderr?.trim() || `exit ${String(result.status)}`}`,
      );
    } else {
      safeMode(dumpPath, 0o600);
      manifest.database.status = "dumped";
      manifest.database.dump = dumpName;
      manifest.database.bytes = statSync(dumpPath).size;
      manifest.database.sha256 = sha256(dumpPath);
    }
  } else if (requireDb) {
    manifest.database.status = "missing_database_url";
    manifest.errors.push("DATABASE_URL is required for a production/--require-db backup");
  }

  manifest.complete = manifest.errors.length === 0;
} catch (error) {
  manifest.errors.push(error instanceof Error ? error.message : String(error));
  manifest.complete = false;
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
safeMode(manifestPath, 0o600);
const result = { ok: manifest.complete, outDir, ...manifest };
if (manifest.complete) console.log(JSON.stringify(result, null, 2));
else {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
