# Configuration

Copy [`.env.example`](../.env.example) to `.env`. Never commit `.env`.

Production (`NODE_ENV=production`) **fails closed** unless all of these resolve
(canonical name or alias):

| Canonical | Alias | Purpose |
|---|---|---|
| `DATABASE_URL` | | PostgreSQL. No PGLite fallback. |
| `REDIS_URL` | | Redis. No in-process lock fallback. |
| `RELAY_ADMIN_TOKEN` | `ADMIN_SECRET` | Admin API + cookie. |
| `RELAY_WORKER_TOKEN` | `WORKER_SIGNING_KEY` | Worker poll credential. |
| `RELAY_SECRETS_KEY` | `SESSION_ENCRYPTION_KEY` | AES-256-GCM for proxy/session secrets. |
| `RELAY_S3_BUCKET` + access/secret | `S3_*` / `AWS_*` | Object media. Local disk forbidden. |
| `RELAY_PUBLIC_URL` | `PUBLIC_BASE_URL` | Absolute URLs for stored images. |

Forbidden in production: `RELAY_DEMO_MODE=true`, `RELAY_ALLOW_MOCK=1`, `RELAY_TEST_URL=self`.

Optional: `LOG_LEVEL`, `MAX_WORKERS`, `MAX_WORKER_CONCURRENCY`, `PROVIDER_CANARY_ENABLED`,
`RELAY_REQUIRE_ADMIN_LOGIN=1`, `RELAY_METRICS_TOKEN` (gates `/metrics`). Automatic
admin login is never available when `NODE_ENV=production`; the flag also disables
the convenience in development.

Development may omit the above; `/readyz` reports `degraded`.
