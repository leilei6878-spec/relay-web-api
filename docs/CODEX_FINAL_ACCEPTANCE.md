# Codex Final Acceptance — relay-web-api 0.9.0-rc2

Date: 2026-08-28

Overall status: **PARTIAL**

Takeover HEAD: b30a9f7d52653344d8512f5479b8f882c88500d0

Final implementation HEAD: c46eb82d5c50955a359114b6a9de76461dfd0a2e

Production currently serves the final implementation HEAD. No known P0 remains
open in the deployed code. Overall acceptance stays PARTIAL because the
required 200-request Chat campaign, complete Gemini/Leonardo image matrices,
five-account live concurrency, and one-hour live soak were not completed.

## Current evidence

| Gate | Status | Evidence |
|---|---|---|
| Relay unit/integration | **PASS** | 221/221 |
| Core/template contract | **PASS** | 101/101 |
| Multi-process/operations contract | **PASS** | 21/21 |
| Two-gateway chaos | **PASS** | 18/18; fenced stale results and restart recovery pass |
| Scheduler reliability | **PASS** | 120,415 ms; 228/228; lost 0; duplicate execution 0; five gateway restarts |
| Local Chromium leak | **PASS** | 500/500; concurrency 4; final browsers/contexts/queues 0; post-warmup RSS +5,021,696 bytes |
| Typecheck / build / lint | **PASS** | TypeScript, Vite/Nitro production build, lint 0 errors |
| Production dependencies | **PASS** | npm audit --omit=dev reports 0 vulnerabilities |
| Dev + built browser render | **PASS** | Desktop and 390×844 mobile; no overflow or error heading |
| Pre-deploy backup | **PASS** | Verified checksummed DB, media, MinIO, configuration and Git metadata backup |
| Production deployment | **PASS** | External health and readiness return 0.9.0-rc2, schema 4 and exact commit c46eb82; DB/Redis/object media/worker ready |
| Anonymous admin boundary | **PASS** | External /api/admin/session returns HTTP 401 and no Set-Cookie |
| Account add persistence | **PASS** | Public insecure HTTP UI add → refresh → delete → refresh passed without randomUUID; console errors 0; test record removed |
| Live Chat | **PARTIAL** | Real non-stream and SSE marker requests succeeded; one earlier request ended RESULT_UNCERTAIN; 200-request matrix not run |
| Live image | **PARTIAL** | One Leonardo request safely returned RESULT_UNCERTAIN after submit; no image or fake success returned; the resulting size-control defect was fixed and deployed |

## Required 30 answers

1. **接手时 HEAD — PASS.**
   b30a9f7d52653344d8512f5479b8f882c88500d0.

2. **最终 HEAD — PASS.**
   Final implementation HEAD is
   c46eb82d5c50955a359114b6a9de76461dfd0a2e. The final report commit is
   documentation-only and follows this implementation HEAD.

3. **本次 commits — PASS.**
   6dc58a7, 5e2bb60, d0ba670, c429950, 1ff9844, 06cca41,
   ac0ae39, 71fd1f1, 68e60ed, 1035633, 47be2f3, 9e4fc8b,
   d9ccd60, 1e1c207, 9860071, 7206861, e286563, 9969bfa,
   63c7708, 635f909 and c46eb82.

4. **还存在什么 P0 — PASS.**
   No known P0 remains open in the deployed candidate. The live anonymous
   administrator-cookie issue was closed and externally verified. A live API
   metadata privacy leak was found, fixed and verified. A Leonardo size
   selector JavaScript defect and fail-open size gate were also found, fixed
   and deployed. Public HTTP account creation was blocked by unavailable
   crypto.randomUUID; the UID generator now uses crypto.getRandomValues when
   randomUUID is unavailable. Remaining items are coverage/scale gates rather
   than known P0 defects.

5. **Chat completion 是否还会提前截断 — PARTIAL.**
   The detector requires confirmed completion, reopens if the DOM grows,
   separates partial/final text, and passes pause/no-Stop/Stop tests. Multiple
   real marker requests returned complete exact text, including SSE, but the
   required 200-request campaign has not proved the long-run error count zero.

6. **SSE HTTP200/业务状态是否彻底分离 — PASS.**
   Transport and logical status are separate across parser, history and UI.
   Local timeout/disconnect/partial tests pass, and one real SSE request
   produced exact content plus an explicit done terminal event.

7. **多账号实际最大并发 — PARTIAL.**
   Locally verified: four concurrent real Chromium lifecycles, seven unique
   simultaneous leases, and distinct-account shards in parallel. Production
   has one ChatGPT and one Leonardo account, so five-account live concurrency
   was not available.

8. **同账号实际最大并发 — PARTIAL.**
   Account locks, leases and shard tests keep the local maximum at 1.
   Production traffic observed no overlapping active job on the tested
   account, but a sustained live concurrency campaign was not run.

9. **Proxy drift — PARTIAL.**
   Browser pools, warmup and jobs are keyed to the account-bound proxy identity
   and credentials and fail closed. No drift was seen in the small live sample;
   the full live counter remains unmeasured.

10. **cross-request chunk — PARTIAL.**
    JobRuntimeContext and fencing/isolation tests pass. Live non-stream and SSE
    marker content was exact, but the 200-request campaign was not run.

11. **duplicate submit — PARTIAL.**
    Idempotency storms, fencing and crash recovery pass. The live Chat
    RESULT_UNCERTAIN request was not silently resubmitted. A full live
    failure-injection matrix was not run.

12. **duplicate paid image generation — PARTIAL.**
    The real Leonardo timeout was recorded as SUBMITTED plus UNSAFE and was not
    retried or failed over. This is direct evidence of the safety gate, but a
    full paid crash/recovery campaign was not run.

13. **Reference exact count — PARTIAL.**
    Exact 1/2/4/6 attachment and hash exclusion pass locally for Gemini and
    Leonardo. Live reference matrices were not run.

14. **GenerationBoundary — PARTIAL.**
    Request/attempt/time, prior container/URL/hash state, scoped new results,
    confidence and reference/history exclusion are implemented and tested.
    The one live image attempt did not yield a validated result.

15. **false-positive image — PARTIAL.**
    Production only accepts HIGH/VERIFIED correlated results. The live
    uncertain attempt returned zero images instead of a false success; the
    full live matrix remains incomplete.

16. **requested n / actual n — PARTIAL.**
    Count mismatch fails closed and unsupported provider counts are rejected.
    The live request asked for one and returned no success after uncertainty;
    no successful live count matrix exists.

17. **requested size / actual size — PARTIAL.**
    Final image bytes are parsed and validated against aspect/tier/native size.
    Live testing found that a Python-embedded JavaScript newline was malformed
    and that unreadable dimensions could previously reach Generate. The
    embedded script is now runtime-compiled in tests, dimensions must equal the
    selected native size before submit, and unknown dimensions fail closed.
    Successful 1:1/16:9/9:16 live matrices remain unexecuted.

18. **Job 是否还保存大 Base64 — PASS.**
    References are frozen into MediaStore and workers return asset
    descriptors. The 1/5/15 MB tests prove Job JSON does not carry image
    base64.

19. **Gemini warm runtime — BLOCKED_BY_ENVIRONMENT.**
    WARM_IDLE reuse, cleanup and reference isolation pass locally. Production
    has no Gemini account.

20. **Leonardo warm runtime — PARTIAL.**
    The live session authenticated and selected Nano Banana 2. One real
    generation became uncertain after submit. The size-control defect found by
    that run is fixed; WARM_IDLE and reference isolation remain locally tested,
    not yet proven by a successful live image matrix.

21. **Model truth — PASS.**
    Requested and actual model/profile fields are distinct. Real Chat auto
    responses reported actual_model=unknown and model_verified=false rather
    than inventing an exact model. Internal account and topology identifiers
    are now stripped from all public relay metadata. Account creation now waits
    for an acknowledged server write and reports authentication, network or
    protected-write failures instead of silently losing the row.

22. **Canary 自动运行 — PARTIAL.**
    Distributed scheduling, structural probes, low-frequency paid image
    probes and selector promotion are deployed. The healthy ChatGPT and
    Leonardo accounts are marked as canary accounts. Leonardo structural
    probes now validate the size selector without clicking Generate, and the
    scheduler selects a logical Leonardo model verified on its assigned
    account instead of blindly choosing the provider's first model. A real
    post-deploy Leonardo structural Canary selected leonardo-gemini and entered
    the Worker; it then failed before submit because the page could not recover
    to WARM_IDLE. The durable state remained PREPARING/SAFE, so Generate was
    not clicked and no paid request was made. Gemini is blocked by the absence
    of an account, and a long production observation window is not complete.

23. **Selector promote/rollback — PASS.**
    Candidate state is distributed; three consecutive passes promote, failure
    rolls back, and finish-path fingerprints drive the decision.

24. **200 Chat 是否真实完成 — BLOCKED_BY_ENVIRONMENT.**
    Real non-stream and SSE requests ran, but not 200 mixed requests. Only one
    production ChatGPT account is available and no one-hour observation window
    was completed.

25. **Image matrices 是否真实完成 — BLOCKED_BY_ENVIRONMENT.**
    Production has one Leonardo account and no Gemini account. One Leonardo
    request ended RESULT_UNCERTAIN and exposed a now-fixed defect. Required
    model/reference/aspect/count matrices were not completed.

26. **最长实际 soak — PARTIAL.**
    Longest automated scheduler run was 120,415 ms and the Chromium lifecycle
    campaign completed 500 jobs. The required one-hour live-provider soak was
    not executed.

27. **当前已验证账号数 — PARTIAL.**
    Production has two healthy accounts: one ChatGPT and one Leonardo. ChatGPT
    completed real requests. Leonardo authenticated and submitted a request but
    did not return a validated image. Gemini has zero accounts.

28. **当前已验证并发 — PARTIAL.**
    Local Chromium concurrency 4; distributed unique leases 7; same-account
    maximum 1. Production Worker capacity is 2, but live multi-account maximum
    was not measured under load.

29. **所有 NOT_EXECUTED — PASS.**
    No known locally automatable high-priority code gate remains. Still
    **BLOCKED_BY_ENVIRONMENT**: 200 mixed live Chat requests; Gemini and both
    Leonardo model image matrices; five-account live concurrency; live
    proxy/session/DOM/crash injections at matrix scale; and one-hour live soak.
    A successful post-fix Leonardo output-size matrix is also not executed.

30. **是否建议进入正式部署测试 — PARTIAL.**
    The controlled production deployment test is already running and its
    health, readiness, anonymous-admin boundary, responsive UI and real Chat
    path pass. Do not yet claim unrestricted commercial reliability until the
    image matrices, 200 Chat campaign, five-account concurrency and one-hour
    soak pass.

## Hard correctness counters

Local synthetic campaigns observed zero lost_request, double_lease,
stale-result acceptance and duplicate execution in their covered workloads.
The small live sample also returned no false image and did not retry the unsafe
submitted Leonardo attempt. These observations are not extrapolated to the
required full live campaigns.

| Counter | Status |
|---|---|
| proxy_drift | **BLOCKED_BY_ENVIRONMENT** |
| cross_request_chunk | **PARTIAL** |
| duplicate_submit | **PARTIAL** |
| duplicate_paid_generation | **PARTIAL** |
| partial_truncation | **PARTIAL** |
| historical_image_returned | **BLOCKED_BY_ENVIRONMENT** |
| reference_image_returned | **BLOCKED_BY_ENVIRONMENT** |
| ui_image_returned | **PARTIAL** |
| reference_missed | **BLOCKED_BY_ENVIRONMENT** |
| wrong_result_count | **BLOCKED_BY_ENVIRONMENT** |
| wrong_size | **BLOCKED_BY_ENVIRONMENT** |
| stale_result_accepted | **BLOCKED_BY_ENVIRONMENT** |
| model_false_confirmation | **PARTIAL** |
| lost_request | **BLOCKED_BY_ENVIRONMENT** |
| double_lease | **BLOCKED_BY_ENVIRONMENT** |

## Production state at report time

- **PASS:** external health and readiness return exact release
  c46eb82d5c50955a359114b6a9de76461dfd0a2e with no blockers.
- **PASS:** Postgres, Redis, object media and the Worker are online; the Worker
  advertises capacity 2.
- **PASS:** anonymous administrator session request returns HTTP 401 without a
  cookie.
- **PASS:** a full checksummed pre-deploy backup is retained at
  /opt/backups/relay-pre-rc2-20260828-130046.
- **PASS:** SSH key authentication is working on the confirmed host key and
  port 246.
- **PARTIAL:** two healthy canary accounts are configured; Gemini has no
  account.
- **PARTIAL:** the live Leonardo structural Canary dispatched with the correct
  model but reported a pre-submit WARM_IDLE/DOM cleanup failure. It remained
  PREPARING/SAFE and did not generate a paid image.
- **BLOCKED_BY_ENVIRONMENT:** the connected GitHub identity has pull but not
  push permission. Production was updated through verified Git bundles, so
  origin/main remains behind the deployed/local branch.

## Live incidents found during acceptance

1. A public Chat response exposed the account email and internal worker,
   account and proxy IDs in the relay extension. Commit 7206861 introduced a
   shared public metadata boundary; real non-stream and SSE responses then
   proved the private keys absent.
2. A Leonardo size selector contained an embedded JavaScript newline escaping
   defect. The page reported 0×0, yet the old gate continued to Generate. The
   request became RESULT_UNCERTAIN after submit and was not retried. Commit
   e286563 fixes the script and requires exact visible native dimensions before
   submit. Commit 9969bfa adds the same no-charge check to the structural
   canary.
3. Account creation updated only browser memory and depended on a delayed
   background save whose result was ignored. Commit 63c7708 adds an explicit
   acknowledged write, duplicate guard, saving state and visible failure
   handling. Both an isolated local browser and production Chromium completed
   add, reload persistence, delete and reload cleanup with zero console errors.
4. The live scheduler initially skipped Leonardo because it always requested
   the provider's first logical model, while the Canary account had verified a
   different family. Commit 635f909 selects the first account-compatible
   logical model and has a regression test for Nano Banana/Gemini versus GPT
   Image capability lists.
5. Account creation still failed specifically on the public HTTP IP because
   browsers do not expose crypto.randomUUID in an insecure context. The live
   browser console identified the exact exception. Commit c46eb82 adds an RFC
   4122-compatible crypto.getRandomValues fallback. A production Chromium test
   confirmed isSecureContext=false, randomUUID unavailable, add/reload/delete/
   reload all pass, and console errors remain zero.

## Remaining live blocker

Leonardo currently cannot prove WARM_IDLE after cleanup on its live page. The
new structural Canary detects this before submission and fails with
LEONARDO_DOM_CHANGED while retry safety is still SAFE. This is not a fake
success or duplicate-charge defect, but it blocks successful Leonardo image
matrices until the provider DOM/session cleanup path is reconfirmed on the live
account.

The correct final decision is therefore **PARTIAL**: the deployed candidate has
no known open P0 and all locally automatable high-priority gaps are closed, but
the explicitly required large live campaigns remain blocked by account count,
provider availability and long observation time.
