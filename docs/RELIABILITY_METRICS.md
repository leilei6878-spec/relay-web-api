# Reliability Metrics

## Completed window (this campaign)

Harness: `RELAY_RELIABILITY_MS=180000 node scripts/reliability-run.mjs`

Topology: Gateway A + Gateway B, shared Postgres, Redis. Mix of ChatGPT and Gemini jobs, periodic Gateway A SIGKILL, injected stale finish attempts.

| Metric | Value |
|---|---|
| durationMs | 180081 (~3.0 min) |
| request_total | 1504 |
| success | 1504 |
| success_rate | **1.00** |
| lost_requests | **0** |
| duplicate_execution | **0** |
| stale_rejected | 116 (injected bad lease; all rejected) |
| worker_restart | 37 |
| chatgpt jobs | 1289 |
| gemini jobs | 215 |
| P50 latency ms | 101 |
| P95 | 126 |
| P99 | 177 |
| at | 2026-08-25T17:45:13.000Z |

Raw: `storage/reliability-run.json`

## Longer windows

| Gate | Status | Data |
|---|---|---|
| 3 min | **PASS** | table above |
| 10 min | started (`RELAY_RELIABILITY_MS=600000`); see `storage/reliability-run.json` after it finishes | checkpoint overwrite |
| 1 h | **NOT_EXECUTED** in this sandbox turn (hard time limit). Resume: `RELAY_RELIABILITY_MS=3600000 node scripts/reliability-run.mjs` |
| 2 h | **NOT_EXECUTED** | requires 1h PASS first |

Pass bar used: success_rate ≥ 0.8, lost_requests = 0, duplicate_execution = 0. Observed 1.00 / 0 / 0.

## Resource notes

This run used mock worker completion (claim → finish with text), not a live ChatGPT/Gemini browser, so `browser_crash` and RSS-per-browser were not produced. Node RSS / Redis memory / DB connection leaks over 1h+ remain **NOT_EXECUTED**.
