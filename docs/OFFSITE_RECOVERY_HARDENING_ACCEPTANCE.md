# Offsite recovery hardening acceptance

Date: 2026-08-30 (Asia/Shanghai)

## Release identity

- production runtime remains `0.10.0-rc13`, schema 15, commit
  `fa56455eecc9fc06d45dfab1f91ca48031c4963b`;
- recovery tooling source: `0eed98bf620a41f241ceeac4f9268958a50c749c`;
- commercial, registration, payment, live Canary and privileged-customer MFA
  gates remain disabled.

## Delivered

- deterministic object-media manifest containing sorted relative path, byte
  count and SHA-256 for every object;
- rejection of unsafe/duplicate paths, missing/extra/tampered objects,
  symlinks and non-file entries;
- offsite backup now mirrors the production bucket to a private local stage,
  writes the manifest, uploads to a unique prefix, downloads the remote prefix
  again and verifies every byte before `complete=true`;
- final root `offsite-manifest.sha256` covering the database/storage manifest,
  Git Bundle and object-media manifest; intended for independent evidence;
- standalone downloaded-snapshot verifier covering control-plane hashes,
  restore dry-run, Git Bundle clone/fsck/exact HEAD and object bytes;
- restore dry-run verifies database archives without a destination database,
  while a real restore still requires `DATABASE_URL`;
- restore rejects symlink parents that escape the backup root;
- commercial readiness accepts only a credential-free HTTPS offsite origin,
  safe bucket name and a target distinct from the production endpoint/bucket;
- opt-in Compose `ops` backup runner with PostgreSQL 16 client, Node, Git and
  MinIO `mc`; source and live storage are mounted read-only and no Docker socket
  is exposed.

## Automated verification

- Relay tests: 324 passed;
- commercial tests: 61 passed;
- CI operations/security/recovery tests: 27 passed, two Windows-only symlink
  cases skipped and separately passed in the Linux backup runner;
- template/backup/restore tests: 109 passed, two Windows-only symlink cases
  skipped;
- TypeScript, ESLint, production application build, Compose source contract,
  secret scan and production dependency audit passed; dependency audit found
  zero known vulnerabilities;
- miniature offsite snapshot test creates a real Git repository/bundle,
  control-plane manifest and nested object tree, verifies it through the real
  CLI, then proves post-download tampering fails.

## Production evidence

- `docker compose --profile ops config --quiet` passed;
- `Dockerfile.backup` built successfully on the production Linux host;
- runner tools: Node 18.20.4, PostgreSQL `pg_dump`/`pg_restore` 16.15, MinIO
  client RELEASE.2025-08-13 and Git 2.39.5;
- all seven recovery tests passed inside the Linux runner, including both
  symlink cases and isolated Git restore;
- production S3 bucket was mirrored read-only into an ephemeral runner stage;
  manifest result matched the accepted backup: 96 objects / 45,849,211 bytes;
- running the real offsite command with the intentionally absent destination
  failed before backup creation with `RELAY_BACKUP_S3_ENDPOINT required`;
- Gateway remained healthy at rc13/schema 15 throughout; no account,
  tenant, billing or object mutation was performed.

## Remaining external condition

No separate-account/region destination exists in the supplied environment, so
no genuine offsite copy or disaster restore was fabricated. Before public
charging, configure the four `RELAY_BACKUP_S3_*` secrets for an independently
controlled HTTPS target, execute the real job, preserve the printed root hash
outside that bucket, restore into a separate project/account and record
independently reviewed `offsite_restore` launch evidence.
