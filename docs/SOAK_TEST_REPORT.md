# Soak Test Report

## Web Runtime V2 (2026-08-27)

1 hour mixed Chat / Gemini / Leonardo / canary / recycle / fault injection: **NOT_EXECUTED**.

Do not treat unit tests or the 8s smoke as a 1h soak.

Correctness counters (lost_request, duplicate_execution, duplicate_paid_generation, false_positive_image, proxy_drift, cross_request_chunk, stale_result) are **unmeasured** on live traffic.

---

Harness: `node scripts/soak.mjs`

**Release Candidate (2026-08-26): 1h / 12h / 24h / 48h are NOT_EXECUTED.**
The 8s smoke below is the only soak that actually ran. Do not treat RC as 48h-certified.

**Do not read this as a 48h soak.** Longer windows were not run in this session.

| Gate | How | Status | Data |
|---|---|---|---|
| 8s smoke (this pass) | `RELAY_SOAK_MS=8000` against `http://127.0.0.1:8080` | **PASS** | 30/30, successRate 1, p50 19ms, p95 31ms, p99 59ms, 2026-08-25T17:11:30Z |
| 60s smoke | `RELAY_SOAK=smoke` | harness ready, **not re-run this pass** | — |
| 1h | `RELAY_SOAK=1h` | **NOT RUN** | — |
| 12h | `RELAY_SOAK=12h` | **NOT RUN** | — |
| 24h | `RELAY_SOAK=24h` | **NOT RUN** | — |
| 48h | `RELAY_SOAK=48h` | **NOT RUN** | — |

Because 1h was not run, the sequence **must not** advance to 12h/24h/48h.

Pass bar for a round: success rate ≥ 95%, **and** no lost request, **and** no duplicate execution (those last two are asserted in chaos tests, not in `soak.mjs` which currently hits admin session/runtime/metrics/invoke).

Live ChatGPT/Gemini quality, browser crash rate, and RAM growth over hours are out of scope of the 8s smoke.

## Browser pool baseline

Collected from worker beats (`src/lib/browser-baseline.ts`): `browser_start_latency`, `browser_crash_rate`, `RAM_per_request`, `CPU_per_request`.

No data in this pass proved browser startup is the bottleneck. **No resident browser-pool refactor was done.**
