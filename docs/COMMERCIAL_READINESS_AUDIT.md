# Commercial Readiness Audit

Updated after the Production Resilience Campaign (2026-08-25). Tags: COMPLETE | PARTIAL | NOT_RUN | MISSING.

Status is based on **code + automated tests + two-node chaos (18/18) + 3 min reliability (1504/1504)**, not design inference.

See also: [NIGHTLY_RESILIENCE_REPORT.md](./NIGHTLY_RESILIENCE_REPORT.md), [CHAOS_TEST_REPORT.md](./CHAOS_TEST_REPORT.md), [DISTRIBUTED_CORRECTNESS.md](./DISTRIBUTED_CORRECTNESS.md).

## P0 — Production Fail Closed

| Item | Status | Evidence |
|---|---|---|
| `DATABASE_URL` missing in production → start/getSql fail | **COMPLETE** | `src/lib/db.ts`, `production-guard.test.ts` child process |
| `REDIS_URL` missing in production → no memory fallback | **COMPLETE** | `src/lib/coord.ts` throws; `RELAY_REQUIRE_REDIS=1` also fail-closed |
| Admin secret missing → fail | **COMPLETE** | `authz.ensureAdminToken` |
| Worker secret incomplete → fail | **COMPLETE** | `authz.ensureWorkerToken` |
| Encryption key missing → fail | **COMPLETE** | `RELAY_SECRETS_KEY`; guard test |
| Mock/Test mode in production → fail | **COMPLETE** | `provider_config` forbidden |
| `GET /internal/readiness` | **COMPLETE** | Admin-protected; cluster observed 200 ready=true |

This preview is **not** production: `production: false`. That is allowed.

## P0 — PostgreSQL Cutover

| Item | Status | Evidence |
|---|---|---|
| Production SoT is Postgres | **COMPLETE** | `persistenceMode()==="postgres"` in production; cluster used SQL row claim/finish |
| JSON only for import/fixture/bootstrap | **COMPLETE** | `jsonAllowedFor("scheduling")===false` |
| Two Gateway nodes share one SQL engine | **COMPLETE** | chaos P4 B sees A's job id |
| Claim is `UPDATE … WHERE status='queued'` | **COMPLETE** | `dbClaimJob`; losers cannot regress a winner |
| Finish requires lease + fencing token | **COMPLETE** | `dbFinishJobAtomic`; C2/C8 |

## P0 — Redis Distributed Semantics

| Op | Atomic primitive | Two HTTP Gateways |
|---|---|---|
| job claim | `SET NX` + SQL queued→running | **PASS** winners=1 |
| lease acquire | `SET NX` + SQL `locked_until` | **PASS** unique==leased |
| lease release | `EVAL` compare-and-del | **PASS** C9 lease null |
| lease renew | `EVAL` compare-and-PEXPIRE | **PASS** unit vs RESP |
| fencing | SQL `fencing_token+1` | **PASS** stale lease_id mismatch |
| idempotency | `SET NX pending` + unique index | **PASS** 20 and 50 → 1 job |

## Chaos / reliability (this campaign)

- Chaos harness: **18 PASS / 0 FAIL** at 2026-08-25T17:39:52Z
- Reliability 3 min: **1504/1504**, lost=0, duplicate_execution=0, P99=177ms
- 1h soak: **NOT_RUN** (resume command in RELIABILITY_METRICS.md)

## Final ten questions

| # | Question | Answer |
|---|---|---|
| 1 | Production silently fall back to PGLite? | **No.** |
| 2 | Production silently fall back to Memory Lock? | **No.** |
| 3 | PostgreSQL unique SoT? | **Yes** when production / `RELAY_SOT=postgres`. Preview remains file. |
| 4 | Redis dual-process competition verified? | **Yes** — two Gateway HTTP processes + RESP TCP. |
| 5 | Local media in production? | **No.** Live S3 PUT **NOT_RUN**. |
| 6 | Duplicate execution? | **Not observed** (20/50 idempotency, C3 replay, reliability 0). |
| 7 | Lost request? | **Not observed** in C1/C5/P8 or 1504 reliability requests. |
| 8 | Provider DOM pollute account pool? | **No.** |
| 9 | Max concurrency verified | 50-way idempotency + 20 vs pool. **500 accounts NOT_RUN.** |
| 10 | Max account pool verified | 8 in cluster seed. **500 NOT_RUN.** |

## Honest leftovers

- 1h / 2h soak: **NOT_RUN**
- Live ChatGPT/Gemini browser in the chaos topology: **NOT_RUN**
- Live S3/R2/MinIO PUT: **NOT_RUN**
- Neon / packaged Redis: **NOT_RUN** (PGLite-HTTP + RESP server used)
- RSS / connection leak over hours: **NOT_RUN**
