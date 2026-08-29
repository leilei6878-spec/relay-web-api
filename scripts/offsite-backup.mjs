#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} required`);
  return value;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.status}`);
}

function capture(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: "utf8", env, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
  }
  return result.stdout.trim();
}

const targetEndpoint = required("RELAY_BACKUP_S3_ENDPOINT");
const targetBucket = required("RELAY_BACKUP_S3_BUCKET");
const targetKey = required("RELAY_BACKUP_S3_ACCESS_KEY");
const targetSecret = required("RELAY_BACKUP_S3_SECRET_KEY");
const sourceEndpoint = required("RELAY_S3_ENDPOINT");
const sourceBucket = required("RELAY_S3_BUCKET");
const sourceKey = required("RELAY_S3_ACCESS_KEY");
const sourceSecret = required("RELAY_S3_SECRET_KEY");
required("DATABASE_URL");

const at = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(process.argv[2] || process.env.RELAY_BACKUP_LOCAL_DIR || "/opt/backups");
const output = join(outputRoot, `relay-offsite-${at}`);
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
run(process.execPath, [resolve("scripts/backup.mjs"), "--storage", resolve(process.env.RELAY_STORAGE_DIR || "storage"), "--out", output, "--require-db"]);

const bundle = join(output, "source.bundle");
if (capture("git", ["rev-parse", "--is-shallow-repository"]) === "true") {
  throw new Error("offsite backup refuses a shallow Git repository; fetch complete history before backup");
}
run("git", ["fsck", "--full"]);
const branch = capture("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
  throw new Error("unsafe Git branch for backup");
}
run("git", ["bundle", "create", bundle, `refs/heads/${branch}`, "--tags"]);
run("git", ["bundle", "verify", bundle]);
const gitVerifyDir = mkdtempSync(join(tmpdir(), "relay-git-restore-"));
try {
  const restored = join(gitVerifyDir, "repository");
  run("git", ["clone", "--quiet", "--branch", branch, bundle, restored]);
  run("git", ["-C", restored, "fsck", "--full"]);
  if (capture("git", ["-C", restored, "rev-parse", "HEAD"]) !== capture("git", ["rev-parse", "HEAD"])) {
    throw new Error("restored Git bundle HEAD mismatch");
  }
} finally {
  rmSync(gitVerifyDir, { recursive: true, force: true });
}
const digest = createHash("sha256").update(readFileSync(bundle)).digest("hex");
writeFileSync(join(output, "source.bundle.sha256"), `${digest}  source.bundle\n`, { mode: 0o600 });

const configDir = mkdtempSync(join(tmpdir(), "relay-mc-"));
try {
  const env = { ...process.env, MC_CONFIG_DIR: configDir };
  run("mc", ["alias", "set", "source", sourceEndpoint, sourceKey, sourceSecret], env);
  run("mc", ["alias", "set", "target", targetEndpoint, targetKey, targetSecret], env);
  run("mc", ["mb", "--ignore-existing", `target/${targetBucket}`], env);
  const remotePrefix = `target/${targetBucket}/${basename(output)}`;
  run("mc", ["cp", "--recursive", `${output}/`, `${remotePrefix}/control-plane/`], env);
  run("mc", ["mirror", "--overwrite", `source/${sourceBucket}`, `${remotePrefix}/object-media`], env);
  run("mc", ["stat", `${remotePrefix}/control-plane/manifest.json`], env);
  console.log(JSON.stringify({ ok: true, output, remotePrefix }));
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
