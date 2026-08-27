# Codex Production Web Runtime Campaign

Started: 2026-08-27  
Takeover HEAD: `b30a9f7d52653344d8512f5479b8f882c88500d0`  
Current phase: Phase 1 — production safety and hard-gate recovery

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
| 2 | Submission-aware reclaim / no duplicate paid generation | READY_FOR_COMMIT | Durable lease-fenced checkpoints; SAFE-only retry; file tests 12/12 and PG reclaim 1/1 pass; typecheck/build pass. |
| 3 | Proxy/browser/session identity isolation | PENDING | Browser pool identity must include proxy credentials/id, not only host:port. |
| 4 | Image provenance/validator/media closure | PENDING | Propagate confidence/history/asset metadata; remove silent HIGH default. |
| 5 | Canary + selector self-healing closure | PENDING | Wire worker probe, distributed scheduling/state, real low-frequency paid canary. |
| 6 | Provider/capability/key backpressure | PENDING | File + PG parity, 429/503 + Retry-After. |
| 7 | Full local automated campaign | PENDING | unit, typecheck, build, contract, concurrency, chaos, runtime, leak. |
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

Temporary dependency cache content is never committed.
