# Upgrade

Schema is the ordered set of `migrations/*.sql`. Current `SCHEMA_VERSION` is **22**
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

Schema 17 adds `relay_email_deliveries`. Before enabling commercial mode,
configure and test both `RELAY_EMAIL_WEBHOOK_URL` and a dedicated 32+ character
`RELAY_EMAIL_WEBHOOK_SECRET`; keep the dedicated scheduler online. Existing
schema-16 deployments may migrate with the channel unset while commercial and
registration gates remain closed.

Schema 18 adds append-only `relay_legal_acceptances`. Registration and invite
acceptance bind the explicit user action to the active terms/privacy versions,
exact public content bundle SHA-256 and HMAC-only network evidence. Existing
users are not backfilled with fabricated consent; obtain a fresh acceptance
before relying on the record for commercial service.

Schema 19 permits the append-only `reconsent` method. Existing sessions are
redirected to the explicit consent page when the effective Terms/Privacy bundle
changes, and paid tenant API keys fail closed until an active Owner/Admin has
accepted that exact bundle.

JSON files are **not** part of production upgrade. To import a preview plane use:

```
node scripts/migrate-json.mjs --dry-run
node scripts/migrate-json.mjs --apply   # requires DATABASE_URL
```
