# Nightly Provider Report

Date: 2026-08-26. Campaign: Provider Reliability & Performance.

## Definition of Done

| # | Requirement | Status |
|---|---|---|
| 1 | ChatGPT/Gemini independent Adapter | **VERIFIED** (TS interface + tests). Live `execute*` is Python worker. |
| 2 | Page state detection, selector miss ≠ session | **VERIFIED** (unit + worker mapping). Live pages **NOT_EXECUTED**. |
| 3 | Canary works | **PARTIAL** control-plane + `kind=canary`. Live probe **NOT_EXECUTED**. |
| 4 | Provider circuit works | **VERIFIED** (existing + tests). |
| 5 | DOM_CHANGED does not pollute account pool | **VERIFIED** (fault matrix). |
| 6 | Session version CAS | **VERIFIED** (unit). Live write-back **NOT_EXECUTED**. |
| 7 | ChatGPT multi-turn actually applied | **VERIFIED** conversion layer + tests. Live ChatGPT thread **NOT_EXECUTED**. |
| 8 | `/v1/responses` reliable subset | **VERIFIED** (string/messages/vision/stream; unsupported 400). |
| 9 | Streaming disconnect/cancel/usage | **VERIFIED** (unit + completions path). Worker may still run until timeout after cancel. |
| 10 | Gemini no fake success | **VERIFIED** (mock gated; SVG rejected). |
| 11 | Gemini not confusing old/UI images | **VERIFIED** (unit + worker `accept_result_image`). Live **NOT_EXECUTED**. |
| 12 | Images Edit distinct | **VERIFIED** (requires image; mask 400). |
| 13 | Production MediaStore not ephemeral | **PARTIAL** ObjectMediaStore + fail-closed. Live S3 **NOT_EXECUTED**. |
| 14 | concurrencyPerWorker real | **PARTIAL** Python SEM + simulated 20×N tests. Live load **NOT_EXECUTED**. |
| 15 | Same-account concurrency always 1 | **VERIFIED** (lock + simulation). |
| 16 | requested_model / actual_model verifiable | **VERIFIED** (adapter.verifyModel; UI labels). Live switch **NOT_EXECUTED**. |
| 17 | OpenAI SDK contract tests | **VERIFIED** (compat suite 7/7 on this server). Full SDK package **NOT_EXECUTED**. |
| 18 | Real provider reliability run report | **PARTIAL** this file + unit workload. Live providers **NOT_EXECUTED**. |

## Honest leftovers

- No production ChatGPT or Gemini session in this sandbox, so success rate on real DOM is unknown.
- Browser pool is opt-in; blank-page baseline does not justify it as the live bottleneck.
- Streaming cancel does not preempt an in-flight Playwright job (timeout still bounds it).
