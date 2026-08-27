# Codex Final Acceptance — relay-web-api `0.9.0-rc2`

Date: 2026-08-28

Overall status: **PARTIAL**

Takeover implementation base: `b30a9f7d52653344d8512f5479b8f882c88500d0`

Final implementation HEAD: `d9ccd60192759f4e6628bd2687cef3fed9761f0d`

The local acceptance candidate has no known locally reproducible P0. It is not
the code currently serving production: the GitHub repository grants the
connected identity pull-only permission, SSH ports 246/22 are unreachable, and
the public origin still reports `0.9.0-rc1`.

## Current evidence

| Gate | Status | Evidence |
|---|---|---|
| Relay unit/integration | **PASS** | 212/212 |
| Core/template contract | **PASS** | 101/101 |
| Multi-process/operations contract | **PASS** | 21/21 |
| Two-gateway chaos | **PASS** | 18/18; no stale lease accepted, restart recovery passed |
| Scheduler reliability | **PASS** | 120,415 ms; 228/228; lost 0; duplicate execution 0; five gateway restarts |
| Local Chromium leak | **PASS** | 500/500; four-way; final browsers/contexts/queues 0; post-warmup RSS +5,021,696 bytes |
| Typecheck / build | **PASS** | `tsc --noEmit`; Vite/Nitro production build |
| Lint | **PASS** | 0 errors; 16 non-blocking warnings remain |
| Production dependencies | **PASS** | official `npm audit --omit=dev`: 0 vulnerabilities |
| Dev + built browser render | **PASS** | desktop + 390×844; visible content; no horizontal overflow; console errors/warnings 0 |
| Live server infrastructure | **PARTIAL** | HTTP `readyz` reports Postgres/Redis/object media ready and one live worker; deployed code is old |

## Required 30 answers

1. **接手时 HEAD — PASS.**
   `b30a9f7d52653344d8512f5479b8f882c88500d0`.

2. **最终 HEAD — PASS.**
   Final implementation HEAD is
   `d9ccd60192759f4e6628bd2687cef3fed9761f0d`. The commit containing this
   report is documentation-only and follows that implementation HEAD.

3. **本次 commits — PASS.**
   `6dc58a7`, `5e2bb60`, `d0ba670`, `c429950`, `1ff9844`, `06cca41`,
   `ac0ae39`, `71fd1f1`, `68e60ed`, `1035633`, `47be2f3`, `9e4fc8b`,
   `d9ccd60` (13 commits).

4. **还存在什么 P0 — FAIL.**
   The local candidate has no known P0, but production still serves
   `0.9.0-rc1`; anonymous `GET /api/admin/session` returned HTTP 200 with a
   `Set-Cookie` header on 2026-08-28. This remains a live P0 until `5e2bb60`
   and the later commits are deployed. The server credential supplied in chat
   and the Shadowsocks credential found in Git history must also be rotated.

5. **Chat completion 是否还会提前截断 — PARTIAL.**
   The detector now requires confirmed completion, reopens if the DOM grows,
   distinguishes partial/final text, and passes pause/no-Stop/Stop lifecycle
   tests. No 200-request live Chat campaign was available to prove the live
   error count is zero.

6. **SSE HTTP 200/业务状态是否彻底分离 — PASS.**
   Transport and logical status are separate; partial+error, partial+done,
   cancellation, timeout, history and UI consistency tests pass.

7. **多账号实际最大并发 — PARTIAL.**
   Locally verified: four concurrent real Chromium lifecycles, seven unique
   simultaneous account leases in two-gateway chaos, and distinct-account
   Playwright shards in parallel. Live provider-account maximum is not known.

8. **同账号实际最大并发 — PARTIAL.**
   Worker shard/account-lock and distributed lease tests prove a local maximum
   of 1. A real provider session campaign has not measured it externally.

9. **Proxy drift — PARTIAL.**
   Proxy identity/credential fingerprints key browser pools; warmup and job
   execution use the account-bound proxy and fail closed. Live drift counter
   has not been measured.

10. **cross-request chunk — PARTIAL.**
    JobRuntimeContext and chunk fencing/isolation tests pass. The live counter
    has not been measured.

11. **duplicate submit — PARTIAL.**
    Idempotency 20/50-way storms, fencing and crash recovery pass with no
    duplicate execution. Live provider submit count has not been measured.

12. **duplicate paid image generation — PARTIAL.**
    Submitted/unknown/unsafe attempts are never blindly requeued or failed over;
    same-page/result recovery is required. No paid live crash campaign ran.

13. **Reference exact count — PARTIAL.**
    Exact 1/2/4/6 attachment and hash-exclusion tests pass for Gemini and
    Leonardo paths. Live reference matrices did not run.

14. **GenerationBoundary — PARTIAL.**
    Request/attempt/time, prior containers/URLs/hashes, new scoped containers,
    confidence and historical/reference exclusion are implemented and tested.
    Live DOM correlation did not run.

15. **false-positive image — PARTIAL.**
    Only HIGH/VERIFIED correlated results pass production validation; UI,
    historical and reference assets are rejected. Live false-positive count is
    not measured.

16. **requested n / actual n — PARTIAL.**
    Result count mismatch fails closed in contract tests; provider capability
    limits reject unsupported counts. Live matrices did not run.

17. **requested size / actual size — PARTIAL.**
    Final PNG/JPEG/WebP bytes are parsed with bounded code and compared to the
    requested aspect/tier/native size. Live 1:1/16:9/9:16 matrices did not run.

18. **Job 是否还保存大 Base64 — PASS.**
    Input references are frozen into MediaStore and workers return asset
    descriptors; 1/5/15 MB tests prove Job JSON does not carry image base64.

19. **Gemini warm runtime — PARTIAL.**
    WARM_IDLE reuse, cleanup and reference-state isolation are tested; no live
    Gemini session was available.

20. **Leonardo warm runtime — PARTIAL.**
    WARM_IDLE reuse, exact reference attach and cleanup are tested; no live
    Leonardo session was available.

21. **Model truth — PARTIAL.**
    `requested_model`, `actual_model`, verification/profile fields are distinct;
    `chatgpt-web-auto` never invents an exact model and exact IDs fail closed
    without exact UI evidence. Live false-confirmation count is not measured.

22. **Canary 自动运行 — PARTIAL.**
    Distributed scheduler leases, jittered structural canaries and separate
    low-frequency paid image canaries are wired and tested. They have not run
    on the new candidate in production.

23. **Selector promote/rollback — PASS.**
    Candidate state is distributed; three consecutive passes promote; failure
    rolls back; finish-path fingerprints drive the state.

24. **200 Chat 是否真实完成 — BLOCKED_BY_ENVIRONMENT.**
    No usable authenticated ChatGPT session/account set was available.

25. **Image matrices 是否真实完成 — BLOCKED_BY_ENVIRONMENT.**
    Gemini and both Leonardo model matrices require authenticated accounts and
    paid live generations; none was executed.

26. **最长实际 soak — PARTIAL.**
    Longest scheduler reliability run was 120,415 ms; the separate 500-browser
    lifecycle run completed 500 jobs. A one-hour live-provider soak was not
    executed.

27. **当前已验证账号数 — BLOCKED_BY_ENVIRONMENT.**
    Real provider accounts verified on this candidate: 0. Synthetic/local
    account pools were used only for correctness tests.

28. **当前已验证并发 — PARTIAL.**
    Local real Chromium lifecycle: 4; distributed unique leases: 7; same account:
    1. Live provider concurrency: 0 measured.

29. **所有 NOT_EXECUTED — PASS.**
    No locally automatable gate remains unexecuted. The following are
    **BLOCKED_BY_ENVIRONMENT**: 200 live Chat; all Gemini/Leonardo image
    matrices; five-account live concurrency; live post-submit crash, proxy-down,
    session-expiry, DOM-change, stale-result and disconnect injections; one-hour
    live soak; real Postgres `pg_dump`→`pg_restore`; remote CI for these commits;
    and deployment of this candidate.

30. **是否建议进入正式部署测试 — PARTIAL.**
    Yes for a controlled staging/maintenance-window deployment test after
    rotating exposed credentials and establishing a writable GitHub/SSH path.
    No for unrestricted production traffic until the new commit is deployed,
    anonymous admin Cookie issuance is confirmed absent, live provider matrices
    pass, and the one-hour live soak completes.

## Hard correctness counters

The local synthetic campaigns observed zero `lost_request`, `double_lease`,
stale-result acceptance and duplicate execution in their covered workloads.
The production/live-provider values below are not inferred from those tests:

| Counter | Status |
|---|---|
| `proxy_drift` | **BLOCKED_BY_ENVIRONMENT** |
| `cross_request_chunk` | **BLOCKED_BY_ENVIRONMENT** |
| `duplicate_submit` | **BLOCKED_BY_ENVIRONMENT** |
| `duplicate_paid_generation` | **BLOCKED_BY_ENVIRONMENT** |
| `partial_truncation` | **BLOCKED_BY_ENVIRONMENT** |
| `historical_image_returned` | **BLOCKED_BY_ENVIRONMENT** |
| `reference_image_returned` | **BLOCKED_BY_ENVIRONMENT** |
| `ui_image_returned` | **BLOCKED_BY_ENVIRONMENT** |
| `reference_missed` | **BLOCKED_BY_ENVIRONMENT** |
| `wrong_result_count` | **BLOCKED_BY_ENVIRONMENT** |
| `wrong_size` | **BLOCKED_BY_ENVIRONMENT** |
| `stale_result_accepted` | **BLOCKED_BY_ENVIRONMENT** |
| `model_false_confirmation` | **BLOCKED_BY_ENVIRONMENT** |
| `lost_request` | **BLOCKED_BY_ENVIRONMENT** |
| `double_lease` | **BLOCKED_BY_ENVIRONMENT** |

## External state at report time

- **FAIL:** production `0.9.0-rc1` still issues an anonymous admin Cookie.
- **BLOCKED_BY_ENVIRONMENT:** TCP 246/22 and direct 8088 are unreachable;
  HTTP 80/HTTPS 443 accept connections.
- **PARTIAL:** public `/readyz` is HTTP 200 with schema 4, Postgres, Redis,
  object media and one online worker, but it cannot identify its Git commit.
- **BLOCKED_BY_ENVIRONMENT:** connected GitHub user `leilei6878` has
  `pull=true`, `push=false` on `leilei6878-spec/relay-web-api`; the final
  implementation is 13 commits ahead of `origin/main` (plus this report-only
  documentation commit).
