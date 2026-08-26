# Failure Taxonomy

Canonical decision table: [FAILURE_MATRIX.md](./FAILURE_MATRIX.md) (`src/lib/fault-matrix.ts`).

| Class | Examples | Account failCount | Retry |
|---|---|---|---|
| account | ACCOUNT_SESSION_EXPIRED, ACCOUNT_BANNED, ACCOUNT_RATE_LIMIT | yes (invalid / banned / cool) | switch account |
| proxy | PROXY_UNAVAILABLE, PROXY_TIMEOUT | no | switch proxy / requeue |
| worker | WORKER_CRASH, WORKER_TIMEOUT, STALE_LEASE | no | same account, other worker |
| provider | PROVIDER_DOM_CHANGED, PROVIDER_UNAVAILABLE, IMAGE_NOT_FOUND, MODEL_MISMATCH | **no** | do **not** walk the pool; DOM/unavailable trip the provider circuit |
| client | REQUEST_CANCELLED, bad JSON | no | no |
| infra | GENERATION_TIMEOUT, INTERNAL_ERROR | no | requeue until maxRetry then dead |

Gemini never returns a placeholder image unless `RELAY_ALLOW_MOCK=1`, and then `mode=mock`. That combination is forbidden in production.
