# Rollback

There is no automatic down-migration. Rollback is **restore the previous release artifact + restore the backup taken before upgrade**.

## Procedure

1. Stop gateway and workers (compose: `docker compose -f docker-compose.production.yml stop gateway worker`).
2. Restore PostgreSQL from the pre-upgrade dump (`psql "$DATABASE_URL" -f relay.sql` or volume snapshot).
3. Restore `storage/` backup if secret metadata lived on disk (encrypted `secrets.json`).
4. Start the **previous** image / git SHA.
5. Confirm `/readyz` ready, then `/healthz`, then one canary request.
6. If media objects were written to S3 during the failed release they remain; they are immutable. Do not delete blindly.

## What you cannot roll back with a button

- Object-store writes
- Already-rotated API keys
- Provider-side session invalidation

If `_migrations` contains a version the old binary does not understand, you **must** restore the database, not just the binary.
