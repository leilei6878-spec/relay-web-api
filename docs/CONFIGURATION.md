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
| `RELAY_TRUST_PROXY_HEADERS=1` + `RELAY_CLIENT_IP_HEADER` | | Select the one edge-overwritten client-IP header. Allowed: `x-real-ip`, `x-forwarded-for`, `cf-connecting-ip`. |
| `RELAY_RELEASE_SHA` | platform commit SHA | Exact deployed Git commit; production readiness rejects `unknown`. |

Forbidden in production: `RELAY_DEMO_MODE=true`, `RELAY_ALLOW_MOCK=1`, `RELAY_TEST_URL=self`.

Optional: `RELAY_BUILD_TIME` (ISO-8601), `LOG_LEVEL`, `MAX_WORKERS`, `MAX_WORKER_CONCURRENCY`, `PROVIDER_CANARY_ENABLED`,
`RELAY_REQUIRE_ADMIN_LOGIN=1`, `RELAY_METRICS_TOKEN` (gates `/metrics`). Automatic
admin login is never available when `NODE_ENV=production`; the flag also disables
the convenience in development.

Queue admission: `RELAY_QUEUE_CAP`, `RELAY_PROVIDER_QUEUE_CAP`,
`RELAY_CHAT_QUEUE_CAP`, `RELAY_IMAGE_QUEUE_CAP`, and `RELAY_KEY_QUEUE_CAP`.
See `BACKPRESSURE.md`.

Development may omit the above; `/readyz` reports `degraded`.
