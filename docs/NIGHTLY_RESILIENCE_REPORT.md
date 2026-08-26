# Nightly Resilience Report

Date: 2026-08-25. Campaign: Production Resilience.

Do not read this as “implemented”. Each line is **PASS / FAIL / PARTIAL / NOT_EXECUTED** with the run that produced it.

## Definition of Done

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Production missing DB/Redis/Media/Secret fail-closed | **PASS** | `production-guard.test.ts` (incl. encryption key); child process without `DATABASE_URL` |
| 2 | PostgreSQL unique production SoT | **PASS** (policy + cluster path) | `persist-mode` production always postgres; cluster used `RELAY_SOT=postgres` + SQL HTTP; JSON not used for scheduling |
| 3 | Two Gateways safe in parallel | **PASS** | A+B HTTP processes, shared SQL+Redis, `P4.gateway-b-sees-request` |
| 4 | Two Workers safe in parallel | **PASS** | `P4.two-workers-one-claim` winners=1 |
| 5 | Same account no double lease | **PASS** | C7 unique==ok; P4 unique==leased |
| 6 | Stale result rejected | **PASS** | C2 lease_id mismatch; C8 already terminal |
| 7 | Idempotency storm executes once | **PASS** | 20 → 1 job execs=1; 50 → 1 job |
| 8 | Kill worker does not lose Request | **PASS** | C1 queued + requestId `R-crash` |
| 9 | Kill Gateway no duplicate execution | **PASS** | C3 replay true, same id |
| 10 | PROVIDER_DOM_CHANGED does not pollute pool | **PASS** | C6P secondOk true + in-process chaos #10 |
| 11 | Redis/Postgres temporary failure recovers | **PASS** | C4 enqueue true winners 1; C5 jobCount 24 |
| 12 | Restart recovery automated | **PASS** | P8 phantomRunning 0 |
| 13 | Long run no request lost | **PASS** (3 min) / **NOT_EXECUTED** (1h) | 1504/1504, lost=0. 1h not completed in this turn |
| 14 | duplicate_execution = 0 | **PASS** | reliability 0; chaos 20/50-way 1 id |
| 15 | Automated scripts + reports | **PASS** | `scripts/chaos-harness.mjs`, `scripts/reliability-run.mjs`, JSON + these docs |

## Phase results

| Phase | Result | Notes |
|---|---|---|
| 0 Baseline | **PASS** | `docs/NIGHTLY_RESILIENCE_BASELINE.md` written from code+tests, not inference |
| 1 Fail-closed | **PASS** | encryption key, provider_config, `/internal/readiness` admin-protected, boot on chat |
| 2 Postgres cutover | **PASS** | row-level claim/finish; unique idempotency; JSON scheduling off in postgres mode |
| 3 Redis atomic | **PASS** | SET NX, INCR, EVAL compare-del, EVAL compare-renew; no JS GET/compare/write window |
| 4 Two nodes | **PASS** | two Gateway processes, two worker names, shared PG+Redis |
| 5 Chaos matrix | **PASS** | 18/18 |
| 6 Provider isolation | **PASS** | DOM_CHANGED does not drain pool |
| 7 Account failure matrix | **PASS** (unit) / **PARTIAL** (cluster) | `fault-matrix.test.ts` covers every code; cluster injected DOM/cancel/crash |
| 8 Restart recovery | **PASS** | C3/C4/C5/P8 |
| 9 Reliability | **PASS** 3 min; **NOT_EXECUTED** 1h | 1504 success, 0 lost, 0 dup |
| 10 Perf / leaks | **PARTIAL** | P50/P95/P99 recorded; RSS/DB/Redis growth over hours NOT_EXECUTED |

## Honest leftovers

- 1h / 2h soak: **NOT_EXECUTED**. Resume: `RELAY_RELIABILITY_MS=3600000 node scripts/reliability-run.mjs`
- Neon + ElastiCache + live S3: **NOT_EXECUTED**
- Live ChatGPT/Gemini browser workers in the chaos topology: **NOT_EXECUTED** (claim/finish used the real job/lease path with synthetic text)
- RSS / connection leak over hours: **NOT_EXECUTED**
