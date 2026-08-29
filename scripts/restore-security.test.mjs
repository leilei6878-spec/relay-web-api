import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runRestore(args, env = {}) {
  return spawnSync(process.execPath, [resolve(root, "scripts", "restore.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "", ...env },
  });
}

test("restore dry-run verifies a database archive without requiring a destination database", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-restore-db-dry-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dump = Buffer.from("synthetic-custom-dump-for-checksum-only");
  writeFileSync(join(dir, "relay.dump"), dump);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    version: 2, kind: "relay-web-api-backup", complete: true, errors: [], warnings: [], files: [],
    database: {
      required: true, status: "dumped", dump: "relay.dump", bytes: dump.length,
      sha256: createHash("sha256").update(dump).digest("hex"),
    },
  }));
  const dryRun = runRestore(["--from", dir, "--storage", join(dir, "unused"), "--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.equal(JSON.parse(dryRun.stdout).database, "dumped");
  const actual = runRestore(["--from", dir, "--storage", join(dir, "must-not-exist")]);
  assert.notEqual(actual.status, 0);
  assert.match(actual.stderr, /DATABASE_URL is required/);
});

test("restore rejects a symlinked parent that escapes the backup storage root", (t) => {
  if (process.platform === "win32") return t.skip("Windows symlink creation may require a user policy outside this test");
  const dir = mkdtempSync(join(tmpdir(), "relay-restore-symlink-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outside = join(dir, "outside");
  const backup = join(dir, "backup");
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(backup, "storage"), { recursive: true });
  const bytes = Buffer.from("outside-secret");
  writeFileSync(join(outside, "secret.bin"), bytes);
  symlinkSync(outside, join(backup, "storage", "escaped"));
  writeFileSync(join(backup, "manifest.json"), JSON.stringify({
    version: 2, kind: "relay-web-api-backup", complete: true, errors: [], warnings: [],
    files: [{ path: "escaped/secret.bin", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
    database: { required: false, status: "not_configured" },
  }));
  const rejected = runRestore(["--from", backup, "--storage", join(dir, "restore"), "--dry-run"]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /escapes storage root/);
});

