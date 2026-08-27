# Web Runtime V2 Baseline

Audit of `main` at `519c386` (2026-08-27), after Commits 1–4, then updated as Commits 4.5–12 landed.

Legend: **VERIFIED** (code + unit tests) · **PARTIAL** (some path only) · **LOGIC_ONLY** · **NOT_LIVE_TESTED** · **BLOCKER** (still violates a V2 invariant) · **NOT_EXECUTED** (live gate never run).

Live Chat/Image E2E, soak, and chaos in this environment: **NOT_EXECUTED**.

---

## P0 — Correctness invariants

| ID | Item | Status | Evidence |
|---|---|---|---|
| P0-1 | Account↔Proxy fail-closed | **VERIFIED** / **NOT_LIVE_TESTED** | `job_proxy()` never appends `pick_proxy()` in production. Assigned-down → `None` + `PROXY_UNAVAILABLE`. `PROXY_IDENTITY_MISMATCH` if server/id drift. Claim uses `job.proxyId`. Unit: `production job_proxy never falls back`. Live `proxy_drift`: **NOT_LIVE_TESTED**. |
| P0-2 | True Playwright concurrency | **VERIFIED** / **NOT_LIVE_TESTED** | `PlaywrightShard` × `RELAY_PLAYWRIGHT_SHARDS` (default 3). Stable `shard_for_account`. Poll dispatches without waiting. Unit: distinct accounts overlap ≥ 2, same account max = 1. Live 5×20: **NOT_EXECUTED** / **BLOCKED_BY_ACCOUNT_COUNT**. |
| P0-3 | No process-global job env | **VERIFIED** / **NOT_LIVE_TESTED** | `JobRuntimeContext` passed into `post_chunk`/`post_phase`/`post_result`. No `os.environ["RELAY_JOB_ID"]`. Concurrent chunk payloads stay on their job ids. Live `cross_request_chunk`: **NOT_LIVE_TESTED**. |
| P0-4 | Submission state machine | **VERIFIED** / **NOT_LIVE_TESTED** | `PREPARING` → `COMPOSER_READY` → `INPUT_READY` → `SUBMITTING` → `SUBMITTED` → `GENERATING` → `RESULT_VALIDATED`. `SUBMISSION_UNCERTAIN` / `RESULT_UNCERTAIN` exist. Live recovery: **NOT_LIVE_TESTED**. |
| P0-5 | Pre vs post-submit retry | **VERIFIED** / **NOT_LIVE_TESTED** | `retrySafety` SAFE/UNKNOWN/UNSAFE. `decideWithSafety` beats fault code. Post-submit never `switch_account`. Pre-submit `LEONARDO_GENERATION_FAILED` may still failover. Live `duplicate_paid_generation`: **NOT_LIVE_TESTED**. |
| P0-6 | Post-submit recovery | **PARTIAL** / **NOT_LIVE_TESTED** | Uncertain path waits on the same page instead of a second Generate. No pending-card / grace-window recovery yet. |
| P0-7 | GenerationBoundary | **VERIFIED** / **NOT_LIVE_TESTED** | `create_generation_boundary` before Generate. Gemini/Leonardo locators prefer new containers. Scorer REJECT on history/ref/UI. Production only VERIFIED/HIGH. Page-wide `img` is last-resort fallback still scored. Unit 100/100 synthetic permutations. Live: **NOT_LIVE_TESTED**. |
| P0-8 | Image result confidence | **VERIFIED** / **NOT_LIVE_TESTED** | `scoreCandidate` → VERIFIED/HIGH/MEDIUM/LOW/REJECT. Production `pickAcceptedCandidates` filters to VERIFIED/HIGH. MEDIUM/LOW → `IMAGE_CONFIDENCE_TOO_LOW` not HTTP 200. Live: **NOT_LIVE_TESTED**. |
| P0-9 | Reference exact count | **VERIFIED** / **NOT_LIVE_TESTED** | `attached == requested` before Generate. Incomplete → `REFERENCE_ATTACH_INCOMPLETE`. Unit 1/2/4/6 refs. Live: **NOT_LIVE_TESTED**. |
| P0-10 | Result ≠ reference | **VERIFIED** / **NOT_LIVE_TESTED** | Result sha256 vs `reference_hashes` (not byte length). Match → `RESULT_IS_REFERENCE_IMAGE`. Live: **NOT_LIVE_TESTED**. |
| P0-11 | Unified ImageResultValidator | **VERIFIED** / **NOT_LIVE_TESTED** | `image-size` npm for PNG/JPEG/WebP. Magic, MIME, bytes, dims, aspect, tier, sha256, ref exclusion, confidence. `finishJob` calls `validateJobImageUrls`. Live: **NOT_LIVE_TESTED**. |
| P0-12 | Size/aspect closed loop | **VERIFIED** / **NOT_LIVE_TESTED** | Job + API relay metadata: `requested_size`, `actual_width/height`, `actual_aspect`, `requested_tier`, `actual_tier`. Mismatch → `OUTPUT_SIZE_MISMATCH`. Native family tolerance via Capability Registry. Live: **NOT_LIVE_TESTED**. |
| P0-13 | `n` must match results | **VERIFIED** / **NOT_LIVE_TESTED** | Validator requires `length == n`. Gemini/Leonardo `maxOutputs=1`; client `n>1` is HTTP 400 `RESULT_COUNT_MISMATCH`, not silent truncate. Live n=1: **NOT_LIVE_TESTED**. |
| P0-14 | No giant base64 in job JSON | **PARTIAL** / **NOT_LIVE_TESTED** | Worker `POST /api/worker/media` under lease fence; job JSON holds `/api/media` URLs. Leftover `data:` URLs still persist as a fallback in `finishJob`. Live 15MB: **NOT_LIVE_TESTED**. |
| P0-15 | Gemini warm runtime | **VERIFIED** / **NOT_LIVE_TESTED** | `ensure_gemini_ready` skips `goto` when WARM_IDLE. Cleanup prompt/refs between requests. Live Request-B isolation: **NOT_LIVE_TESTED**. |
| P0-16 | Leonardo warm runtime | **VERIFIED** / **NOT_LIVE_TESTED** | `ensure_leonardo_ready` skips nav when already on AI Creation + idle. Cleanup prompt/refs; next request `reference_count=0` required for WARM_IDLE. Live: **NOT_LIVE_TESTED**. |
| P0-17 | ChatGPT model truth | **VERIFIED** / **NOT_LIVE_TESTED** | `verifyModel` requires version token (`5.6`). ChatGPT / Instant / Auto → `MODEL_SELECTION_UNCONFIRMED`. Aliases `chatgpt-web-auto` / `chatgpt-web-fast`. Adapter tests require unconfirmed, not the old lie. Live false-confirmation: **NOT_LIVE_TESTED**. |
| P0-18 | SEND_NOT_ACKED uncertain | **VERIFIED** / **NOT_LIVE_TESTED** | Click without ACK → `SUBMISSION_UNCERTAIN` (no second send). Mapped before DOM_CHANGED. Composer-empty / turn-increment counted as evidence. Live: **NOT_LIVE_TESTED**. |

---

## P1 — Operations

| ID | Item | Status | Evidence |
|---|---|---|---|
| P1-1 | Automatic canary | **VERIFIED** / **NOT_LIVE_TESTED** | `startProviderCanaryScheduler` from production boot (skipped when `RELAY_TEST=1`). Structural 5–10 min + jitter. `REAL_IMAGE_CANARY_INTERVAL` (default 3h) for paid image. Live loop: **NOT_LIVE_TESTED**. |
| P1-2 | Canary before customer traffic | **LOGIC_ONLY** / **NOT_LIVE_TESTED** | `canDispatch` refuses OPEN. Depends on live canary actually running. |
| P1-3 | Selector pack hot-swap | **VERIFIED** / **NOT_LIVE_TESTED** | `active_selector_pack` vs `candidate_selector_pack`. N≥3 consecutive canary PASS promotes. Fail rolls candidate back. Live promote: **NOT_LIVE_TESTED**. |
| P1-4 | Account health score | **PARTIAL** | LRU + hard filters. No latency/success score. |
| P1-5 | Capability-level health | **PARTIAL** | Leonardo `availableModels` at pick. |
| P1-6 | Adaptive timeout | **NOT_LIVE_TESTED** | Fixed 90s / 180s. |
| P1-7 | Queue backpressure | **VERIFIED** / **NOT_LIVE_TESTED** | `RELAY_QUEUE_CAP` default 200 → HTTP 429 `QUEUE_FULL`. Canary bypasses the cap. Unit: cap=1 returns 429. Live: **NOT_LIVE_TESTED**. |
| P1-8 | Browser/context lifecycle | **PARTIAL** | Idle/count recycle. No crash_count / memory recycle. |
| P1-9 | Worker drain | **PARTIAL** | Gateway skips claim if draining. SIGKILL still possible. |
| P1-10 | Image cost / tokens | **PARTIAL** | `tokenState` on Leonardo result. |
| P1-11 | Image provenance | **PARTIAL** | Attempt has account/proxy/worker. sha256/width/height now on validator + media ingest. Full provenance row still incomplete. |
| P1-12 | Chat provenance | **PARTIAL** | Timing marks exist; TTFT not first-class. |

---

## Already in place (do not rebuild)

- Request / Attempt / Lease / fencing
- One account lock (`account-lease:` + worker `ACCOUNT_LOCKS`)
- Circuit breaker + canary effect
- ProviderAdapter, page-state
- MediaStore (local/S3) and `image-guard` byte checks
- Docker / CI / Postgres / Redis production contract
- In-process `/api/admin/invoke`, official image size tables, Leonardo chips, Canva-only login
- Commits 1–11: proxy fail-closed, JobRuntimeContext, Playwright shards, submission state machine, warmup proxy invariant, GenerationBoundary, reference sha256, ImageResultValidator, worker media, warm image runtime, model truth, canary scheduler

---

## Live gates (this workspace)

| Gate | Status |
|---|---|
| 200 mixed Chat | **NOT_EXECUTED** |
| Gemini / Leonardo image matrix | **NOT_EXECUTED** |
| 5 accounts × 20 simultaneous | **NOT_EXECUTED** (would be **BLOCKED_BY_ACCOUNT_COUNT** with fewer than 5 healthy live accounts) |
| 500-job leak | **NOT_EXECUTED** |
| Chaos (kill worker/gateway/browser/redis/pg/proxy) live provider | **NOT_EXECUTED** (in-process harness 18/18 is not this gate) |
| 1h soak | **NOT_EXECUTED** |
| 12h/24h/48h soak | **NOT_EXECUTED** |
| proxy_drift under Proxy-A-down | **NOT_EXECUTED** (unit-tested) |
| post-submit crash / no duplicate paid generation | **NOT_EXECUTED** |

---

## Commit progress

| # | Title | Git | Live |
|---|---|---|---|
| 1 | Proxy fail-closed | `b270b56` | NOT_LIVE_TESTED |
| 2 | JobRuntimeContext | `ecf2bdb` | NOT_LIVE_TESTED |
| 3 | Playwright shards | `926950e` | NOT_LIVE_TESTED |
| 4 | Submission + retrySafety | `519c386` | NOT_LIVE_TESTED |
| 4.5 | Baseline + warmup proxy + safety precedence | `5c3e2b6` | NOT_LIVE_TESTED |
| 5 | Request-scoped image generation boundary | `4ede14b` | NOT_LIVE_TESTED |
| 6 | Exact reference attachment and hash isolation | `eef8fdd` | NOT_LIVE_TESTED |
| 7 | Unified image validation and exact result contract | `f0a5f84` | NOT_LIVE_TESTED |
| 8 | Stream image assets outside job JSON | `01bb629` | NOT_LIVE_TESTED |
| 9 | Warm image provider runtime | `d443be6` | NOT_LIVE_TESTED |
| 10 | Strict model truth and selector contract | `c210e70` | NOT_LIVE_TESTED |
| 11 | Automated provider canary and selector promotion | `c361cba` | NOT_LIVE_TESTED |
| 12 | Live acceptance campaign | this commit | **NOT_EXECUTED** |

Campaign 4.5→12 is **code-complete**. Live E2E stays **NOT_EXECUTED** until actually run against healthy provider sessions. Do not treat unit green as live PASS.
