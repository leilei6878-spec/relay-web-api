import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

test("exported worker python compiles", () => {
  const path = existsSync("/workspace/storage/worker.py") ? "/workspace/storage/worker.py" : "workers/relay-worker.py";
  assert.equal(existsSync(path), true, `worker script missing: ${path}`);
  const r = spawnSync(PYTHON, ["-m", "py_compile", path], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("production Compose requires secrets and publishes the documented host port", () => {
  const compose = readFileSync("docker-compose.production.yml", "utf8");
  for (const name of [
    "POSTGRES_PASSWORD",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET",
    "RELAY_ADMIN_TOKEN",
    "RELAY_WORKER_TOKEN",
    "RELAY_SECRETS_KEY",
    "RELAY_PUBLIC_URL",
    "RELAY_RELEASE_SHA",
  ]) {
    assert.ok(compose.includes(`\${${name}:?`), `${name} must use required Compose interpolation`);
  }
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:-relay|S3_SECRET_KEY:-relayrelay1/);
  assert.match(compose, /RELAY_BIND:-127\.0\.0\.1:8088/);
});

test("offsite backup runner is opt-in, version-matched and cannot write source or live storage", () => {
  const compose = readFileSync("docker-compose.production.yml", "utf8");
  const dockerfile = readFileSync("Dockerfile.backup", "utf8");
  assert.match(compose, /backup:\s*[\s\S]*profiles: \["ops"\]/);
  assert.match(compose, /\.:\/workspace:ro/);
  assert.match(compose, /\$\{RELAY_STORAGE_HOST:-relay_storage\}:\/relay-storage:ro/);
  assert.match(compose, /\$\{RELAY_BACKUP_HOST:-\/opt\/backups\}:\/opt\/backups/);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock/);
  assert.match(dockerfile, /FROM postgres:16-bookworm/);
  assert.match(dockerfile, /FROM minio\/mc:latest AS mc/);
  assert.match(dockerfile, /COPY --from=mc \/usr\/bin\/mc \/usr\/local\/bin\/mc/);
  assert.match(dockerfile, /safe\.directory \/workspace/);
});
