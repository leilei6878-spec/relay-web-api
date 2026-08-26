# Capacity Baseline

Do not claim 500 accounts. Verified vs theoretical are separate.

| Tier | Accounts | Status | Notes |
|---|---|---|---|
| 5 | 5 | VERIFIED (unit/chaos) | 20 requests vs 5 accounts, concurrency=1, no double lease |
| 20 | 20 | PARTIAL | concurrency unit test 20 req / 10 accounts; not a live browser run |
| 50 | 50 | NOT_TESTED | idempotency 50-way in prior campaign; not 50 real accounts |
| 500 | 500 | NOT_TESTED | architecture only |

**Verified max concurrency (this workspace):** in-process claim competition, 20 queued jobs, 5 accounts, 2–3 workers simulated. No live Chromium pool size certified.

**Theoretical:** `MAX_WORKERS` × `MAX_WORKER_CONCURRENCY`, with account concurrency 1 as the real cap.

Prior reliability run (3 min, 1504/1504) is documented in `RELIABILITY_METRICS.md`. 1h soak: [SOAK_TEST_REPORT.md](./SOAK_TEST_REPORT.md) **NOT_EXECUTED**.
