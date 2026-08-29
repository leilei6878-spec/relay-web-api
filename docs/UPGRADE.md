# Upgrade

Schema is the ordered set of `migrations/*.sql`. Current `SCHEMA_VERSION` is **15**
(`src/lib/release.ts`, row `relay_meta.schema_version`).

## Procedure (release N → N+1)

1. Backup (see [BACKUP_RESTORE.md](./BACKUP_RESTORE.md)). Keep the dump until soak on N+1 is clean.
2. Drain workers: `POST /api/worker/control` `{ "action": "drain" }`.
3. Deploy the new artifact (image tag or git SHA).
4. Startup runs `npm run db:migrate` under `pg_advisory_lock(87263401)`. Each file applies once, recorded in `_migrations`.
5. Hit `/readyz`. Required checks must be `ok`.
6. Hit `/v1/models` with a customer key.
7. Run a canary chat + image request.
8. Re-enable workers.

Migrations never require hand-editing SQL. If a migration fails, the transaction rolls back; the process does not go READY.

JSON files are **not** part of production upgrade. To import a preview plane use:

```
node scripts/migrate-json.mjs --dry-run
node scripts/migrate-json.mjs --apply   # requires DATABASE_URL
```
