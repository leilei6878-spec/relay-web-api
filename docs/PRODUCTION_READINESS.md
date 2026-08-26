# Production Readiness

Production is **fail-closed**. Development and tests may use PGLite, in-memory coord, local media, and minted tokens.

## Startup contract (`NODE_ENV=production`)

| Required | Missing behavior |
|---|---|
| `DATABASE_URL` | process must not become READY. `getSql()` throws `PRODUCTION_FAIL_CLOSED`. PGLite is not loaded. |
| `REDIS_URL` | `getRedis()` throws. Memory lock is not used. |
| `RELAY_ADMIN_TOKEN` | `ensureAdminToken()` throws. File mint is forbidden. |
| `RELAY_WORKER_TOKEN` | `ensureWorkerToken()` throws. Worker secret infrastructure incomplete. |
| `RELAY_SECRETS_KEY` | readiness `encryption_key` / `secret_store` missing. Plaintext `secrets.json` forbidden. |
| Object storage (`RELAY_S3_BUCKET` + access/secret) | readiness `media_store` missing. Local disk is not production-stable. |
| Mock/Test/Demo (`RELAY_ALLOW_MOCK`, `RELAY_DEMO_MODE`, `RELAY_TEST_URL=self`) | `provider_config` forbidden. Startup must not enter READY. |

`bootProductionGuard()` runs on `/v1/chat/completions` and `/internal/readiness`.

## ProductionReadinessCheck items

- `database`
- `redis`
- `secret_store`
- `encryption_key`
- `media_store`
- `worker`
- `migrations`
- `admin_auth`
- `provider_config`

Any REQUIRED item not `ok` ⇒ `ready: false`.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /api/ready` | public (preview) | env-only check; 503 in production if not ready |
| `GET /internal/readiness` | **Admin** | live ping of Postgres + Redis + the items above |

## Verified this campaign

- Child process `NODE_ENV=production` without `DATABASE_URL` throws `PRODUCTION_FAIL_CLOSED` (`production-guard.test.ts`).
- Production without `RELAY_SECRETS_KEY` is not ready.
- Two Gateway processes against shared SQL + Redis: `GET /internal/readiness` → `ready: true`, `coord: redis`, `persist: postgres` (2026-08-25T17:39:52Z).
- This preview host is **not** production: `production: false`, backend `pglite` / `file` / `memory` / `local`. That is allowed.

## Not claimed

- A live `NODE_ENV=production` process with Neon + ElastiCache + S3 was not started in this sandbox.
- Object-store PUT against a real bucket: **NOT_EXECUTED**.
