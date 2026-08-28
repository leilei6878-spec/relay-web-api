# Codex Final Acceptance — relay-web-api 0.9.0-rc2

Date: 2026-08-28

Overall status: **PARTIAL**

Takeover HEAD: b30a9f7d52653344d8512f5479b8f882c88500d0

Final implementation HEAD: d1811e62cfbabd360a542ea93a1cd29d85277df0

Production currently serves the final implementation HEAD. No known P0 remains
open in the deployed code. Overall acceptance stays PARTIAL because the
required 200-request Chat campaign, complete Gemini/Leonardo image matrices,
five-account live concurrency, and one-hour live soak were not completed.

## Current evidence

| Gate | Status | Evidence |
|---|---|---|
| Relay unit/integration | **PASS** | 234/234 |
| Core/template contract | **PASS** | 101/101 |
| Multi-process/operations contract | **PASS** | 21/21 |
| Two-gateway chaos | **PASS** | 18/18; fenced stale results and restart recovery pass |
| Scheduler reliability | **PASS** | 120,415 ms; 228/228; lost 0; duplicate execution 0; five gateway restarts |
| Local Chromium leak | **PASS** | 500/500; concurrency 4; final browsers/contexts/queues 0; post-warmup RSS +5,021,696 bytes |
| Typecheck / build / lint | **PASS** | TypeScript, Vite/Nitro production build, lint 0 errors |
| Production dependencies | **PASS** | npm audit --omit=dev reports 0 vulnerabilities |
| Dev + built browser render | **PASS** | Desktop and 390×844 mobile; no overflow or error heading |
| Pre-deploy backup | **PASS** | Verified checksummed DB, media, MinIO, configuration and Git metadata backup |
| Production deployment | **PASS** | External health and readiness return 0.9.0-rc2, schema 4 and exact commit d1811e6; DB/Redis/object media/worker ready |
| Anonymous admin boundary | **PASS** | External /api/admin/session returns HTTP 401 and no Set-Cookie |
| Account add persistence | **PASS** | Public insecure HTTP UI add → refresh → delete → refresh passed without randomUUID; console errors 0; test record removed |
| Live Chat | **PARTIAL** | Real non-stream and SSE marker requests succeeded; one earlier request ended RESULT_UNCERTAIN; 200-request matrix not run |
| Live image | **PARTIAL** | Leonardo text-to-image produced a real 1024×1024 upstream result and the reused-card recovery was live-verified; a separate image-to-image request completed end to end with HTTP 200, one returned image and actual 1024×1024 dimensions. Full model/aspect/count matrices remain open. |

## Required 30 answers

1. **接手时 HEAD — PASS.**
   b30a9f7d52653344d8512f5479b8f882c88500d0.

2. **最终 HEAD — PASS.**
   Final implementation HEAD is
   d1811e62cfbabd360a542ea93a1cd29d85277df0. The final report commit is
   documentation-only and follows this implementation HEAD.

3. **本次 commits — PASS.**
   6dc58a7, 5e2bb60, d0ba670, c429950, 1ff9844, 06cca41,
   ac0ae39, 71fd1f1, 68e60ed, 1035633, 47be2f3, 9e4fc8b,
   d9ccd60, 1e1c207, 9860071, 7206861, e286563, 9969bfa,
   63c7708, 635f909, c46eb82, 68bb245, 4d4041a, 9a6776d,
   7566ddb, aa3f74a, 2425cb4, e01bf54, d49a371, 0adce26 and
   186ace9, 8b9ef5e, 307d83e and d1811e6.

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
    full paid crash/recovery campaign was not run. Later pre-submit image-to-
    image failures remained PREPARING/SAFE, and only the final corrected run
    clicked Generate and returned one result.

13. **Reference exact count — PARTIAL.**
    Exact 1/2/4/6 attachment and hash exclusion pass locally for Gemini and
    Leonardo. One live Leonardo image-to-image request attached exactly one
    deduplicated PNG reference and completed; the 2/4/6 live matrix remains.

14. **GenerationBoundary — PARTIAL.**
    Request/attempt/time, prior container/URL/hash state, scoped new results,
    confidence and reference/history exclusion are implemented and tested.
    A live reused-card regression selected the real 1024×1024 text-to-image
    result as HIGH confidence, and the image-to-image request returned a
    validated 1024×1024 result. The full matrix remains incomplete.

15. **false-positive image — PARTIAL.**
    Production only accepts HIGH/VERIFIED correlated results. The live
    uncertain attempt returned zero images instead of a false success. The
    corrected live paths selected the prompt-correlated result card and
    rejected the attached reference; the full live matrix remains incomplete.

16. **requested n / actual n — PARTIAL.**
    Count mismatch fails closed and unsupported provider counts are rejected.
    A live image-to-image request asked for one and returned exactly one. The
    n>1 live count matrix remains open.

17. **requested size / actual size — PARTIAL.**
    Final image bytes are parsed and validated against aspect/tier/native size.
    Live testing found that a Python-embedded JavaScript newline was malformed
    and that unreadable dimensions could previously reach Generate. The
    embedded script is now runtime-compiled in tests, dimensions must equal the
    selected native size before submit, and unknown dimensions fail closed.
    Live image-to-image requests returned actual 1024×1024 and 16:9 Medium
    2752×1536, and the real text-to-image history result is 1024×1024. The
    9:16 and remaining matrix combinations remain unexecuted.

18. **Job 是否还保存大 Base64 — PASS.**
    References are frozen into MediaStore and workers return asset
    descriptors. The 1/5/15 MB tests prove Job JSON does not carry image
    base64.

19. **Gemini warm runtime — BLOCKED_BY_ENVIRONMENT.**
    WARM_IDLE reuse, cleanup and reference isolation pass locally. Production
    has no Gemini account.

20. **Leonardo warm runtime — PARTIAL.**
    The live session authenticated and selected Nano Banana 2. One real
    generation became uncertain after submit. Scoped prompt-container cleanup
    now proves WARM_IDLE live; live attach/cleanup passed, reused-card recovery
    selected the real result, and a later image-to-image request completed
    end to end. The multi-model/aspect/count matrix remains open.

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
    request ended RESULT_UNCERTAIN and exposed now-fixed defects. Leonardo
    text-to-image recovery and one real image-to-image 1024×1024 request now
    pass, but required model/reference/aspect/count matrices were not completed.

26. **最长实际 soak — PARTIAL.**
    Longest automated scheduler run was 120,415 ms and the Chromium lifecycle
    campaign completed 500 jobs. The required one-hour live-provider soak was
    not executed.

27. **当前已验证账号数 — PARTIAL.**
    Production has two healthy accounts: one ChatGPT and one Leonardo. ChatGPT
    completed real requests. Leonardo authenticated and returned a validated
    1024×1024 image-to-image result. Gemini has zero accounts.

28. **当前已验证并发 — PARTIAL.**
    Local Chromium concurrency 4; distributed unique leases 7; same-account
    maximum 1. Production Worker capacity is 2, but live multi-account maximum
    was not measured under load.

29. **所有 NOT_EXECUTED — PASS.**
    No known locally automatable high-priority code gate remains. Still
    **BLOCKED_BY_ENVIRONMENT**: 200 mixed live Chat requests; Gemini and both
    Leonardo model image matrices; five-account live concurrency; live
    proxy/session/DOM/crash injections at matrix scale; and one-hour live soak.
    The single post-fix Leonardo 1024×1024 image-to-image case passes; its full
    output-size matrix is not executed.

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
  d1811e62cfbabd360a542ea93a1cd29d85277df0 with no blockers.
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
- **PASS:** live Leonardo prompt-container cleanup reaches WARM_IDLE; the real
  reused-card result is selected HIGH at 1024×1024, and one image-to-image
  request returned HTTP 200 with one 1024×1024 image.
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
6. The downloadable Leonardo login helper recreated tabs every two seconds
   whenever OAuth temporarily moved the Leonardo tab onto a Canva domain, and
   it also stole focus plus auto-clicked Canva SSO up to three times. Commit
   68bb245 limits tab creation to one startup call and makes the entire wait
   loop read-only: no repeat tabs, no automated SSO click, no cookie click and
   no bring-to-front. A generated production login pack was inspected with one
   startup call and zero auto-click/focus-steal calls. Commit 4d4041a also
   wipes only the package-owned chrome-login profile before each run, so stale
   Canva/Stripe tabs from an aborted attempt cannot be restored.
7. Global Leonardo Remove buttons and history thumbnails were counted as active
   prompt references, so an empty page could never become WARM_IDLE. Commit
   7566ddb scopes reference count/removal to the prompt container. A live empty,
   attach and cleanup diagnostic then reached WARM_IDLE → DIRTY → WARM_IDLE.
8. Leonardo can reuse an existing result-card container. The real generated
   1024×1024 image was present in history but the old confidence gate ignored
   its new URL. Commit 2425cb4 correlates the image alt text and result actions;
   the live page now selects that card as HIGH while lazy history remains low.
9. The API tester sent the first reference through both `image` and `images`,
   and frozen remote references were downloaded as `.bin`. Commits e01bf54 and
   d49a371 deduplicate by URL/hash and preserve PNG/JPEG/WebP extensions. A real
   image-to-image request then attached one reference and returned one
   1024×1024 image with HTTP 200.
10. The administrator console previously exposed only an inline token field.
    Commits 0adce26 and 186ace9 add a standalone `/login` page, scrypt password
    verification, per-client failure limits, an HttpOnly management cookie and
    a fail-closed pre-render session gate. Production verification proved page
    200, wrong-password 401 with no cookie, correct-password 200, protected
    account-pool 200 and exact release identity. The plaintext password is not
    stored in Git or the server environment.
11. After username/password login, several pages still sent an empty
    `Authorization: Bearer` value. That malformed header shadowed the valid
    administrator cookie; the logs page converted the resulting 401 into an
    empty table, making retained records look deleted. Commit 8b9ef5e omits
    empty authorization headers, treats an empty Bearer scheme as absent and
    keeps prior rows visible on fetch failure. Production returned 129 retained
    usage rows with HTTP 200 after the fix.
12. Uploading an image reference could silently move the Leonardo composer
    away from Nano Banana 2, leaving the old Nano Banana 1344×768 dimensions
    while a 16:9 Medium request required 2752×1536. Commits 307d83e and
    d1811e6 restore the exact model after attachment using the live drawer's
    stable `data-testid="nano-banana-2"`, recheck the reference count, and only
    then reapply dimensions. A real request returned HTTP 200, one image and
    actual 2752×1536; the account returned to healthy/WARM_IDLE.

## Remaining live blocker

The Leonardo WARM_IDLE, result recovery and single-reference image-to-image
blockers are closed. Remaining blockers are coverage and environment scale:
there is no Gemini account, only one Leonardo account, and the full
model/aspect/count/reference matrices, 200-request Chat campaign, five-account
concurrency run and one-hour live soak have not been completed.

The correct final decision is therefore **PARTIAL**: the deployed candidate has
no known open P0 and all locally automatable high-priority gaps are closed, but
the explicitly required large live campaigns remain blocked by account count,
provider availability and long observation time.
