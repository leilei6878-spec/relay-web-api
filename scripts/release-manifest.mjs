#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function flagValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function regular(path, label = path) {
  if (!existsSync(path)) throw new Error(`${label} missing`);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return path;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(regular(path))).digest("hex");
}

function capture(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`git failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
  return result.stdout.trim();
}

function captureOptional(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

function sourceConstant(source, name, pattern) {
  const match = source.match(pattern);
  if (!match) throw new Error(`${name} missing from release identity`);
  return match[1];
}

function artifact(root, path) {
  const full = regular(join(root, path), path);
  return { path: path.replaceAll("\\", "/"), bytes: lstatSync(full).size, sha256: sha256(full) };
}

const root = resolve(flagValue("--root") || ".");
const sbomPath = resolve(flagValue("--sbom") || join(root, "sbom.cdx.json"));
const outputPath = resolve(flagValue("--out") || join(root, "release-manifest.json"));
const digestPath = resolve(flagValue("--digest-out") || `${outputPath}.sha256`);
const trackedStatus = capture(root, ["status", "--porcelain", "--untracked-files=no"]);
if (trackedStatus) throw new Error("release manifest requires a clean tracked worktree");
if (capture(root, ["rev-parse", "--is-shallow-repository"]) === "true") throw new Error("release manifest requires complete Git history");
capture(root, ["fsck", "--full"]);
const commit = capture(root, ["rev-parse", "HEAD"]);
const expectedCommit = (process.env.RELAY_RELEASE_SHA || process.env.GITHUB_SHA || "").trim().toLowerCase();
if (expectedCommit && expectedCommit !== commit) throw new Error("release commit does not match the authoritative CI/deployment SHA");

const packageJson = JSON.parse(readFileSync(regular(join(root, "package.json"), "package.json"), "utf8"));
const releaseSource = readFileSync(regular(join(root, "src/lib/release.ts"), "release.ts"), "utf8");
const appVersion = sourceConstant(releaseSource, "APP_VERSION", /export const APP_VERSION = "([^"]+)"/);
const apiVersion = sourceConstant(releaseSource, "API_VERSION", /export const API_VERSION = "([^"]+)"/);
const schemaVersion = Number(sourceConstant(releaseSource, "SCHEMA_VERSION", /export const SCHEMA_VERSION = (\d+)/));
if (packageJson.version !== appVersion) throw new Error("package and runtime versions differ");
const openapi = readFileSync(regular(join(root, "openapi.yaml"), "openapi.yaml"), "utf8");
const openapiVersion = openapi.match(/^\s*version:\s*([^\s]+)\s*$/m)?.[1] || "";
if (openapiVersion !== appVersion) throw new Error("OpenAPI and runtime versions differ");

const migrationNames = readdirSync(join(root, "migrations"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, "en"));
if (migrationNames.length !== schemaVersion) throw new Error("schema version does not equal the number of production migrations");
const migrations = migrationNames.map((name, index) => {
  const number = Number(name.match(/^(\d{4})_[A-Za-z0-9_-]+\.sql$/)?.[1] || -1);
  if (number !== index + 1) throw new Error("production migrations must be contiguous and zero-padded");
  return artifact(root, `migrations/${name}`);
});

const sbom = JSON.parse(readFileSync(regular(sbomPath, "CycloneDX SBOM"), "utf8"));
if (sbom.bomFormat !== "CycloneDX" || !String(sbom.specVersion || "").match(/^1\.[4-9]$/)) {
  throw new Error("CycloneDX SBOM is invalid or unsupported");
}
if (sbom.metadata?.component?.version && sbom.metadata.component.version !== appVersion) {
  throw new Error("SBOM component version differs from the release");
}

const criticalPaths = [
  "package.json", "package-lock.json", "openapi.yaml", "src/lib/release.ts",
  "Dockerfile", "Dockerfile.worker", "Dockerfile.backup",
  "docker-compose.production.yml", "docker-compose.server.yml",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml", ".github/workflows/commercial-release.yml",
];
const manifest = {
  version: 1,
  kind: "relay-commercial-release-manifest",
  generatedAt: new Date().toISOString(),
  release: { version: appVersion, api: apiVersion, schema: schemaVersion, commit },
  git: {
    branch: process.env.GITHUB_REF_NAME || captureOptional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "detached",
    tree: capture(root, ["rev-parse", "HEAD^{tree}"]),
    fullHistory: true,
  },
  ci: {
    repository: process.env.GITHUB_REPOSITORY || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    ref: process.env.GITHUB_REF || null,
    requiredGates: [
      "test:ci", "test:commercial", "template-tests", "typecheck", "lint",
      "build:app", "production-dependency-audit", "cyclonedx-sbom", "compose-contract",
    ],
  },
  sourceArtifacts: criticalPaths.map((path) => artifact(root, path)),
  migrations,
  sbom: {
    path: basename(sbomPath),
    bytes: lstatSync(sbomPath).size,
    sha256: sha256(sbomPath),
    format: sbom.bomFormat,
    specVersion: sbom.specVersion,
  },
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
chmodSync(outputPath, 0o600);
const digest = sha256(outputPath);
writeFileSync(digestPath, `${digest}  ${basename(outputPath)}\n`, { mode: 0o600 });
chmodSync(digestPath, 0o600);
console.log(JSON.stringify({ ok: true, output: outputPath, digestPath, commit, version: appVersion, schema: schemaVersion, sha256: digest }));
