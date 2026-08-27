# Codex Production Web Runtime Campaign

Started: 2026-08-27  
Takeover HEAD: `b30a9f7d52653344d8512f5479b8f882c88500d0`  
Current phase: Phase 7 — local automated campaign complete; release operations next

## Rules for this log

- Current repository/runtime evidence wins over earlier chat claims.
- Unit/synthetic evidence is never reported as live-provider evidence.
- A phase closes only after tests, typecheck, build, relevant E2E, diff review,
  and a focused commit where the environment permits them.
- Environment-only blockers do not stop unrelated local work.

## Baseline

The full takeover audit is in `docs/CODEX_TAKEOVER_AUDIT.md`.

At takeover:

- GitHub Actions run 61 for `b30a9f7` was red at typecheck; all tests/build
  after that step were skipped.
- The public production origin auto-issued an administrator session to an
  unauthenticated request.
- Post-submit worker recovery could requeue submitted paid image jobs.
- PostgreSQL reclaim could requeue a healthy long-running job based only on
  `started_at`, without consulting the worker heartbeat.
- selector promotion existed only as disconnected process-local code/tests;
  paid canaries were scheduled but explicitly skipped.
- real Chat/Image matrices, multi-account browser concurrency, failure
  injection, leak tests, and ≥1h soak were not executed for the current HEAD.

## Phase tracker

| Phase | Scope | Status | Evidence / next gate |
|---|---|---|---|
| 0 | Required source read + takeover audit | COMPLETE | `CODEX_TAKEOVER_AUDIT.md`; latest 20 commits read. |
| 1A | Public admin auto-login fail-closed | COMPLETE | Commit `5e2bb60`; production-shaped GET + cookie tests 9/9 pass. |
| 1B | Existing typecheck/lint/build blockers | COMPLETE | Commit `d0ba670`; typecheck PASS, lint 0 errors, production build PASS. Full campaign tests remain in Phase 7. |
| 1C | SSE logical status authority | COMPLETE | Commit `c429950`; focused parser/history tests 8/8 pass. |
| 2 | Submission-aware reclaim / no duplicate paid generation | COMPLETE | Commit `1ff9844`; durable checkpoints, SAFE-only retry, heartbeat-aware PG reclaim and fenced cancellation. |
| 3A | Proxy/browser/session identity isolation | COMPLETE | Commit `1ff9844`; proxy ID/credential fingerprint keys browser pools and launch config strips internal fields. Live proxy-down gate remains Phase 8. |
| 3B | Model truth + operational default | COMPLETE | Commit `06cca41`; honest web-auto default, exact-model fail closed, full truth metadata. |
| 3C | Chat attachment/disconnect closure | COMPLETE | Commit `06cca41`; exact vision attachment and cancellation/uncertainty closure. |
| 4 | Image provenance/validator/media closure | COMPLETE | Commit `ac0ae39`; frozen refs, strict confidence/assets/history, DOM correlation, WebP, WARM_IDLE fail-closed. |
| 5 | Canary + selector self-healing closure | COMPLETE | Commit `71fd1f1`; distributed dispatch lease, real paid canary, shared selector state, finish-path fingerprint/promotion. |
| 6 | Provider/capability/key backpressure | COMPLETE | Commit `71fd1f1`; global/provider/chat/image/key caps, file + distributed PG admission, 429/Retry-After. |
| 7 | Full local automated campaign | COMPLETE | Relay 207/207; core 96 pass + 1 environment skip; CI 16 pass + 1 environment skip; chaos 18/18; 120s reliability 228/228; real local Chromium lifecycle 500/500; typecheck/build pass; lint 0 errors. |
| 8 | Real providers + soak | BLOCKED_BY_ENVIRONMENT | Needs healthy sessions/accounts and reachable production worker/infrastructure. |
| 9 | Final acceptance | PENDING | `CODEX_FINAL_ACCEPTANCE.md`, requirement-by-requirement completion audit. |

## Environment blockers (do not stop local phases)

| Blocker | Current evidence | Affected gates |
|---|---|---|
| `LOGIN_REQUIRED` / `NO_REAL_ACCOUNT` | No verified usable ChatGPT/Gemini/Leonardo credentials are available to this worktree. | 200 Chat, image matrices, live DOM recovery. |
| `BLOCKED_BY_ACCOUNT_COUNT` | Five healthy accounts have not been demonstrated. | 5-account × 20 concurrency. |
| Server shell unreachable | TCP 246 and 22 were unreachable from this environment. | Host config, worker logs, deploy, real backup/restore. |
| GitHub write unavailable | Connected GitHub identity has repository read but no push permission. | Push/PR/remote CI for new commits. |
| Long soak prerequisites | Real providers and stable target infrastructure are not available locally. | ≥1h soak and live crash/proxy/provider injections. |

## Current correctness counters

All target live counters remain **UNMEASURED** until the matching real campaign
runs. No zero is inferred from unit tests:

`proxy_drift`, `cross_request_chunk`, `duplicate_submit`,
`duplicate_paid_generation`, `partial_truncation`,
`historical_image_returned`, `reference_image_returned`, `ui_image_returned`,
`reference_missed`, `wrong_result_count`, `wrong_size`,
`stale_result_accepted`, `model_false_confirmation`, `lost_request`,
`double_lease`.

## Commit log for this campaign

- `6dc58a7` — takeover audit and Campaign tracker
- `5e2bb60` — production admin login fail-closed
- `d0ba670` — restore hard typecheck/build/lint gates
- `c429950` — authoritative SSE logical status and terminal partial text
- `1ff9844` — durable submission checkpoints, safe reclaim, proxy pool isolation
- `06cca41` — truthful chat model contract, exact vision attach, abort recovery
- `ac0ae39` — frozen references, strict image provenance, warm runtime closure
- `71fd1f1` — distributed provider self-healing and bounded admission

## Phase 7 evidence (2026-08-28)

- `npm run test:relay`: **207/207 PASS**.
- `npm test`: **96 PASS**, 1 environment skip (`worker.py` bootstrap-only
  template gate), 0 failures.
- `npm run test:ci`: Relay **207/207 PASS** plus multi-process/contract suite
  **16 PASS**, 1 environment skip, 0 failures.
- `npm run test:chaos`: **18/18 PASS** across two gateways with shared PGlite
  and Redis, including process/database restarts and fenced stale results.
- `npm run test:reliability`: 120,415 ms, **228/228**, lost requests 0,
  duplicate executions 0, five gateway restarts, P50/P95/P99
  516/581/605 ms. This is scheduler/mock-completion evidence, not live DOM
  evidence.
- `RELAY_LEAK_CONCURRENCY=4 npm run test:leak`: **500/500 PASS** against the
  real local Python Worker and headless Chromium self-test page. Final active,
  browser, context, and queue counts were all 0; process-tree RSS grew by
  5,021,696 bytes after warmup. No live provider account was used.
- `npm run typecheck`: PASS. `npm run lint`: 0 errors (remaining warnings are
  tracked pre-existing cleanup). `npm run build:app`: PASS.

Temporary dependency cache content is never committed.
