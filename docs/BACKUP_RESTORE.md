# Backup / Restore

## What to copy

| Asset | How | Notes |
|---|---|---|
| PostgreSQL | `pg_dump "$DATABASE_URL" -f relay.sql` or `node scripts/backup.mjs --out DIR` | SoT for accounts, jobs, requests, attempts, keys, usage, audit |
| Encrypted secrets | `storage/secrets.json` (mode 0600) | Useless without `RELAY_SECRETS_KEY` / `SESSION_ENCRYPTION_KEY` |
| Session files | `storage/sessions/*.json` | Cookies; treat as credentials |
| Media bytes | S3/R2/MinIO bucket | Production must not rely on instance disk |
| Config | `.env` (out of git) | |

## Session secret strategy

- Production encrypts `storage/secrets.json` with `RELAY_SECRETS_KEY`.
- Back up the key in the same secret manager as `DATABASE_URL`. Losing the key = losing proxy passwords.
- Session cookies are account credentials. Encrypt the backup at rest. Rotate ChatGPT/Gemini sessions after a suspected leak.

## Commands

```
node scripts/backup.mjs --out /var/backups/relay-$(date +%F)
node scripts/restore.mjs --from /var/backups/relay-YYYY-MM-DD --dry-run
node scripts/restore.mjs --from /var/backups/relay-YYYY-MM-DD
```

Proven round-trip (PGlite, schema 4): [BACKUP_RESTORE_TEST.md](./BACKUP_RESTORE_TEST.md).
`pg_dump` against packaged Postgres is **NOT_EXECUTED** in the Grok workspace (no `pg_dump` / Docker).
