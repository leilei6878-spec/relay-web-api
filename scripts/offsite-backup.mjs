#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildObjectMediaManifest,
  verifyObjectMediaManifest,
  writeObjectMediaManifest,
} from "./object-media-manifest.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} required`);
  return value;
}

function endpoint(name, value, allowHttp) {
  const parsed = new URL(value);
  if ((!allowHttp && parsed.protocol !== "https:") || (allowHttp && !["http:", "https:"].includes(parsed.protocol)) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname || !["", "/"].includes(parsed.pathname)) {
    throw new Error(`${name} must be a credential-free ${allowHttp ? "HTTP(S)" : "HTTPS"} origin`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function bucket(name, value) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) || value.includes("..")) {
    throw new Error(`${name} is not a safe S3 bucket name`);
  }
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

const targetEndpoint = endpoint("RELAY_BACKUP_S3_ENDPOINT", required("RELAY_BACKUP_S3_ENDPOINT"), false);
const targetBucket = bucket("RELAY_BACKUP_S3_BUCKET", required("RELAY_BACKUP_S3_BUCKET"));
const targetKey = required("RELAY_BACKUP_S3_ACCESS_KEY");
const targetSecret = required("RELAY_BACKUP_S3_SECRET_KEY");
const sourceEndpoint = endpoint("RELAY_S3_ENDPOINT", required("RELAY_S3_ENDPOINT"), true);
const sourceBucket = bucket("RELAY_S3_BUCKET", required("RELAY_S3_BUCKET"));
const sourceKey = required("RELAY_S3_ACCESS_KEY");
const sourceSecret = required("RELAY_S3_SECRET_KEY");
required("DATABASE_URL");
const mcBin = process.env.MC_BIN?.trim() || "mc";
if (sourceEndpoint.replace(/\/$/, "") === targetEndpoint.replace(/\/$/, "") && sourceBucket === targetBucket) {
  throw new Error("offsite backup target must differ from the production object bucket");
}

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
const sourceHead = capture("git", ["rev-parse", "HEAD"]);
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
  if (capture("git", ["-C", restored, "rev-parse", "HEAD"]) !== sourceHead) {
    throw new Error("restored Git bundle HEAD mismatch");
  }
} finally {
  rmSync(gitVerifyDir, { recursive: true, force: true });
}
const digest = createHash("sha256").update(readFileSync(bundle)).digest("hex");
writeFileSync(join(output, "source.bundle.sha256"), `${digest}  source.bundle\n`, { mode: 0o600 });

const configDir = mkdtempSync(join(tmpdir(), "relay-mc-"));
const objectDir = mkdtempSync(join(tmpdir(), "relay-object-backup-"));
try {
  const env = { ...process.env, MC_CONFIG_DIR: configDir };
  run(mcBin, ["alias", "set", "source", sourceEndpoint, sourceKey, sourceSecret], env);
  run(mcBin, ["alias", "set", "target", targetEndpoint, targetKey, targetSecret], env);
  run(mcBin, ["mb", "--ignore-existing", `target/${targetBucket}`], env);
  const sourceStage = join(objectDir, "source");
  const restoredStage = join(objectDir, "restored");
  const controlVerify = join(objectDir, "control-verify");
  mkdirSync(sourceStage, { recursive: true, mode: 0o700 });
  mkdirSync(restoredStage, { recursive: true, mode: 0o700 });
  mkdirSync(controlVerify, { recursive: true, mode: 0o700 });
  run(mcBin, ["mirror", "--overwrite", "--remove", `source/${sourceBucket}`, sourceStage], env);
  const objectManifest = await buildObjectMediaManifest(sourceStage);
  const objectManifestPath = join(output, "object-media.manifest.json");
  await writeObjectMediaManifest(objectManifestPath, objectManifest);
  const backupManifestPath = join(output, "manifest.json");
  const backupManifest = JSON.parse(readFileSync(backupManifestPath, "utf8"));
  if (backupManifest.complete !== true) throw new Error("control-plane backup is incomplete");
  const offsiteManifestPath = join(output, "offsite-manifest.json");
  const offsiteManifest = {
    version: 1,
    kind: "relay-offsite-backup",
    complete: false,
    at: new Date().toISOString(),
    branch,
    sourceHead,
    controlPlaneManifestSha256: createHash("sha256").update(readFileSync(backupManifestPath)).digest("hex"),
    sourceBundleSha256: digest,
    objectMediaManifestSha256: createHash("sha256").update(readFileSync(objectManifestPath)).digest("hex"),
    objectMediaFileCount: objectManifest.fileCount,
    objectMediaTotalBytes: objectManifest.totalBytes,
  };
  writeFileSync(offsiteManifestPath, `${JSON.stringify(offsiteManifest, null, 2)}\n`, { mode: 0o600 });
  const remotePrefix = `target/${targetBucket}/${basename(output)}`;
  run(mcBin, ["cp", "--recursive", `${output}/`, `${remotePrefix}/control-plane/`], env);
  if (objectManifest.fileCount > 0) {
    run(mcBin, ["mirror", "--overwrite", "--remove", sourceStage, `${remotePrefix}/object-media`], env);
    run(mcBin, ["mirror", "--overwrite", "--remove", `${remotePrefix}/object-media`, restoredStage], env);
  }
  await verifyObjectMediaManifest(restoredStage, objectManifest);
  offsiteManifest.complete = true;
  offsiteManifest.verifiedAt = new Date().toISOString();
  writeFileSync(offsiteManifestPath, `${JSON.stringify(offsiteManifest, null, 2)}\n`, { mode: 0o600 });
  const offsiteManifestSha256 = createHash("sha256").update(readFileSync(offsiteManifestPath)).digest("hex");
  const offsiteDigestPath = join(output, "offsite-manifest.sha256");
  writeFileSync(offsiteDigestPath, `${offsiteManifestSha256}  offsite-manifest.json\n`, { mode: 0o600 });
  run(mcBin, ["cp", offsiteManifestPath, `${remotePrefix}/control-plane/offsite-manifest.json`], env);
  run(mcBin, ["cp", offsiteDigestPath, `${remotePrefix}/control-plane/offsite-manifest.sha256`], env);
  const restoredOffsiteManifest = join(controlVerify, "offsite-manifest.json");
  const restoredOffsiteDigest = join(controlVerify, "offsite-manifest.sha256");
  const restoredObjectManifest = join(controlVerify, "object-media.manifest.json");
  run(mcBin, ["cp", `${remotePrefix}/control-plane/offsite-manifest.json`, restoredOffsiteManifest], env);
  run(mcBin, ["cp", `${remotePrefix}/control-plane/offsite-manifest.sha256`, restoredOffsiteDigest], env);
  run(mcBin, ["cp", `${remotePrefix}/control-plane/object-media.manifest.json`, restoredObjectManifest], env);
  if (createHash("sha256").update(readFileSync(restoredOffsiteManifest)).digest("hex") !==
      offsiteManifestSha256 || readFileSync(restoredOffsiteDigest, "utf8") !== `${offsiteManifestSha256}  offsite-manifest.json\n`) {
    throw new Error("restored offsite manifest checksum mismatch");
  }
  if (createHash("sha256").update(readFileSync(restoredObjectManifest)).digest("hex") !== offsiteManifest.objectMediaManifestSha256) {
    throw new Error("restored object-media manifest checksum mismatch");
  }
  run(mcBin, ["stat", `${remotePrefix}/control-plane/manifest.json`], env);
  run(mcBin, ["stat", `${remotePrefix}/control-plane/offsite-manifest.json`], env);
  console.log(JSON.stringify({
    ok: true,
    output,
    remotePrefix,
    sourceHead,
    objectMediaFileCount: objectManifest.fileCount,
    objectMediaTotalBytes: objectManifest.totalBytes,
    objectMediaRestoreVerified: true,
    offsiteManifestSha256,
  }));
} finally {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(objectDir, { recursive: true, force: true });
}
