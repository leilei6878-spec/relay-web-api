# Backup / Restore Test

Date: 2026-08-28

## What ran

`scripts/backup-restore.test.mjs`

1. Create PGlite A, apply `0001`–`0004`.
2. Insert `relay_accounts(ac-backup, restore@test)` and `relay_requests(R-b, done)`.
3. Snapshot rows to JSON (stand-in for `pg_dump` when the binary is absent).
4. Create PGlite B, apply the same migrations.
5. Restore snapshot.
6. Assert email, request status, and `relay_meta.schema_version = 4`.
7. Run the real backup CLI against isolated filesystem state and verify that
   encrypted secrets plus session cookies are present in the manifest.
8. Dry-run and execute the real restore CLI; compare restored contents.
9. Tamper with a backup and verify restore rejects its size/checksum.
10. Simulate missing `pg_dump` in production and verify backup exits non-zero
    with `complete=false`; verify restore rejects it.
11. Verify required missing dumps and manifest path traversal are rejected.

## Result

**PASS — 4/4 tests** (executed as part of `npm run test:ci`).

## What did not run

| Test | Status |
|---|---|
| `pg_dump` / `pg_restore` against Postgres 16 | BLOCKED_BY_ENVIRONMENT (deployment host unreachable here) |
| Restore then boot gateway + `/v1/models` | NOT_EXECUTED in this workspace; required on first production host |
