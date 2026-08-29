import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeRelative(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value) || value.includes("\0")) {
    throw new Error("OBJECT_MEDIA_UNSAFE_PATH");
  }
  return value;
}

async function collect(root, dir, output) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || entry.isSymbolicLink()) throw new Error("OBJECT_MEDIA_SYMLINK_FORBIDDEN");
    if (stats.isDirectory()) {
      await collect(root, path, output);
      continue;
    }
    if (!stats.isFile()) throw new Error("OBJECT_MEDIA_NON_FILE_FORBIDDEN");
    output.push({
      path: safeRelative(root, path),
      bytes: stats.size,
      sha256: await sha256File(path),
    });
  }
}

export async function buildObjectMediaManifest(rootInput, at = new Date().toISOString()) {
  const root = resolve(rootInput);
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) throw new Error("OBJECT_MEDIA_ROOT_INVALID");
  const files = [];
  await collect(root, root, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    version: 1,
    kind: "relay-object-media-manifest",
    at: new Date(at).toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || manifest.kind !== "relay-object-media-manifest" || !Array.isArray(manifest.files)) {
    throw new Error("OBJECT_MEDIA_MANIFEST_INVALID");
  }
  if (!Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0 || manifest.fileCount !== manifest.files.length) {
    throw new Error("OBJECT_MEDIA_MANIFEST_COUNT_INVALID");
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) throw new Error("OBJECT_MEDIA_MANIFEST_BYTES_INVALID");
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !file.path || file.path === ".." || file.path.startsWith("../") ||
      isAbsolute(file.path) || file.path.includes("\\") || file.path.includes("\0") || paths.has(file.path)) {
      throw new Error("OBJECT_MEDIA_MANIFEST_PATH_INVALID");
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(String(file.sha256))) {
      throw new Error("OBJECT_MEDIA_MANIFEST_ENTRY_INVALID");
    }
    paths.add(file.path);
  }
  if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) !== manifest.totalBytes) {
    throw new Error("OBJECT_MEDIA_MANIFEST_BYTES_MISMATCH");
  }
  return manifest;
}

export async function verifyObjectMediaManifest(root, manifestInput) {
  const expected = validateManifest(manifestInput);
  const actual = await buildObjectMediaManifest(root, expected.at);
  if (actual.fileCount !== expected.fileCount || actual.totalBytes !== expected.totalBytes) {
    throw new Error("OBJECT_MEDIA_RESTORE_SUMMARY_MISMATCH");
  }
  for (let index = 0; index < expected.files.length; index += 1) {
    const wanted = expected.files[index];
    const got = actual.files[index];
    if (!got || got.path !== wanted.path || got.bytes !== wanted.bytes || got.sha256 !== wanted.sha256) {
      throw new Error("OBJECT_MEDIA_RESTORE_CONTENT_MISMATCH");
    }
  }
  return { ok: true, fileCount: actual.fileCount, totalBytes: actual.totalBytes };
}

export async function writeObjectMediaManifest(path, manifest) {
  validateManifest(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

