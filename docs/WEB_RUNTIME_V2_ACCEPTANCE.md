# Web Runtime V2 acceptance

Date: 2026-08-27.

This commit is **documentation only**. No new runtime code. This campaign **did not run live Chat / Image / chaos / soak against real provider accounts**.

Status vocabulary: PASS | PARTIAL | FAIL | NOT_EXECUTED | BLOCKED_BY_ENVIRONMENT.

“Code exists” is never PASS for a live gate.

## Commit map

| # | Title | Git |
|---|---|---|
| 1 | Proxy fail-closed | `b270b56` |
| 2 | JobRuntimeContext | `ecf2bdb` |
| 3 | Playwright shards | `926950e` |
| 4 | Submission state machine | `519c386` |
| 4.5 | Warmup proxy + retrySafety precedence | `5c3e2b6` |
| 5 | Generation boundary | `4ede14b` |
| 6 | Exact reference + sha256 | `eef8fdd` |
| 7 | ImageResultValidator | `f0a5f84` |
| 8 | Worker media upload | `01bb629` |
| 9 | Warm image runtime | `d443be6` |
| 10 | Model truth + selector contract | `c210e70` |
| 11 | Canary scheduler + selector promote | `c361cba` |
| 12 | This report | this commit |

## Live gates (A–J)

| Gate | Target | Status |
|---|---|---|
| A. 200 mixed Chat | success_rate, TTFT/TTLB, zero correctness faults | **NOT_EXECUTED** |
| B. 5 accounts × 20 concurrent, 3 shards | max_active_playwright_jobs ≥ 2, max_active_per_account == 1 | **NOT_EXECUTED** (would be **BLOCKED_BY_ACCOUNT_COUNT** if fewer than 5 healthy live accounts) |
| C. Gemini matrix t2i×20 + 1-ref×10 + 2-ref×5 | false_positive_image=0, 1:1 / 16:9 / 9:16 | **NOT_EXECUTED** |
| D. Leonardo GPT Image 2 matrix | same | **NOT_EXECUTED** |
| E. Leonardo Gemini / Nano Banana matrix | same | **NOT_EXECUTED** |
| F. Post-submit worker crash / gateway timeout | duplicate_paid_generation=0 | **NOT_EXECUTED** (unit: UNSAFE folds retry/switch off) |
| G. Proxy A down, Proxy B healthy | PROXY_UNAVAILABLE, proxy_drift=0 | **NOT_EXECUTED** (unit: fail-closed) |
| H. Shard metadata 3 accounts | cross_request_metadata=0 | **NOT_EXECUTED** (unit: JobRuntimeContext isolation) |
| I. 500-job leak | RSS/browsers/contexts not unbounded | **NOT_EXECUTED** |
| J. 1h soak | correctness metrics = 0 | **NOT_EXECUTED** |

## Final 25 questions

| # | Question | Answer |
|---|---|---|
| 1 | Current HEAD | this commit on `main` after 1–11 (`c361cba` + this report) |
| 2 | Commits 1–12 all exist | **PASS** (git map above; 12 is this report) |
| 3 | Account warmup respects proxy invariant | **PARTIAL** (unit `warmup_respects_account_proxy` / `warmup_respects_shard_owner` / `same_account_not_warmed_in_multiple_shards`; live **NOT_EXECUTED**) |
| 4 | Playwright actual max concurrency | Unit: shards=3 can overlap distinct accounts. Live max **NOT_EXECUTED** |
| 5 | Same-account max concurrency | Unit: 1. Live **NOT_EXECUTED** |
| 6 | proxy_drift count | Live **NOT_EXECUTED** (unmeasured) |
| 7 | cross_request_chunk count | Live **NOT_EXECUTED** (unmeasured) |
| 8 | duplicate_submit count | Live **NOT_EXECUTED** (unmeasured) |
| 9 | duplicate_paid_generation count | Live **NOT_EXECUTED** (unmeasured) |
| 10 | post-submit uncertain count | Live **NOT_EXECUTED** (unmeasured) |
| 11 | uncertain recovery success count | Live **NOT_EXECUTED** (unmeasured) |
| 12 | Gemini still full-page `img` scan first? | **PASS** unit: wait loop uses `gemini_result_locator`, not `page.locator("img")` first. Page-wide scan is last-resort fallback still scored. Live **NOT_EXECUTED** |
| 13 | Leonardo can still take a history image? | **PARTIAL** unit 100/100 permutations pick gen-NEW only. Live **NOT_EXECUTED** |
| 14 | Reference exact-count closed loop | **PARTIAL** unit 1/2/4/6 + incomplete gate before Generate. Live **NOT_EXECUTED** |
| 15 | Result sha256 excludes references | **PARTIAL** unit. Live **NOT_EXECUTED** |
| 16 | `n=4` returns 4 | Capability `maxOutputs=1` → client `n>1` is 400. Validator requires `length==n`. Live n=1 **NOT_EXECUTED** |
| 17 | Job/DB still stores giant base64? | **PARTIAL** worker uploads `/api/worker/media`; leftover data URLs still persist as a fallback. Live **NOT_EXECUTED** |
| 18 | Images go through ImageResultValidator | **PARTIAL** `finishJob` path. Live **NOT_EXECUTED** |
| 19 | requested size / actual size recorded separately | **PARTIAL** `relay.requested_size` + `actual_width/height`. Live **NOT_EXECUTED** |
| 20 | model false-confirmation = 0 | **PARTIAL** ChatGPT/Instant/Auto no longer confirm gpt-5.6. Live **NOT_EXECUTED** |
| 21 | Canary runs automatically | **PARTIAL** scheduler starts from production boot; interval+jitter unit-tested. Live **NOT_EXECUTED** |
| 22 | Selector candidate promote/rollback | **PASS** unit (N=3 promote, fail rolls back). Live **NOT_EXECUTED** |
| 23 | 200 Chat really executed | **NOT_EXECUTED** |
| 24 | Image matrices really executed | **NOT_EXECUTED** |
| 25 | 1h soak really completed | **NOT_EXECUTED** |

## Blockers to live PASS

1. Healthy ChatGPT / Gemini / Leonardo sessions in this environment.
2. At least 5 healthy accounts for concurrency gate B.
3. Operator-run 1h soak and post-submit crash injection on a real worker.

Until those exist, the campaign is **code-complete** and **live-incomplete**. Do not ship a “certified” claim.
