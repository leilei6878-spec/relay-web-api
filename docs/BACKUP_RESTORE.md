# Backup / Restore

## What to copy

| Asset | How | Notes |
|---|---|---|
| PostgreSQL | `node scripts/backup.mjs --out DIR --require-db` | Creates a custom-format `relay.dump`; any `pg_dump` failure makes the backup incomplete and exits non-zero |
| Encrypted secrets | Included as `storage/secrets.json` with SHA-256 + byte count | Useless without `RELAY_SECRETS_KEY` / `SESSION_ENCRYPTION_KEY` |
| Session files | Included recursively from `storage/sessions/` with SHA-256 + byte count | Cookies; treat as credentials |
| Media bytes | S3/R2/MinIO bucket | Production must not rely on instance disk |
| Config | `.env` (out of git) | |

## Session secret strategy

- Production encrypts `storage/secrets.json` with `RELAY_SECRETS_KEY`.
- Back up the key in the same secret manager as `DATABASE_URL`. Losing the key = losing proxy passwords.
- Session cookies are account credentials. Encrypt the backup at rest. Rotate ChatGPT/Gemini sessions after a suspected leak.

## Commands

```
NODE_ENV=production node scripts/backup.mjs --out /var/backups/relay-$(date +%F) --require-db
node scripts/restore.mjs --from /var/backups/relay-YYYY-MM-DD --dry-run
node scripts/restore.mjs --from /var/backups/relay-YYYY-MM-DD
```

The restore command accepts only a complete version-2 manifest, verifies every
file and database-dump checksum before mutation, requires `DATABASE_URL` for a
database backup, and uses `pg_restore --clean --if-exists`. Environment secret
values and the production object-storage bucket are deliberately not copied to
the filesystem backup; back them up in the secret manager and bucket service.

Proven round-trip (PGlite, schema 4): [BACKUP_RESTORE_TEST.md](./BACKUP_RESTORE_TEST.md).
The CLI failure/verification paths are automated. A real `pg_dump` →
`pg_restore` round-trip against packaged Postgres is
**BLOCKED_BY_ENVIRONMENT** until the deployment host is reachable.
