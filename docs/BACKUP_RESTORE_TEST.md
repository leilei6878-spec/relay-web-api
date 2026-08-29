# Backup / Restore Test

Date: 2026-08-30

Automated coverage runs through `npm run test:ci` and `npm test`.

## Control plane

- applies migrations `0001`–`0015` to two isolated PGlite databases and proves
  schema 15 plus representative account/request round-trip;
- backs up encrypted secrets and session files, verifies byte counts/SHA-256,
  restores them and rejects tampering;
- proves production `pg_dump` failure creates `complete=false` and exits
  non-zero;
- rejects incomplete/missing dumps, traversal and non-regular paths;
- verifies a database archive in dry-run without needing a destination, while
  real restore still fails closed without `DATABASE_URL`.

## Object media and offsite recovery

- deterministic sorted nested-file inventory with SHA-256 and total bytes;
- rejects tampered, missing, extra, duplicate, unsafe and (on Linux) symlinked
  object content;
- builds a complete miniature offsite snapshot with control-plane manifest,
  Git Bundle and object-media manifest;
- verifies the downloaded snapshot through the real
  `verify-offsite-snapshot.mjs`, including isolated Git clone/fsck/exact HEAD
  and restore dry-run;
- proves post-download object tampering fails verification;
- source-contract test requires the live offsite job to stage, upload,
  re-download and verify objects before setting `complete=true`.

## Production proof

The accepted rc13 drill restored a PostgreSQL 16 custom dump, complete Git
Bundle, 272 filesystem files and an S3 API export of 96 objects / 45,849,211
bytes. Live raw MinIO-volume counts diverged during the first attempt, so that
archive was rejected and removed before acceptance.
