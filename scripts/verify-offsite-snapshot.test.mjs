import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildObjectMediaManifest, writeObjectMediaManifest } from "./object-media-manifest.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(path) {
  return createHash("sha256").update(requireFile(path)).digest("hex");
}

function requireFile(path) {
  return readFileSync(path);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function verify(root) {
  return spawnSync(process.execPath, ["scripts/verify-offsite-snapshot.mjs", "--from", root], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: "" },
  });
}

test("downloaded offsite snapshot verifies control plane, Git and exact object content", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-offsite-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const control = join(root, "control-plane");
  const objects = join(root, "object-media");
  const repository = join(root, "source-repository");
  mkdirSync(join(control, "storage"), { recursive: true });
  mkdirSync(join(objects, "nested"), { recursive: true });
  mkdirSync(repository, { recursive: true });
  writeFileSync(join(control, "storage", "secrets.json"), "encrypted-test\n");
  writeFileSync(join(objects, "image.bin"), Buffer.from([1, 2, 3, 4]));
  writeFileSync(join(objects, "nested", "result.txt"), "result\n");

  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "backup-test@example.test"]);
  git(repository, ["config", "user.name", "Backup Test"]);
  writeFileSync(join(repository, "README.md"), "offsite snapshot\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "snapshot"]);
  const sourceHead = git(repository, ["rev-parse", "HEAD"]);
  const bundlePath = join(control, "source.bundle");
  git(repository, ["bundle", "create", bundlePath, "refs/heads/main"]);
  const bundleSha256 = sha256(bundlePath);
  writeFileSync(join(control, "source.bundle.sha256"), `${bundleSha256}  source.bundle\n`);

  const stored = join(control, "storage", "secrets.json");
  const backupManifest = {
    version: 2,
    kind: "relay-web-api-backup",
    at: "2026-08-30T00:00:00.000Z",
    complete: true,
    files: [{ path: "secrets.json", bytes: requireFile(stored).length, sha256: sha256(stored) }],
    database: { required: false, status: "not_configured", dump: null, sha256: null, bytes: 0 },
    warnings: [],
    errors: [],
  };
  const backupManifestPath = join(control, "manifest.json");
  writeFileSync(backupManifestPath, JSON.stringify(backupManifest));
  const objectManifest = await buildObjectMediaManifest(objects, "2026-08-30T00:00:00.000Z");
  const objectManifestPath = join(control, "object-media.manifest.json");
  await writeObjectMediaManifest(objectManifestPath, objectManifest);
  const offsite = {
    version: 1,
    kind: "relay-offsite-backup",
    complete: true,
    at: "2026-08-30T00:00:00.000Z",
    verifiedAt: "2026-08-30T00:01:00.000Z",
    branch: "main",
    sourceHead,
    controlPlaneManifestSha256: sha256(backupManifestPath),
    sourceBundleSha256: bundleSha256,
    objectMediaManifestSha256: sha256(objectManifestPath),
    objectMediaFileCount: objectManifest.fileCount,
    objectMediaTotalBytes: objectManifest.totalBytes,
  };
  const offsitePath = join(control, "offsite-manifest.json");
  writeFileSync(offsitePath, JSON.stringify(offsite));
  writeFileSync(join(control, "offsite-manifest.sha256"), `${sha256(offsitePath)}  offsite-manifest.json\n`);

  const accepted = verify(root);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.sourceHead, sourceHead);
  assert.equal(result.storageFiles, 1);
  assert.equal(result.objectMediaFiles, 2);
  assert.equal(result.objectMediaBytes, 11);
  assert.equal(result.offsiteManifestSha256, sha256(offsitePath));

  writeFileSync(join(objects, "image.bin"), "tampered");
  const rejected = verify(root);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /OBJECT_MEDIA_RESTORE_(CONTENT|SUMMARY)_MISMATCH/);
});
