# Web Runtime V2 Baseline

Audit of `main` at `b354b53` (2026-08-27). Read from source, not older reports.

Legend: **VERIFIED** (code + tests exist) · **PARTIAL** (some path only) · **LOGIC_ONLY** (gateway logic, no worker/E2E) · **NOT_LIVE_TESTED** · **BLOCKER** (violates a V2 invariant if left as-is).

Live Chat/Image E2E, soak, and chaos in this environment: **NOT_EXECUTED**.

---

## P0 — Correctness invariants

| ID | Item | Status | Evidence |
|---|---|---|---|
| P0-1 | Account↔Proxy fail-closed | **BLOCKER** | `job_proxy()` always appends `pick_proxy()` (local 18080/10808/10809) after the assigned proxy. If assigned SOCKS is down, a healthy local proxy is used. Message still says “正在使用本机可用 SOCKS”. Gateway *does* bind `job.proxyId = account.proxyId` on enqueue and claim returns the bound proxy. Worker then drifts. |
| P0-2 | True Playwright concurrency | **BLOCKER** | One `pw_loop()` thread + one `sync_playwright()`. `SEM` and `ACCOUNT_LOCKS` exist, but all jobs go through `PW_Q` and run sequentially. `concurrencyPerWorker=3` is HTTP/claim capacity, not parallel browsers. |
| P0-3 | No process-global job env | **BLOCKER** | `exec_job_run` writes `os.environ["RELAY_JOB_ID"\|LEASE_ID\|ATTEMPT_ID\|FENCE\|ACCOUNT_ID]`. `post_chunk`/`post_phase` read those env vars. Safe only because Playwright is single-threaded today. Shards will cross-wire chunks. |
| P0-4 | Submission state machine | **PARTIAL** | Informal `post_phase("page_ready"\|"composer_ready"\|"generating")`. No `PREPARING…SUBMITTED…RESULT_VALIDATED`. No `SUBMISSION_UNCERTAIN`. |
| P0-5 | Pre vs post-submit retry | **BLOCKER** | `SEND_NOT_ACKED` → `PROVIDER_DOM_CHANGED` (no account switch). `LEONARDO_GENERATION_FAILED` **does** `switch_account`. `GENERATION_TIMEOUT` retries same account. No `retry_safety`. Post-submit timeout can enqueue a second generation. |
| P0-6 | Post-submit recovery | **BLOCKER** | After Generate click, worker waits then fails. No grace window, no pending-card recovery, no “do not regenerate”. |
| P0-7 | GenerationBoundary | **PARTIAL** | Baseline `snapshot_image_srcs` then accept new srcs. Filters favicon/svg/small. Still page-wide scan, not result-container scoped. Gemini `page.goto` every request. |
| P0-8 | Image result confidence | **PARTIAL** | Leonardo ranks by `aspect_match` + pixels and rejects square-for-16:9. No `HIGH/VERIFIED` score. No LOW-confidence production gate. |
| P0-9 | Reference exact count | **PARTIAL** | Leonardo fails if zero thumbs (`reference image did not attach`). Does **not** require `attached == requested`. Gemini attach is not exact-count gated. |
| P0-10 | Result ≠ reference | **PARTIAL** | Skip by `len(raw) in ref_sizes`. Not sha256. Collision possible. |
| P0-11 | Unified ImageResultValidator | **PARTIAL** | `image-guard.ts` PNG/JPEG magic + min bytes + UI src. No WebP dimensions, no hash, no aspect/tier, not used on every worker capture. |
| P0-12 | Size/aspect closed loop | **PARTIAL** | Leonardo: UI click + downloaded WH vs requested aspect. Gemini: `apply_gemini_aspect` click only. API `relay.size` is requested, not actual. |
| P0-13 | `n` must match results | **BLOCKER** | Job stores `n`. Gateway succeeds if `urls.length` ≥ 1. Missing images still HTTP 200. |
| P0-14 | No giant base64 in job JSON | **BLOCKER** | Worker result is `data:image/…;base64,…` via `/api/worker/result`. No `/api/worker/media`. MediaStore exists for gateway-side persist, not worker upload. |
| P0-15 | Gemini warm runtime | **BLOCKER** | `run_image_on` always `page.goto("https://gemini.google.com/app")`. Pool reuses context, then navigates anyway. |
| P0-16 | Leonardo warm runtime | **PARTIAL** | `goto_ai_creation` skips nav if already on generator. Else tries several URLs. Prompt/ref cleanup after success not guaranteed. |
| P0-17 | ChatGPT model truth | **BLOCKER** | `verifyModel("gpt-5.6", "ChatGPT")` is `confirmed: true` because labels include `chatgpt`, `instant`, `auto`, `5.2`, `5.4`. Adapter test **requires** that lie. |
| P0-18 | SEND_NOT_ACKED uncertain | **PARTIAL** | One same-page resubmit, then fail. No composer-empty / turn-increment check. Mapped to DOM_CHANGED, not `SUBMISSION_UNCERTAIN`. |

---

## P1 — Operations

| ID | Item | Status | Evidence |
|---|---|---|---|
| P1-1 | Automatic canary | **PARTIAL** | `canary.ts` + circuit `recordCanaryResult`. Job `kind=canary` on ChatGPT/Leonardo. No interval scheduler with jitter. Image canary would consume tokens if naively looped. |
| P1-2 | Canary before customer traffic | **LOGIC_ONLY** | `canDispatch` refuses OPEN circuit. Depends on canary actually running. |
| P1-3 | Selector pack hot-swap | **PARTIAL** | Versions `chatgpt-v1` / `gemini-v1` / `leonardo-image-v1` on the job. No candidate vs active promote. |
| P1-4 | Account health score | **PARTIAL** | `listEligible` sorts by `lastUsedAt` (LRU). Hard filters: healthy, session, sticky proxy, lock, token. No latency/success score. |
| P1-5 | Capability-level health | **PARTIAL** | Leonardo `availableModels` used at pick. No per-capability success_rate/latency. |
| P1-6 | Adaptive timeout | **NOT_LIVE_TESTED** | Fixed 90s Gemini / 180s Leonardo. No P99 histogram. |
| P1-7 | Queue backpressure | **BLOCKER** | No provider/key queue cap → 429. Unbounded wait then 504. |
| P1-8 | Browser/context lifecycle | **PARTIAL** | `CTX_IDLE=600`, `CTX_MAX_REQ=20`, `MAX_BROWSERS=4`. Recycle on idle/count. No crash_count / memory recycle. |
| P1-9 | Worker drain | **PARTIAL** | Gateway `claimNext` returns no job if `draining`. Worker `DRAINING` stops poll when `ACTIVE<=0`. Deploy path still SIGKILL-capable. |
| P1-10 | Image cost / tokens | **PARTIAL** | `tokenState` on Leonardo result. No token_before/after, no TOKEN_LOW scheduling. |
| P1-11 | Image provenance | **PARTIAL** | Attempt has account/proxy/worker. No asset_id, sha256, actual_size, result_confidence row. |
| P1-12 | Chat provenance | **PARTIAL** | `modelActual`, timing marks, recoveryLevel on worker result. Gateway does not persist TTFT/verified flags as first-class request fields. |

---

## Already in place (do not rebuild)

- Request / Attempt / Lease / fencing (`job-queue.ts`, `pg-jobs.ts`, `leases.ts`, `coord.ts`)
- One **account** lock at enqueue (`account-lease:` + `lockedUntil`) and worker `ACCOUNT_LOCKS`
- Circuit breaker + canary **effect** (`circuit.ts`)
- ProviderAdapter surface, page-state (DOM miss ≠ session death)
- MediaStore (local/S3) and `image-guard` byte checks
- Docker / CI / Postgres / Redis production contract
- In-process `/api/admin/invoke`, official image size tables, Leonardo Image Dimensions chips, Canva-only login

---

## Highest-risk code (must change)

```102:125:src/lib/local-worker-script.ts
def job_proxy(body):
    candidates = []
    p = body.get("proxy") or {}
    if isinstance(p, dict) and p.get("server"):
        candidates.append(p)
    alt = pick_proxy()
    if alt:
        ...
        candidates.append(alt)
    ...
    return pick_proxy()
```

```1115:1141:src/lib/local-worker-script.ts
def pw_loop():
    ...
    item = PW_Q.get()
    result = exec_job_run(body)
```

```1740:1744:src/lib/local-worker-script.ts
os.environ["RELAY_JOB_ID"] = ...
os.environ["RELAY_LEASE_ID"] = ...
os.environ["RELAY_ATTEMPT_ID"] = ...
os.environ["RELAY_FENCE"] = ...
```

```18:24:src/lib/provider/chatgpt.ts
"gpt-5.6": [..., "chatgpt", "instant", "auto", "gpt-5"],
```

```289:304:src/routes/v1/images/generations.ts
if (done.ok && urls.length) {
  return Response.json(await imagePayload(...))  // n ignored
}
```

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
| proxy_drift under Proxy-A-down | NOT_EXECUTED (will be unit-tested first) |

---

## Commit plan (do not big-bang)

1. Proxy fail-closed + invariant tests  
2. JobRuntimeContext, remove current-job env  
3. Playwright shards  
4. Submission state + retry safety  
5. GenerationBoundary + confidence  
6. Reference exact verification  
7. ImageResultValidator  
8. Worker media upload (no job-row base64)  
9. Gemini / Leonardo warm runtime  
10. Model truth  
11. Automatic canary / selector promote  
12. E2E / chaos / soak report  

Each commit: typecheck/unit (relay tests) before the next. Live E2E marked NOT_EXECUTED until actually run.
