#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyObjectMediaManifest } from "./object-media-manifest.mjs";

function flagValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function regular(path, label) {
  if (!existsSync(path)) throw new Error(`${label} missing`);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return path;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(regular(path, path))).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
  }
  return result.stdout.trim();
}

const fromValue = flagValue("--from");
if (!fromValue) throw new Error("usage: node scripts/verify-offsite-snapshot.mjs --from <downloaded-prefix-dir>");
const root = resolve(fromValue);
const rootStats = existsSync(root) ? lstatSync(root) : null;
if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) throw new Error("offsite snapshot root must be a regular directory");
const control = join(root, "control-plane");
const objects = join(root, "object-media");
const controlStats = existsSync(control) ? lstatSync(control) : null;
const objectStats = existsSync(objects) ? lstatSync(objects) : null;
if (!controlStats?.isDirectory() || controlStats.isSymbolicLink() || !objectStats?.isDirectory() || objectStats.isSymbolicLink()) {
  throw new Error("offsite snapshot requires non-symlink control-plane and object-media directories");
}

const manifestPath = regular(join(control, "offsite-manifest.json"), "offsite manifest");
const offsiteDigestPath = regular(join(control, "offsite-manifest.sha256"), "offsite manifest digest");
const offsiteManifestSha256 = sha256(manifestPath);
if (readFileSync(offsiteDigestPath, "utf8") !== `${offsiteManifestSha256}  offsite-manifest.json\n`) {
  throw new Error("offsite manifest digest file mismatch");
}
const offsite = JSON.parse(readFileSync(manifestPath, "utf8"));
if (offsite?.version !== 1 || offsite.kind !== "relay-offsite-backup" || offsite.complete !== true ||
    !/^[0-9a-f]{7,64}$/.test(String(offsite.sourceHead)) ||
    !/^[A-Za-z0-9._/-]+$/.test(String(offsite.branch)) || String(offsite.branch).startsWith("-") || String(offsite.branch).includes("..") ||
    !/^[0-9a-f]{64}$/.test(String(offsite.controlPlaneManifestSha256)) ||
    !/^[0-9a-f]{64}$/.test(String(offsite.sourceBundleSha256)) ||
    !/^[0-9a-f]{64}$/.test(String(offsite.objectMediaManifestSha256))) {
  throw new Error("offsite manifest is incomplete or invalid");
}

const backupManifestPath = regular(join(control, "manifest.json"), "control-plane manifest");
const bundlePath = regular(join(control, "source.bundle"), "source bundle");
const bundleDigestPath = regular(join(control, "source.bundle.sha256"), "source bundle digest");
const objectManifestPath = regular(join(control, "object-media.manifest.json"), "object-media manifest");
if (sha256(backupManifestPath) !== offsite.controlPlaneManifestSha256 ||
    sha256(bundlePath) !== offsite.sourceBundleSha256 ||
    sha256(objectManifestPath) !== offsite.objectMediaManifestSha256) {
  throw new Error("offsite control artifact checksum mismatch");
}
if (readFileSync(bundleDigestPath, "utf8") !== `${offsite.sourceBundleSha256}  source.bundle\n`) {
  throw new Error("source bundle digest file mismatch");
}

const objectManifest = JSON.parse(readFileSync(objectManifestPath, "utf8"));
const objectResult = await verifyObjectMediaManifest(objects, objectManifest);
if (objectResult.fileCount !== Number(offsite.objectMediaFileCount) ||
    objectResult.totalBytes !== Number(offsite.objectMediaTotalBytes)) {
  throw new Error("offsite object summary mismatch");
}

const verifyRoot = mkdtempSync(join(tmpdir(), "relay-offsite-verify-"));
try {
  const gitBin = process.env.GIT_BIN?.trim() || "git";
  run(gitBin, ["bundle", "verify", bundlePath]);
  const repository = join(verifyRoot, "repository");
  run(gitBin, ["clone", "--quiet", "--branch", String(offsite.branch), bundlePath, repository]);
  run(gitBin, ["-C", repository, "fsck", "--full"]);
  if (run(gitBin, ["-C", repository, "rev-parse", "HEAD"]) !== offsite.sourceHead) {
    throw new Error("offsite restored Git HEAD mismatch");
  }
  const restoreResult = spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), "restore.mjs"), "--from", control, "--storage", join(verifyRoot, "storage"), "--dry-run"],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, DATABASE_URL: "" } },
  );
  if (restoreResult.error || restoreResult.status !== 0) {
    throw new Error(`control-plane restore verification failed: ${restoreResult.error?.message || restoreResult.stderr?.trim() || restoreResult.status}`);
  }
  const restorePlan = JSON.parse(restoreResult.stdout);
  if (restorePlan.ok !== true || restorePlan.dryRun !== true) throw new Error("control-plane restore dry-run was not verified");
  console.log(JSON.stringify({
    ok: true,
    sourceHead: offsite.sourceHead,
    branch: offsite.branch,
    database: restorePlan.database,
    storageFiles: restorePlan.files.length,
    objectMediaFiles: objectResult.fileCount,
    objectMediaBytes: objectResult.totalBytes,
    offsiteManifestSha256,
  }));
} finally {
  rmSync(verifyRoot, { recursive: true, force: true });
}
