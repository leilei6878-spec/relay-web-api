import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(workspace, "scripts", "release-manifest.mjs");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "relay-release-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["src/lib", "migrations", ".github/workflows"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "relay-test", version: "1.2.3" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: "relay-test", version: "1.2.3", lockfileVersion: 3 }));
  writeFileSync(join(root, "openapi.yaml"), "openapi: 3.1.0\ninfo:\n  version: 1.2.3\n");
  writeFileSync(join(root, "src/lib/release.ts"), 'export const APP_VERSION = "1.2.3";\nexport const API_VERSION = "v1";\nexport const SCHEMA_VERSION = 2;\n');
  writeFileSync(join(root, "migrations/0001_base.sql"), "create table base(id text);\n");
  writeFileSync(join(root, "migrations/0002_next.sql"), "alter table base add column value text;\n");
  for (const name of ["Dockerfile", "Dockerfile.worker", "Dockerfile.backup", "docker-compose.production.yml", "docker-compose.server.yml"]) {
    writeFileSync(join(root, name), `${name}\n`);
  }
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: ci\n");
  writeFileSync(join(root, ".github/workflows/commercial-release.yml"), "name: commercial\n");
  writeFileSync(join(root, ".github/dependabot.yml"), "version: 2\nupdates: []\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "release-test@example.test"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const sbom = join(root, "sbom.cdx.json");
  writeFileSync(sbom, JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", metadata: { component: { name: "relay-test", version: "1.2.3" } } }));
  return { root, commit, sbom, output: join(root, "release-manifest.json"), digest: join(root, "release-manifest.sha256") };
}

function generate(state, env = {}, extra = []) {
  return spawnSync(process.execPath, [script, "--root", state.root, "--sbom", state.sbom, "--out", state.output, "--digest-out", state.digest, ...extra], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, RELAY_RELEASE_SHA: state.commit, GITHUB_REF_NAME: "main", ...env },
  });
}

test("release manifest binds exact Git tree, contiguous migrations, critical artifacts and SBOM", (t) => {
  const state = fixture(t);
  const generated = generate(state);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const result = JSON.parse(generated.stdout);
  const manifest = JSON.parse(readFileSync(state.output, "utf8"));
  assert.equal(result.ok, true);
  assert.equal(manifest.release.commit, state.commit);
  assert.deepEqual(manifest.release, { version: "1.2.3", api: "v1", schema: 2, commit: state.commit });
  assert.deepEqual(manifest.migrations.map((item) => item.path), ["migrations/0001_base.sql", "migrations/0002_next.sql"]);
  assert.ok(manifest.sourceArtifacts.some((item) => item.path === "Dockerfile.backup"));
  assert.ok(manifest.sourceArtifacts.some((item) => item.path === ".github/workflows/commercial-release.yml"));
  assert.ok(manifest.sourceArtifacts.some((item) => item.path === ".github/dependabot.yml"));
  assert.equal(manifest.sbom.sha256, createHash("sha256").update(readFileSync(state.sbom)).digest("hex"));
  assert.equal(readFileSync(state.digest, "utf8"), `${result.sha256}  release-manifest.json\n`);
});

test("release manifest rejects commit mismatch and tracked source changes", (t) => {
  const state = fixture(t);
  const mismatch = generate(state, { RELAY_RELEASE_SHA: "f".repeat(40) });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match/);
  writeFileSync(join(state.root, "migrations/0002_next.sql"), "tampered\n");
  const dirty = generate(state);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean tracked worktree/);
});

test("release manifest rejects schema gaps and an SBOM for another release", (t) => {
  const state = fixture(t);
  writeFileSync(join(state.root, "migrations/0004_gap.sql"), "select 1;\n");
  git(state.root, ["add", "migrations/0004_gap.sql"]);
  git(state.root, ["commit", "-m", "gap"]);
  state.commit = git(state.root, ["rev-parse", "HEAD"]);
  const gap = generate(state);
  assert.notEqual(gap.status, 0);
  assert.match(gap.stderr, /schema version|contiguous/);

  rmSync(join(state.root, "migrations/0004_gap.sql"));
  git(state.root, ["add", "-u", "migrations"]);
  git(state.root, ["commit", "-m", "remove gap"]);
  state.commit = git(state.root, ["rev-parse", "HEAD"]);
  writeFileSync(state.sbom, JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", metadata: { component: { version: "9.9.9" } } }));
  const wrongSbom = generate(state);
  assert.notEqual(wrongSbom.status, 0);
  assert.match(wrongSbom.stderr, /SBOM component version differs/);
});

test("commercial workflows pin third-party actions and publish commit-bound release evidence", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/commercial-release.yml"]) {
    const source = readFileSync(join(workspace, path), "utf8");
    assert.doesNotMatch(source, /uses:\s+actions\/[A-Za-z0-9_-]+@v\d/);
    for (const match of source.matchAll(/uses:\s+actions\/[A-Za-z0-9_-]+@([^\s]+)/g)) {
      assert.match(match[1], /^[0-9a-f]{40}$/);
    }
    assert.match(source, /fetch-depth:\s*0/);
  }
  const release = readFileSync(join(workspace, ".github/workflows/commercial-release.yml"), "utf8");
  assert.match(release, /release-manifest\.mjs/);
  assert.match(release, /release-manifest\.json\.sha256/);
  assert.match(release, /commercial-release-\$\{\{ github\.sha \}\}/);
  assert.match(release, /retention-days:\s*90/);
});
