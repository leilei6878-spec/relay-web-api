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
  assert.match(dockerfile, /FROM postgres:16-bookworm@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /FROM minio\/mc:latest@sha256:[0-9a-f]{64} AS mc/);
  assert.match(dockerfile, /COPY --from=mc \/usr\/bin\/mc \/usr\/local\/bin\/mc/);
  assert.match(dockerfile, /safe\.directory \/workspace/);
  assert.match(compose, /PG_DUMP_BIN: pg_dump/);
  assert.match(compose, /PG_RESTORE_BIN: pg_restore/);
});

test("release container bases and production service images are digest-pinned", () => {
  for (const path of ["Dockerfile", "Dockerfile.worker", "Dockerfile.backup"]) {
    const fromLines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.startsWith("FROM "));
    assert.ok(fromLines.length > 0);
    assert.ok(fromLines.every((line) => /@sha256:[0-9a-f]{64}(?:\s|$)/.test(line)), `${path} has an unpinned base image`);
  }
  const compose = readFileSync("docker-compose.production.yml", "utf8");
  const images = compose.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("image: "));
  assert.ok(images.length >= 4);
  assert.ok(images.every((line) => /@sha256:[0-9a-f]{64}$/.test(line)), "Compose has an unpinned service image");
});
