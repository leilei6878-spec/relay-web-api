# Backup / Restore Test

Date: 2026-08-26

## What ran

`scripts/backup-restore.test.mjs`

1. Create PGlite A, apply `0001`–`0004`.
2. Insert `relay_accounts(ac-backup, restore@test)` and `relay_requests(R-b, done)`.
3. Snapshot rows to JSON (stand-in for `pg_dump` when the binary is absent).
4. Create PGlite B, apply the same migrations.
5. Restore snapshot.
6. Assert email, request status, and `relay_meta.schema_version = 4`.

## Result

**PASS** (executed as part of `npm run test:ci` in this workspace).

## What did not run

| Test | Status |
|---|---|
| `pg_dump` / `psql` against Postgres 16 | NOT_EXECUTED (binaries + Docker absent) |
| Restore then boot gateway + `/v1/models` | NOT_EXECUTED in this workspace; required on first production host |
