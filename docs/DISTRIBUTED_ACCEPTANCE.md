# Distributed Acceptance

## What was executed

Two **Node child processes** competing against a real RESP parser (`scripts/fake-redis.mjs`):

| Test | Result |
|---|---|
| `scripts/multi-process-lease.test.mjs` | PASS — one SET NX winner |
| `scripts/multi-process-job-claim.test.mjs` | PASS — one claim winner |
| `src/lib/coord-redis.test.ts` | PASS — SET NX / INCR / COMPAREDEL |
| `src/lib/chaos.test.ts` 20 req / 5 accounts | PASS — no double lease |

Counters from those runs: `double_lease = 0`, `duplicate_execution = 0`, `lost_request = 0`, `stale_result_accepted = 0`.

## What was not executed

| Topology | Status |
|---|---|
| Gateway A + Gateway B + Worker A + Worker B containers sharing Postgres 16 + Redis 7 | NOT_EXECUTED (no Docker/Redis server in this workspace) |
| Redis process restart while gateways stay up | NOT_EXECUTED (unit reclaim covers lease TTL; not a packaged Redis restart) |
| 20 concurrent HTTP requests through two gateways | NOT_EXECUTED this campaign (prior chaos-harness 18/18 used PGLite-HTTP + RESP in-process) |

Do not read the unit PASS as “two VMs in production were certified”.
