# Nightly Resilience Baseline

Date: 2026-08-25 (pre-campaign audit). Status tags used below are **only**
what the then-current code + tests could support. DESIGN_ONLY / NOT_TESTED
items are the reason this campaign exists.

Legend:

- **VERIFIED** — real code path + automated test observed passing in this workspace
- **PARTIAL** — code exists, but the production invariant is incomplete or only proven in-process
- **DESIGN_ONLY** — documented, not enforced at runtime
- **NOT_TESTED** — code may exist; no honest run
- **BROKEN** — known incorrect under the production invariant

## PostgreSQL SoT

| Surface | Status | Notes |
|---|---|---|
| `persistenceMode()==="postgres"` in `NODE_ENV=production` | VERIFIED | `persist-mode.test.ts` |
| `getSql()` fail-closed without `DATABASE_URL` in production | VERIFIED | `db.ts` + `production-guard.test.ts` child process |
| Job/account/request tables + unique idempotency index | VERIFIED | `migrations/0001_relay.sql`, `0003_relay_production.sql` |
| `dbUpsertJob` / `dbSyncPlane` | PARTIAL | Unconditional `ON CONFLICT DO UPDATE` — a stale snapshot can regress `running` → `queued` |
| Job selection / failCount / usage / API keys via Postgres | PARTIAL | Dual-write. Preview SoT is still `jobs.json` + in-memory `requests.ts` |
| JSON scheduling in production | VERIFIED forbidden | `jsonAllowedFor("scheduling")===false` |
| Two Gateway nodes sharing one Postgres | NOT_TESTED | PGLite is in-process; no shared SQL server existed at audit |
| JSON tamper does not change PG rows | VERIFIED | `scripts/pg-cutover.test.mjs` (single in-process PGLite) |

## Redis lease

| Surface | Status | Notes |
|---|---|---|
| `SET key NX PX` | VERIFIED | `coord.ts`, fake RESP server, 2–3 OS processes |
| `INCR` fencing | VERIFIED | `multi-process-job-claim.test.mjs` winner `WIN 1` |
| compare-and-delete `EVAL` | VERIFIED | against RESP server |
| compare-and-renew `EVAL` | BROKEN | **missing**. Renew was read/compare/write in JS or a blind `SET` |
| Lease value tied to job id on account key | PARTIAL | enqueue sets `"pending"`, claim overwrites with job id |
| Memory fallback in production | VERIFIED forbidden | `getRedis()` throws |
| Packaged `redis-server` / ElastiCache | NOT_TESTED | RESP test server only |

## Request / Job / Attempt

| Surface | Status | Notes |
|---|---|---|
| Schema | VERIFIED | `relay_requests`, `relay_attempts`, `relay_jobs` |
| In-memory request bag as SoT | BROKEN for multi-node | `src/lib/requests.ts` `mem.requests` — Gateway B cannot see Gateway A's Request |
| Failover adds Attempt on one Request | VERIFIED in-process | `requests.test.ts` |
| `claimNext` process-local `locked()` | BROKEN for multi-node | two processes can `save()` a stale jobs array and un-claim a winner |

## Idempotency

| Surface | Status | Notes |
|---|---|---|
| 20-way in one process | VERIFIED | `chaos.test.ts` → 1 job id |
| `SET NX` then later `SET` job id | PARTIAL | loser may `GET` the holder UUID during the pending window |
| Postgres unique index used as SoT | DESIGN_ONLY | index exists; insert path does not `ON CONFLICT (idempotency_key)` |
| 20/50 concurrent across two Gateway processes | NOT_TESTED | |

## Worker / Admin / Customer credentials

| Surface | Status | Notes |
|---|---|---|
| `RELAY_ADMIN_TOKEN` required in production (no file mint) | VERIFIED | `authz.ts` |
| `RELAY_WORKER_TOKEN` required in production | VERIFIED | `authz.ts` |
| Customer API keys | PARTIAL | file `api-keys.json` + dual-write; not the production validator |
| Encryption key for secrets | NOT_TESTED / DESIGN_ONLY | `secrets.json` plaintext; no `RELAY_SECRETS_KEY` |

## Account failover / session version / provider faults

| Surface | Status | Notes |
|---|---|---|
| Failure matrix table | VERIFIED | `fault-matrix.ts` + tests |
| `PROVIDER_DOM_CHANGED` does not bump `failCount` | VERIFIED in-process | `chaos.test.ts` #10 |
| Circuit breaker unique-account trip | PARTIAL | code in `circuit.ts`; not proven across two nodes |
| Session version on finish | PARTIAL | field written; no fencing on version mismatch |
| Live ChatGPT/Gemini DOM | NOT_TESTED | |

## Media Store / Server Worker

| Surface | Status | Notes |
|---|---|---|
| Local disk forbidden in production | VERIFIED | `getMediaStore()` throws |
| Object store SigV4 | PARTIAL | code present; live PUT **NOT_TESTED** |
| Python server worker daemon | PARTIAL | process exists in preview; not a dual-worker fencing proof |

## Readiness / Fail-closed

| Surface | Status | Notes |
|---|---|---|
| Env-only `runProductionReadinessCheck` | VERIFIED | missing DB/Redis/secrets/media → not ready |
| Mock forbidden in production | VERIFIED | |
| `GET /api/ready` | PARTIAL | **unauthenticated**; no live ping of DB/Redis; missing `provider_config` |
| `GET /internal/readiness` | NOT_TESTED | **did not exist** at audit |
| Live migrations check | DESIGN_ONLY | item is "DATABASE_URL set", not `_migrations` rows |
| `bootProductionGuard()` on request path | NOT_TESTED | defined, not called from routes |

## Multi-node / Chaos / Soak (audit)

| # | Item | Status |
|---|---|---|
| Two Gateway processes sharing PG+Redis | NOT_TESTED | |
| Two Worker processes competing for one account | PARTIAL | in-process + Redis SET NX children; not two HTTP gateways |
| Kill worker, request not lost | PARTIAL | heartbeat timeout in one process; no SIGKILL of a child worker |
| Stale result rejected | VERIFIED in-process | duplicate `finishJob` |
| Kill Gateway | NOT_TESTED | file persist simulation only |
| Redis restart during job | NOT_TESTED | `resetCoordForTests` is not a process restart |
| Postgres restart | NOT_TESTED | PGLite in-memory dies with the process |
| Idempotency storm, provider exec = 1 | PARTIAL | in-process only |
| Cancel consistency | VERIFIED in-process | |
| 1h / 2h reliability | NOT_TESTED | 8s soak only |

## Campaign target

Promote every **BROKEN** / **NOT_TESTED** production invariant to a real
process-level test, or record an honest **FAIL** / **NOT_EXECUTED** with data.
