# Provider Reliability Report

Run: `node --import ./scripts/register-ts-ext.mjs scripts/provider-reliability.mjs` at 2026-08-26.

| Workload | Result |
|---|---|
| Adapter surface + page state + prompt map | **PASS** (unit) |
| Session CAS / refresh race / expiration | **PASS** (unit) |
| Gemini image false-positive / SVG reject | **PASS** (unit + worker python) |
| Selector pack versioning | **PASS** (unit) |
| Model verify GPT-5.6 vs UI label | **PASS** (unit) |
| Fingerprint critical miss | **PASS** (unit) |
| SSE timeout / disconnect / cancel / usage | **PASS** (unit) |
| 20 req / 5 accounts, 20 / 10 accounts | **PASS** (simulated SEM) |
| Worker python compile + no fake Gemini success | **PASS** |
| Circuit unique-account trip + canary close | **PASS** |
| OpenAI-shaped API contract (live server) | **PASS** (`qa-api-compat` 7/7) |
| Live ChatGPT text/vision/multi-turn/stream | **NOT_EXECUTED** (no production session) |
| Live Gemini t2i / reference / edit | **NOT_EXECUTED** |
| Periodic live canary / selector fault injection on real DOM | **NOT_EXECUTED** |
| P50/P95/P99 of live provider latency | **NOT_EXECUTED** |

Do not treat unit PASS as commercial success rate on chatgpt.com.
