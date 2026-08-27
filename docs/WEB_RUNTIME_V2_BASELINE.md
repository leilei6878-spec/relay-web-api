# Web Runtime V2 Baseline

Audit of `main` at `519c386` (2026-08-27), after Commits 1–4.

Legend: **VERIFIED** (code + unit tests) · **PARTIAL** (some path only) · **LOGIC_ONLY** · **NOT_LIVE_TESTED** · **BLOCKER** (still violates a V2 invariant).

Live Chat/Image E2E, soak, and chaos in this environment: **NOT_EXECUTED**.

---

## P0 — Correctness invariants

| ID | Item | Status | Evidence |
|---|---|---|---|
| P0-1 | Account↔Proxy fail-closed | **VERIFIED** / **NOT_LIVE_TESTED** | `job_proxy()` never appends `pick_proxy()` in production. Assigned-down → `None` + `PROXY_UNAVAILABLE`. `PROXY_IDENTITY_MISMATCH` if server/id drift. Claim uses `job.proxyId`. Unit: `production job_proxy never falls back`. Live `proxy_drift`: **NOT_LIVE_TESTED**. |
| P0-2 | True Playwright concurrency | **VERIFIED** / **NOT_LIVE_TESTED** | `PlaywrightShard` × `RELAY_PLAYWRIGHT_SHARDS` (default 3). Stable `shard_for_account`. Poll dispatches without waiting. Unit: distinct accounts overlap ≥ 2, same account max = 1. Live 5×20: **NOT_LIVE_TESTED**. |
| P0-3 | No process-global job env | **VERIFIED** / **NOT_LIVE_TESTED** | `JobRuntimeContext` passed into `post_chunk`/`post_phase`/`post_result`. No `os.environ["RELAY_JOB_ID"]`. Concurrent chunk payloads stay on their job ids. Live `cross_request_chunk`: **NOT_LIVE_TESTED**. |
| P0-4 | Submission state machine | **VERIFIED** / **NOT_LIVE_TESTED** | `PREPARING` → `COMPOSER_READY` → `INPUT_READY` → `SUBMITTING` → `SUBMITTED` → `GENERATING` → `RESULT_VALIDATED`. `SUBMISSION_UNCERTAIN` / `RESULT_UNCERTAIN` exist. Live recovery: **NOT_LIVE_TESTED**. |
| P0-5 | Pre vs post-submit retry | **VERIFIED** / **NOT_LIVE_TESTED** | `retrySafety` SAFE/UNKNOWN/UNSAFE. `decideWithSafety` beats fault code. Post-submit never `switch_account`. Pre-submit `LEONARDO_GENERATION_FAILED` may still failover. Live `duplicate_paid_generation`: **NOT_LIVE_TESTED**. |
| P0-6 | Post-submit recovery | **PARTIAL** / **NOT_LIVE_TESTED** | Uncertain path waits on the same page instead of a second Generate. No pending-card / grace-window recovery yet. |
| P0-7 | GenerationBoundary | **PARTIAL** | Baseline src snapshot + filters. Still page-wide `img` scan. Gemini `page.goto` every request. |
| P0-8 | Image result confidence | **PARTIAL** | Leonardo aspect/pixels ranking. No HIGH/VERIFIED production gate. |
| P0-9 | Reference exact count | **PARTIAL** | Leonardo fails if zero thumbs. Does not require `attached == requested`. |
| P0-10 | Result ≠ reference | **PARTIAL** | Skip by `len(raw) in ref_sizes`. Not sha256. |
| P0-11 | Unified ImageResultValidator | **PARTIAL** | `image-guard.ts` PNG/JPEG magic. No WebP dim, hash, aspect/tier on every capture. |
| P0-12 | Size/aspect closed loop | **PARTIAL** | Leonardo WH vs requested aspect. API `relay.size` is requested, not actual. |
| P0-13 | `n` must match results | **BLOCKER** | Gateway succeeds if `urls.length` ≥ 1. |
| P0-14 | No giant base64 in job JSON | **BLOCKER** | Worker result is `data:image/…;base64`. No `/api/worker/media`. |
| P0-15 | Gemini warm runtime | **BLOCKER** | `run_image_on` always `page.goto("https://gemini.google.com/app")`. |
| P0-16 | Leonardo warm runtime | **PARTIAL** | `goto_ai_creation` skips nav if already on generator. Prompt/ref cleanup not guaranteed. |
| P0-17 | ChatGPT model truth | **BLOCKER** | `verifyModel("gpt-5.6", "ChatGPT")` is confirmed. Adapter test requires that lie. |
| P0-18 | SEND_NOT_ACKED uncertain | **VERIFIED** / **NOT_LIVE_TESTED** | Click without ACK → `SUBMISSION_UNCERTAIN` (no second send). Mapped before DOM_CHANGED. Composer-empty / turn-increment counted as evidence. Live: **NOT_LIVE_TESTED**. |

---

## P1 — Operations

| ID | Item | Status | Evidence |
|---|---|---|---|
| P1-1 | Automatic canary | **PARTIAL** | `canary.ts` + circuit. No interval scheduler with jitter. |
| P1-2 | Canary before customer traffic | **LOGIC_ONLY** | `canDispatch` refuses OPEN. Depends on canary running. |
| P1-3 | Selector pack hot-swap | **PARTIAL** | Versioned packs. No candidate vs active promote. |
| P1-4 | Account health score | **PARTIAL** | LRU + hard filters. No latency/success score. |
| P1-5 | Capability-level health | **PARTIAL** | Leonardo `availableModels` at pick. |
| P1-6 | Adaptive timeout | **NOT_LIVE_TESTED** | Fixed 90s / 180s. |
| P1-7 | Queue backpressure | **BLOCKER** | No provider/key queue cap → 429. |
| P1-8 | Browser/context lifecycle | **PARTIAL** | Idle/count recycle. No crash_count / memory recycle. |
| P1-9 | Worker drain | **PARTIAL** | Gateway skips claim if draining. SIGKILL still possible. |
| P1-10 | Image cost / tokens | **PARTIAL** | `tokenState` on Leonardo result. |
| P1-11 | Image provenance | **PARTIAL** | Attempt has account/proxy/worker. No sha256/confidence row. |
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
- Commits 1–4: proxy fail-closed, JobRuntimeContext, Playwright shards, submission state machine

---

## Live gates (this workspace)

| Gate | Status |
|---|---|
| 200 mixed Chat | NOT_EXECUTED |
| Gemini / Leonardo image matrix | NOT_EXECUTED |
| 5 accounts × 20 simultaneous | NOT_EXECUTED |
| 500-job leak | NOT_EXECUTED |
| Chaos (kill worker/gateway/browser/redis/pg/proxy) | NOT_EXECUTED |
| 1h soak | NOT_EXECUTED |
| 12h/24h/48h soak | NOT_EXECUTED |
| proxy_drift under Proxy-A-down | NOT_EXECUTED (unit-tested) |

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
| 9 | Warm image provider runtime | this commit | NOT_LIVE_TESTED |
| 10–12 | model / canary / E2E | pending | |

Each remaining commit: relay unit tests before the next. Live E2E stays **NOT_EXECUTED** until actually run.
