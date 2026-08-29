import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildObjectMediaManifest,
  verifyObjectMediaManifest,
  writeObjectMediaManifest,
} from "./object-media-manifest.mjs";

test("object-media manifest is deterministic, content-addressed and round-trips nested files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-object-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "z.bin"), Buffer.from([9, 8, 7]));
  writeFileSync(join(root, "nested", "a.txt"), "relay-object\n");
  const manifest = await buildObjectMediaManifest(root, "2026-08-30T00:00:00.000Z");
  assert.equal(manifest.kind, "relay-object-media-manifest");
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.files.map((entry) => entry.path), ["nested/a.txt", "z.bin"]);
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.totalBytes, 16);
  assert.ok(manifest.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));
  assert.ok(manifest.files.every((entry) => !entry.path.includes("\\") && !entry.path.startsWith("/")));
  assert.deepEqual(await verifyObjectMediaManifest(root, manifest), { ok: true, fileCount: 2, totalBytes: 16 });
  const manifestPath = join(root, "..", `manifest-${process.pid}.json`);
  t.after(() => rmSync(manifestPath, { force: true }));
  await writeObjectMediaManifest(manifestPath, manifest);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), manifest);
});

test("object-media verification rejects tampering, missing/extra files and unsafe manifests", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-object-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "one.bin"), "original");
  const manifest = await buildObjectMediaManifest(root, "2026-08-30T00:00:00.000Z");
  writeFileSync(join(root, "one.bin"), "tampered");
  await assert.rejects(() => verifyObjectMediaManifest(root, manifest), /RESTORE_CONTENT_MISMATCH/);
  writeFileSync(join(root, "one.bin"), "original");
  writeFileSync(join(root, "extra.bin"), "extra");
  await assert.rejects(() => verifyObjectMediaManifest(root, manifest), /RESTORE_SUMMARY_MISMATCH/);
  rmSync(join(root, "extra.bin"));
  const unsafe = structuredClone(manifest);
  unsafe.files[0].path = "../escape";
  await assert.rejects(() => verifyObjectMediaManifest(root, unsafe), /MANIFEST_PATH_INVALID/);
  const duplicate = structuredClone(manifest);
  duplicate.files.push({ ...duplicate.files[0] });
  duplicate.fileCount += 1;
  duplicate.totalBytes += duplicate.files[0].bytes;
  await assert.rejects(() => verifyObjectMediaManifest(root, duplicate), /MANIFEST_PATH_INVALID/);
});

test("object-media manifest refuses symlinks instead of following data outside the snapshot", async (t) => {
  if (process.platform === "win32") return t.skip("Windows symlink creation may require a user policy outside this test");
  const root = mkdtempSync(join(tmpdir(), "relay-object-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "real.bin"), "real");
  symlinkSync(join(root, "real.bin"), join(root, "link.bin"));
  await assert.rejects(() => buildObjectMediaManifest(root), /SYMLINK_FORBIDDEN/);
});

test("offsite backup captures locally, uploads, downloads and verifies object bytes before success", () => {
  const source = readFileSync("scripts/offsite-backup.mjs", "utf8");
  assert.match(source, /mirror", "--overwrite", "--remove", `source\/\$\{sourceBucket\}`, sourceStage/);
  assert.match(source, /buildObjectMediaManifest\(sourceStage\)/);
  assert.match(source, /objectMediaManifestSha256/);
  assert.match(source, /complete: false/);
  assert.match(source, /verifyObjectMediaManifest\(restoredStage, objectManifest\)/);
  assert.match(source, /offsiteManifest\.complete = true/);
  assert.match(source, /restored offsite manifest checksum mismatch/);
  assert.match(source, /offsite-manifest\.sha256/);
  assert.match(source, /offsiteManifestSha256/);
  assert.match(source, /objectMediaRestoreVerified: true/);
  assert.match(source, /offsite backup target must differ from the production object bucket/);
  assert.match(source, /credential-free/);
  assert.match(source, /not a safe S3 bucket name/);
});
