# Codex Production Web Runtime Campaign

Started: 2026-08-27  
Takeover HEAD: `b30a9f7d52653344d8512f5479b8f882c88500d0`  
Current phase: Phase 10 — controlled production deployed; large live matrices and soak remain

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
| 7 | Full local automated campaign | COMPLETE | Relay 234/234; core 101/101; CI operations 21/21; chaos 18/18; 120s reliability 228/228; real local Chromium lifecycle 500/500; typecheck/build pass; lint 0 errors. |
| 7B | Production recovery + Compose contract | COMPLETE | Versioned/checksummed backup includes secrets/sessions; DB backup/restore fail closed; Compose has no required-secret defaults and host health port is consistently 8088. CLI/contract tests 6/6 pass. |
| 7C | Release identity | COMPLETE | `0.9.0-rc2`; health/readiness/runtime expose exact commit and build time; production readiness rejects an unknown commit. |
| 7D | Dev + production browser render | COMPLETE | Desktop and 390×844 mobile render with visible content, no horizontal overflow, and zero browser-console warnings/errors. Production-only partial runtime response crash was found, fixed, rebuilt, and retested. |
| 7E | Production dependency audit | COMPLETE | Official npm audit 0 vulnerabilities after removing unpatched `image-size` and replacing it with bounded PNG/JPEG/WebP parsing. |
| 8 | Real providers + soak | PARTIAL | Real Chat non-stream/SSE pass; Leonardo live WARM_IDLE/attach/cleanup and reused-card recovery pass; one real image-to-image request returned HTTP 200 with one 1024×1024 result. 200 Chat, full image matrices, five-account load and one-hour soak remain blocked. |
| 9 | Final acceptance | COMPLETE | `CODEX_FINAL_ACCEPTANCE.md` answers all 30 required questions and preserves every external/live blocker. |
| 10 | Controlled production deployment | COMPLETE | Verified backup, bundle import, Compose rebuild, exact release identity, readiness, anonymous-admin 401, real Chat, public metadata redaction, account add persistence and production UI add/reload/delete/reload. |

## Environment blockers (do not stop local phases)

| Blocker | Current evidence | Affected gates |
|---|---|---|
| `BLOCKED_BY_ACCOUNT_COUNT` | Production has one healthy ChatGPT account, one healthy Leonardo account and no Gemini account. | 200 mixed Chat at scale, full image matrices, 5-account × 20 concurrency. |
| Leonardo matrix coverage | A real 1024×1024 text-to-image result was recovered from a reused card and one image-to-image request passed end to end. | Remaining model, 16:9/9:16, 2/4/6 reference and count matrices. |
| Server shell/deploy | Resolved: confirmed SSH host key, key authentication, port 246, verified backup and production bundle deployment. | None; host remains reachable. |
| GitHub write unavailable | Connected GitHub identity has repository read but no push permission. | Push/PR/remote CI for new commits. |
| Long soak prerequisites | Stable production exists, but the required account count and observation time were not available in this campaign. | ≥1h live soak and matrix-scale failure injection. |

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
- `68e60ed` — cross-platform full local reliability and 500-job leak campaign
- `1035633` — fail-closed production backup/restore and Compose contract
- `47be2f3` — exact release identity and `0.9.0-rc2`
- `9e4fc8b` — production-dashboard partial runtime response resilience
- `d9ccd60` — bounded image metadata parsing; production dependency audit 0
- `1e1c207` — publish initial final acceptance report
- `9860071` — keep the production Node 22/npm 10 lockfile compatible
- `7206861` — strip account identity and internal topology from public relay metadata
- `e286563` — fix Leonardo embedded JavaScript and fail closed on unverified size
- `9969bfa` — extend the free structural Leonardo canary through size controls
- `63c7708` — persist account additions explicitly and surface save failures
- `635f909` — select a Leonardo canary model compatible with the assigned account
- `c46eb82` — generate browser UIDs when public HTTP lacks crypto.randomUUID
- `68bb245` — stop Leonardo login helper tab recreation and focus stealing
- `4d4041a` — reset only the dedicated Leonardo login profile before launch
- `9a6776d` — keep the Leonardo login phase manual until explicit export
- `7566ddb` — scope Leonardo reference cleanup to the prompt container
- `aa3f74a` — align image timeouts and prefer full-resolution CDN assets
- `2425cb4` — recover prompt-correlated results from reused Leonardo cards
- `e01bf54` — deduplicate the `image` / `images` reference aliases
- `d49a371` — preserve PNG/JPEG/WebP extensions for frozen reference uploads
- `0adce26` — add a standalone administrator username/password login page
- `186ace9` — use a Compose-safe scrypt password-hash representation
- `8b9ef5e` — keep administrator log history visible after password login
- `307d83e` — restore the requested Leonardo model after reference upload
- `d1811e6` — target the Leonardo model drawer by its stable model ID

## Phase 7 evidence (2026-08-28)

- `npm run test:relay`: **234/234 PASS**.
- `npm test`: **101/101 PASS**.
- `npm run test:ci`: Relay **212/212 PASS** at the original full CI checkpoint plus multi-process/contract suite
  **21/21 PASS**.
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

## Phase 10 production evidence (2026-08-28)

- Production health/readiness: HTTP 200, version 0.9.0-rc2, schema 4,
  exact implementation commit d1811e62cfbabd360a542ea93a1cd29d85277df0,
  zero blockers; Postgres, Redis, object media and Worker are ready.
- Anonymous /api/admin/session: HTTP 401 and no Set-Cookie.
- Real Chat: exact non-stream marker PASS; exact SSE marker plus done PASS;
  actual_model remained unknown and model_verified remained false.
- Public metadata: account email plus worker/account/proxy IDs absent from real
  non-stream and SSE responses.
- Real Leonardo: an early request reached SUBMITTED/UNSAFE and ended
  RESULT_UNCERTAIN with zero returned images and no automatic retry. The real
  1024×1024 result was later found in history and the deployed reused-card
  detector selected it HIGH. A separate image-to-image request attached one
  deduplicated PNG reference and returned HTTP 200, one image and actual
  1024×1024 dimensions.
- Account management: local and production Chromium both completed add,
  reload persistence, delete and reload cleanup; console errors 0. A separate
  production API add/read/delete/read check also passed and restored the
  original account count.
- The user's public HTTP browser exposed a second account-add blocker:
  crypto.randomUUID is unavailable outside secure contexts. The UID generator
  now falls back to crypto.getRandomValues. Production Chromium verified the
  exact insecure runtime plus add/reload/delete/reload with zero console errors.
- The Leonardo Windows login helper was found recreating tabs during OAuth and
  periodically auto-clicking/stealing focus. The deployed pack now opens Canva
  and Leonardo once at startup and then performs read-only session detection;
  production pack inspection found one startup call and zero SSO/focus calls.
- The dedicated chrome-login profile is now removed and recreated before each
  run, preventing aborted Canva/Stripe tabs from being restored without
  touching the user's daily Chrome profile.
- Two healthy production accounts are marked Canary; Gemini remains without
  an account. The default structural interval is about seven minutes and paid
  image interval about three hours.
- Leonardo prompt-container cleanup is now live-verified WARM_IDLE → DIRTY →
  WARM_IDLE. Pre-submit upload failures stayed PREPARING/SAFE. URL/hash
  deduplication plus true file extensions closed the production upload path,
  after which the real image-to-image request completed successfully.
- Standalone administrator login is live at `/login`. The configured password
  is stored only as a random-salt scrypt hash. Production checks passed for the
  page, generic wrong-password response, HttpOnly cookie, successful protected
  account-pool read and unauthorized data pre-render gating.
- The post-login log-history regression is closed. Empty Bearer headers no
  longer shadow the administrator cookie, failed fetches no longer erase the
  visible table, and production returned 129 retained usage rows over HTTP 200.
- Leonardo image-to-image now reselects the exact Nano Banana 2 drawer item
  after reference upload, then rechecks attachment and dimensions. A real
  16:9 Medium request completed with HTTP 200, one result and actual
  2752×1536; its final job state is RESULT_VALIDATED and the account is
  healthy/WARM_IDLE.
