# Commercial release provenance acceptance

Date: 2026-08-30 (Asia/Shanghai)

## Release

- version: `0.10.0-rc13`
- schema: `15`
- runtime/source/deployment commit:
  `031f1967f3bbc70549702056f60a6b8a62545ba3`
- production remains fail-closed dark launch

## Delivered

- machine-generated release manifest bound to the exact Git commit/tree,
  runtime/API/schema versions, all 15 contiguous migration files and their
  SHA-256 values, critical Docker/Compose/workflow sources and production SBOM;
- generation refuses a dirty tracked tree, shallow history, commit mismatch,
  version drift, migration gaps or an SBOM for another release;
- root `release-manifest.json.sha256` for independent evidence storage;
- commercial GitHub workflow now uses complete Git history, verifies generated
  source cleanliness, validates Compose, builds/inspects the recovery image,
  runs tests/type/lint/build/audit, creates a production-only CycloneDX SBOM and
  uploads commit-named evidence for 90 days;
- `checkout`, `setup-node` and `upload-artifact` fixed to exact 40-character
  action commits rather than mutable tags;
- all Node/Python/PostgreSQL/Redis/MinIO/`mc` image references fixed to OCI
  manifest digests;
- weekly Dependabot configuration for npm, GitHub Actions and Docker updates.

## Verification

- Relay tests: 324 passed;
- commercial tests: 61 passed;
- CI operations/security/release tests: 32 passed, two Windows-only symlink
  cases skipped and separately passed in Linux;
- template/backup/release tests: 114 passed, two Windows-only symlink cases
  skipped;
- three release-manifest integration tests create real Git repositories and
  prove successful binding plus rejection of SHA mismatch, dirty source,
  migration gaps and wrong-version SBOM;
- workflow YAML parsed successfully; source tests prove pinned actions,
  full-history checkout, commit-named evidence and retention;
- TypeScript, ESLint, production build, secret scan and official production
  dependency audit passed; audit found zero known vulnerabilities.

## Production evidence

Evidence directory:
`/opt/backups/relay-release-evidence-031f1967f3bb`

- release-manifest SHA-256:
  `2e21b3fa00b0deec01213654ce8e3fd82e2d600b8cd4647b5d98e933ce8322cf`;
- CycloneDX SBOM SHA-256:
  `012c76d455b55354900f9bdd4dc76a927777474c15023b7b10a9d25e7e9e172e`;
- manifest independently read in the Linux recovery runner and proved commit
  `031f196…`, schema 15 and exactly 15 migrations;
- complete `main` Git Bundle (13,815,167 bytes) cloned, fscked and matched the
  release commit;
- pinned Gateway, Worker and Backup images built on the production host;
- running image IDs:
  - Gateway `sha256:bc78376435a8b7e6bd8e0b3976e4ea6b542d5c771b32c5892312026379f88751`;
  - Worker `sha256:42e82b7017d768abacb1e8436e9eaed074fcab75e1ddb18e06e396041c03aa0d`;
  - Backup `sha256:84fa6741ede38d080bd313e2f9a86fbd0aea2d721c02c63ca1b01cc74faf1c3d`;
- public health, source HEAD and `.deploy-rev` match the exact release commit;
- schema remains 15; five internal accounts remain; tenants, orders, billing
  transactions and tenant audit events remain zero;
- commercial, registration, payment, live Canary and privileged-customer MFA
  gates remain disabled; deployment log fatal scan is clean;
- the accepted pre-deploy recovery backup checksum passed before rollout.

## Remaining authority gap

The authoritative GitHub workflow still cannot execute because GitHub rejects
pushes from `leilei6878` to `leilei6878-spec/relay-web-api` with HTTP 403. The
same gate and release-manifest logic has passed locally and on the production
host, but genuine authoritative-repository CI evidence must not be claimed
until repository write/PR authority is granted and the uploaded artifact is
independently reviewed.

