import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const root = resolve(import.meta.dirname, "..");

function runScript(name, args, env = {}) {
  return spawnSync(process.execPath, [resolve(root, "scripts", name), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "", ...env },
  });
}

test("backup/restore: PGlite dump JSON snapshot into a new database and verify rows", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of ["0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql", "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql", "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql", "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql", "0017_email_delivery_outbox.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql", "0020_tenant_privacy_rights.sql", "0021_customer_session_security.sql", "0022_staged_mfa_enrollment.sql", "0023_customer_password_change.sql"]) {
    await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  await pg.query(
    `insert into relay_accounts (id, platform, email, remark, status, created_at)
     values ('ac-backup', 'chatgpt', 'restore@test', '', 'healthy', now())`,
  );
  await pg.query(`insert into relay_requests (id, provider, model, status) values ('R-b', 'chatgpt', 'gpt-5.6', 'done')`);
  const dump = await pg.query("select id, email, status from relay_accounts where id=$1", ["ac-backup"]);
  assert.equal(dump.rows[0].email, "restore@test");

  const dir = join(tmpdir(), `relay-bak-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const snapshot = {
    accounts: dump.rows,
    requests: (await pg.query("select id, status from relay_requests")).rows,
  };
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snapshot));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), files: ["snapshot.json"] }));

  const pg2 = new PGlite();
  await pg2.waitReady;
  for (const name of ["0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql", "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql", "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql", "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql", "0017_email_delivery_outbox.sql", "0018_legal_acceptance.sql", "0019_legal_reconsent.sql", "0020_tenant_privacy_rights.sql", "0021_customer_session_security.sql", "0022_staged_mfa_enrollment.sql", "0023_customer_password_change.sql"]) {
    await pg2.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  const snap = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
  for (const a of snap.accounts) {
    await pg2.query(
      `insert into relay_accounts (id, platform, email, remark, status, created_at)
       values ($1,'chatgpt',$2,'','healthy', now())`,
      [a.id, a.email],
    );
  }
  for (const r of snap.requests) {
    await pg2.query(`insert into relay_requests (id, provider, model, status) values ($1,'chatgpt','gpt-5.6',$2)`, [r.id, r.status]);
  }
  const got = await pg2.query("select email from relay_accounts where id=$1", ["ac-backup"]);
  assert.equal(got.rows[0].email, "restore@test");
  const req = await pg2.query("select status from relay_requests where id=$1", ["R-b"]);
  assert.equal(req.rows[0].status, "done");
  const ver = await pg2.query("select value from relay_meta where key='schema_version'");
  assert.equal(ver.rows[0].value, "23");
  rmSync(dir, { recursive: true, force: true });
});

test("backup CLI includes secrets and sessions; restore verifies hashes before copying", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-backup-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const backup = join(dir, "backup");
  const restored = join(dir, "restored");
  mkdirSync(join(source, "sessions"), { recursive: true });
  writeFileSync(join(source, "control-plane.json"), JSON.stringify({ accounts: [{ id: "a1" }] }));
  writeFileSync(join(source, "api-keys.json"), JSON.stringify({ apiKey: "redacted-test" }));
  writeFileSync(join(source, "secrets.json"), JSON.stringify({ encrypted: "ciphertext" }));
  writeFileSync(join(source, "sessions", "a1.json"), JSON.stringify({ cookies: [{ name: "session", value: "credential" }] }));

  const created = runScript("backup.mjs", ["--storage", source, "--out", backup]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.complete, true);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path).sort(),
    ["api-keys.json", "control-plane.json", "secrets.json", "sessions/a1.json"],
  );

  const dryRun = runScript("restore.mjs", ["--from", backup, "--storage", restored, "--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  const restoredRun = runScript("restore.mjs", ["--from", backup, "--storage", restored]);
  assert.equal(restoredRun.status, 0, restoredRun.stderr || restoredRun.stdout);
  assert.deepEqual(
    JSON.parse(readFileSync(join(restored, "sessions", "a1.json"), "utf8")),
    { cookies: [{ name: "session", value: "credential" }] },
  );
  assert.deepEqual(JSON.parse(readFileSync(join(restored, "secrets.json"), "utf8")), { encrypted: "ciphertext" });

  appendFileSync(join(backup, "storage", "secrets.json"), "tampered");
  const rejected = runScript("restore.mjs", ["--from", backup, "--storage", join(dir, "must-not-exist")]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /size mismatch|checksum mismatch/);
});

test("production backup hard-fails when pg_dump is unavailable and restore rejects incomplete manifest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-backup-pg-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const backup = join(dir, "backup");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "secrets.json"), "{}");
  const created = runScript("backup.mjs", ["--storage", source, "--out", backup], {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://backup.invalid/relay",
    PG_DUMP_BIN: `missing-pg-dump-${process.pid}`,
  });
  assert.notEqual(created.status, 0);
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.database.status, "failed");
  assert.match(manifest.errors.join("\n"), /pg_dump failed/);

  const rejected = runScript("restore.mjs", ["--from", backup, "--storage", join(dir, "restore")]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /manifest is incomplete/);
});

test("restore refuses a required missing dump and manifest path traversal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-restore-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 2,
      kind: "relay-web-api-backup",
      complete: true,
      errors: [],
      files: [],
      database: { required: true, status: "not_configured" },
    }),
  );
  const missingDump = runScript("restore.mjs", ["--from", dir, "--storage", join(dir, "restore")]);
  assert.notEqual(missingDump.status, 0);
  assert.match(missingDump.stderr, /required database dump is unavailable/);

  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 2,
      kind: "relay-web-api-backup",
      complete: true,
      errors: [],
      files: [{ path: "../outside", bytes: 0, sha256: "x" }],
      database: { required: false, status: "not_configured" },
    }),
  );
  const traversal = runScript("restore.mjs", ["--from", dir, "--storage", join(dir, "restore")]);
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /unsafe manifest path/);
});
