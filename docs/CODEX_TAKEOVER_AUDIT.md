# Codex Takeover Audit

Date: 2026-08-27  
Audited HEAD: `b30a9f7d52653344d8512f5479b8f882c88500d0` (`main`)  
Status vocabulary: `VERIFIED` | `PARTIAL` | `BROKEN` | `NOT_TESTED` | `MISSING` | `OBSOLETE_DOC`

This audit treats the current repository, current `main`, Git history, `docs/`,
and tests as the only facts. It does not promote code existence or old reports
to live-provider evidence.

## Audit boundary

The required takeover sources were read before this document was created:

- `README.md`, `AGENTS.md`
- `docs/WEB_RUNTIME_V2_BASELINE.md`, `docs/WEB_RUNTIME_V2_ACCEPTANCE.md`
- `docs/COMMERCIAL_READINESS_AUDIT.md`, `docs/PROVIDER_RELIABILITY_REPORT.md`
- `docs/CHATGPT_LATENCY_FINAL.md`, `docs/CHATGPT_STREAMING.md`
- `docs/FAILURE_MATRIX.md`, `docs/PROVIDER_CIRCUIT_BREAKER.md`, `docs/SOAK_TEST_REPORT.md`
- both worker sources, the queue/lease/coord/fault/circuit implementation, all
  provider modules, public Chat/Image/Responses routes, all Worker routes, and
  the Console
- the latest 20 commits (the target required at least 15)

The generated Python returned by `localWorkerScript()` and
`workers/relay-worker.py` are byte-for-byte equal after newline normalization
at this audit (`f3cb83f4…f85a745`).

The worktree was not clean when this audit began. Eight files already contained
an uncommitted emergency admin-session fix and `.npm-cache/` was untracked. Those
changes are **not** part of audited HEAD. In particular, HEAD still has the
public admin auto-login issue described below; the working-tree fix will be
reviewed and tested after this Step-0 audit.

## Executive result

| Area | Status | Current evidence |
|---|---|---|
| Current GitHub CI | **BROKEN** | Actions run `33056867932` for HEAD failed at `npm run typecheck`; all later tests/build were skipped. |
| Production admin boundary | **BROKEN** | HEAD auto-issues an admin cookie when `RELAY_REQUIRE_ADMIN_LOGIN != 1`; production Compose defaults it to `0`. The current public site was observed returning `200`, `auto:true`, and `Set-Cookie` to an unauthenticated request. |
| Chat completion detector | **PARTIAL** | State machine, Stop-cycle/fallback stability, DOM final reread, semantic/network signals, and uncertainty path exist with unit tests. Live n≥30 and 200-mixed gates are not run. |
| SSE transport vs logical status | **PARTIAL** | Console parser/history distinguish HTTP 200 from logical success and preserve partial-on-error. `/v1/responses` streaming reuses this path. Live disconnect/recovery campaign is not run. |
| Model truth / advertised models | **BROKEN** | Version evidence is required, but the worker routes every non-thinking exact model through Instant/Auto and the gateway rejects the unconfirmed/mismatched result. Several advertised IDs are not operational as advertised. |
| Chat vision attachment | **BROKEN** | `attach_images()` does not return/verify exact attachment count; failed downloads/selectors can still submit text and return a false text-only vision success. |
| Account↔Proxy fail-closed | **PARTIAL** | Worker refuses missing/down assigned proxy in production and verifies proxy id/server. Live Proxy-A-down gate is not run. |
| Browser proxy identity | **BROKEN** | Browser pooling is keyed only by proxy server. Different sticky credentials on the same host:port can reuse the wrong browser/proxy identity. |
| Session/shard/request isolation | **PARTIAL** | Per-account locks, stable account→shard mapping, JobRuntimeContext, fenced chunks/results and session CAS exist. Real multi-account concurrency is not run. |
| Same-account serial execution | **PARTIAL** | Redis/SQL account lease plus worker `ACCOUNT_LOCKS` enforce one active job in code/tests. Live maximum is unmeasured. |
| Post-submit duplicate prevention | **BROKEN** | API failover consults `retrySafety`, but stale-worker reclaim and cancellation can requeue running jobs without consulting `submissionState`/`retrySafety`; a submitted paid generation can execute again. |
| PostgreSQL healthy-job reclaim | **BROKEN** | Every claim reclaims running jobs older than the dead/grace threshold without checking the owner's fresh heartbeat or job timeout; a healthy >60s generation can be reclaimed. |
| Worker result safety metadata | **BROKEN** | Worker sends retry/submission metadata, but `/api/worker/result` drops it before `finishJob`, so persisted state cannot reliably drive safe recovery. |
| GenerationBoundary/result confidence | **PARTIAL** | Baseline containers/assets and HIGH/VERIFIED filtering exist; 100 synthetic permutations pass. Live DOM/provider proof is absent. |
| Exact references/hash exclusion | **PARTIAL** | Attach count must equal request count before submit; result bytes are compared to reference SHA-256. Live 1/2/4/6-ref matrices are not run. |
| Unified image validation | **PARTIAL** | Gateway validates PNG/JPEG/WebP magic, MIME, bytes, dimensions, size, count, reference/history hashes, and confidence. Worker candidates do not consistently propagate confidence/history hashes into this validator. |
| Size/count truth | **PARTIAL** | `n` above web capability is rejected and gateway requires exact result count; requested vs actual dimensions are stored. Live 1:1/16:9/9:16 evidence is absent. |
| Worker media pipeline | **BROKEN** | Output data URLs use fenced media upload, but input reference data URLs are still stored directly in job/PG JSON and claims. Asset-only transport is not end-to-end. |
| Gemini/Leonardo warm runtime | **BROKEN** | Reuse/cleanup exists, but readiness can proceed while still DIRTY; composer emptiness is not part of WARM_IDLE and cleanup errors are swallowed. |
| Circuit breaker | **PARTIAL** | Unique-account provider faults trip Redis-backed state; canary success closes it. Live provider circuit behavior is not run. |
| Automatic structural canary | **PARTIAL** | Scheduler is started through production boot and enqueues structural canaries. The result route does not call `applyWorkerCanary`, so fingerprint/probe processing is not wired end-to-end. |
| Paid real-image canary | **BROKEN** | The scheduler records paid due items as successful `skipped` records and never enqueues a paid image job. A configurable low-frequency real canary therefore does not exist operationally. |
| Selector candidate promote/rollback | **BROKEN** | `selector-promotion.ts` passes isolated unit tests, but no production code imports or calls its candidate/result functions. State is also process-local rather than shared/persistent. |
| Backpressure | **PARTIAL** | JSON path has only one global depth cap; Postgres `enqueuePg` has no corresponding queue cap. Provider/capability/API-key limits and `Retry-After` are missing. |
| Chaos/leak/soak/live matrices | **NOT_TESTED** | Old in-process chaos and short reliability data exist, but target live-provider chaos, 500-job leak, image matrices, 200 Chat, and ≥1h soak were not executed. |

## Chat reliability

### Assistant completion

**PARTIAL.** `AssistantCompletionDetector` implements the required states
`WAITING_FIRST_DELTA`, `STREAMING`, `POSSIBLY_COMPLETE`,
`CONFIRMED_COMPLETE`, and `RESULT_UNCERTAIN`. It observes assistant DOM
mutations, Stop seen/disappeared, semantic completion controls, provider
request/response completion, a stable window plus confirmation window, and a
final DOM reread. Partial text at a deadline returns `RESULT_UNCERTAIN`, not a
successful final result.

The evidence is still unit/synthetic only. The old 350 ms shortcut is gone, but
pre-submit provider traffic can set an uncorrelated `network_finished` flag and
shorten the stable window. A DOM growth found after `CONFIRMED_COMPLETE` also
does not reopen the detector for a new confirmation window. The requested live
30-run fixed prompt and 200 mixed Chat campaign are
**NOT_TESTED**. Therefore no claim that premature truncation is zero is valid.

### SSE status consistency

**PARTIAL.** `sse-client.ts` exposes transport status separately from logical
status, marks partial-without-done as uncertain, and makes history success
depend on logical success. The API sends a final `finish_reason=stop` only after
the persisted job is terminal `done`. The Console shows `SSE HTTP` separately
and preserves partial output on failure.

Remaining automated concerns:

- the public SSE response is necessarily HTTP 200 after streaming starts, so
  every consumer must parse the terminal relay/error event; only the in-repo
  Console/parser is proven;
- `readSse` declares but ignores terminal `relay.partialText` and explicit
  `relay.logicalStatus`; contradictory terminal metadata can be inferred as
  success and an error-only terminal chunk can lose partial text;
- live disconnect, worker recovery, stale callbacks, and cross-request chunk
  behavior remain **NOT_TESTED**;
- current CI does not reach these tests because typecheck fails first.

### Model truth

**BROKEN.** The adapter refuses to verify `gpt-5.6` from product-only labels
(`ChatGPT`, `Instant`, `Auto`) and `finishJob`/`finishJobPg` fail an unconfirmed
model unless the explicit `RELAY_MODEL_UNCONFIRMED=allow` escape hatch is set.
Worker `select_model()` nevertheless funnels all non-thinking requested IDs
through Instant/Auto and reports product-only labels. Exact `gpt-5.6`, `gpt-5`,
and `gpt-4o` can therefore be advertised but rejected by the strict gate. The
capability list must be reduced or selection made request-specific. Live labels
and the `model_false_confirmation` counter remain **NOT_TESTED**.

### Vision attachments

**BROKEN.** Chat image materialization and attachment swallow failures and do
not return an exact attached count. `run_chat()` continues with the prompt and
can produce a successful text-only result. Chat vision needs the same exact
pre-submit attachment invariant as image edits.

## Image reliability

### Generation correlation and candidates

**PARTIAL.** The worker snapshots result containers and asset URLs before
submission and prefers images in new request-scoped containers. History,
reference, UI, and low-confidence candidates are rejected. Page-wide scanning
is only a fallback and cannot pass unless a new/domain-matching candidate earns
HIGH confidence. Synthetic permutations prove the scorer, not real provider
DOM behavior.

The boundary's `baseline_asset_hashes` is currently always empty, and HTTP
candidate bytes are not hashed until after selection. Thus same-bytes/different-
URL historical exclusion depends on the later gateway validator receiving a
historical hash set—which it currently does not. This remains **PARTIAL**.

### References, bytes, size, and count

**PARTIAL.** Both provider flows bind SHA-256 descriptors, require exact
attachment count before submission, and reject a result with a reference hash.
The gateway validator supports PNG/JPEG/WebP, reads dimensions, checks MIME and
magic, enforces exact `n`, and records requested/actual size/tier metadata.

However, worker-selected candidate confidence is not carried through
`/api/worker/result`, and `validateJobImageUrls` therefore defaults every loaded
asset to HIGH. Historical hashes are likewise not supplied. The worker still
provides the first boundary, but the claimed unified closed loop is not fully
end-to-end. Live matrices remain **NOT_TESTED**.

### Duplicate paid generation

**BROKEN.** `decideWithSafety` correctly blocks API-level account switching for
UNKNOWN/UNSAFE results. That invariant is bypassed by recovery infrastructure:

- file-mode `reclaim()` requeues timed-out/dead running jobs solely by attempt
  count;
- PostgreSQL `dbReclaimDeadJobs()` does the same;
- cancellation/requeue paths also do not gate on submission state.

PostgreSQL reclaim also ignores the live worker heartbeat: every claim can
requeue a healthy generation once `started_at` exceeds the default 60s
dead/grace threshold. Cancellation releases account locks before the terminal
SQL transition and its update is not lease/fence-matched.

A worker can click Generate, crash before posting the final result, then have
the same job claimed and submitted again. This directly violates
`duplicate_paid_generation = 0` and is the highest-priority runtime fix after
the admin boundary/CI blockers.

### Image transport and warm pages

**BROKEN.** Output data-URL results are uploaded as bytes under current lease/fence to
MediaStore, then the result contains stable URLs. Gateway validation and final
`b64_json` conversion happen at the API edge. Input references are still queued
and persisted as multi-MB data URLs. A legacy output fallback also remains, so
the architecture is not asset-id-only end-to-end.

Gemini and Leonardo attempt to reuse a pooled page and clean prompt/reference
state. Their readiness helpers can return success for DIRTY, callers do not
consistently enforce the ready flag, composer content is not classified, and
cleanup exceptions are swallowed. Request A with refs followed by request B
without refs is therefore **BROKEN** at the proof level.

## Concurrency, fencing, and recovery

**PARTIAL.** The queue acquires an account lease before enqueue; PostgreSQL also
locks the account row. Claims use Redis NX plus SQL queued→running, results and
chunks require the lease/fencing tuple, and the worker applies both a global
semaphore and a per-account mutex. Account IDs map deterministically to
Playwright shards. Session writes use a version CAS.

Browser pooling keys a browser by `proxy.server` alone. Proxy ID, username, and
credential identity are excluded, so accounts whose sticky proxies share a
host:port can reuse the wrong authenticated browser proxy. This specific proxy/
session isolation invariant is **BROKEN**.

The required real gates—five accounts, 20 simultaneous requests, at least two
overlapping Playwright jobs, and maximum one active job per account—are
**NOT_TESTED**. `provider/concurrency.test.ts` is a small simulation and cannot
prove browser concurrency.

## Self-healing and backpressure

**BROKEN** for the full target despite several verified components.

- Structural scheduler timing and circuit transitions exist.
- Worker fingerprints are returned but not routed through
  `applyWorkerCanary()`.
- Candidate selector promotion/rollback has no production caller and is
  process-local.
- Paid canary due ticks are deliberately skipped rather than run.
- Postgres enqueue does not enforce the file queue's global cap.
- There are no provider, capability, or per-key queue caps and no `Retry-After`
  response header.

Therefore “Provider 页面变化可自动发现和恢复” is not yet true.

## Build, test, and deployment facts

| Gate | Status | Evidence |
|---|---|---|
| GitHub Actions at audited HEAD | **BROKEN** | Run 61 failed on `chatgpt-runner.ts` union narrowing and `gateway.ts` server-function serialization. |
| Local typecheck | **BROKEN** | Same two HEAD errors; the uncommitted auth helper initially added one more and was corrected after the audit began. |
| Lint | **BROKEN** | Two errors plus warnings; CI currently marks lint `continue-on-error`. |
| Production build | **NOT_TESTED** | GitHub skipped it. A local Windows run hit `spawn vite ENOENT`; this is not evidence that the Linux production build itself fails. |
| Unit/contract/distributed suites at HEAD | **NOT_TESTED** | GitHub skipped them after typecheck. Historical results do not prove current HEAD. |
| Public runtime health | **PARTIAL** | `/healthz` and `/readyz` report `0.9.0-rc1`, schema 4, ready. `/api/runtime` showed one online worker. Health does not prove provider correctness. |
| Exact deployed commit | **MISSING** | Runtime exposes the static version only, not Git SHA/build time; HEAD is 61 commits beyond the `v0.9.0-rc1` tag. |
| GitHub→server CD | **MISSING** | Repository has CI only, no deploy workflow. GitHub connector is read-only (`push=false`). |
| Server shell access | **NOT_TESTED** | Supplied port 246 timed out; port 22 was also unreachable from this environment. No server mutation was attempted. |

## Security and operational blockers adjacent to the runtime target

1. **BROKEN — public admin auto-login.** This is actively observable on the
   current public site and must be remediated before any further deployment.
2. **BROKEN — recovery backup is not trustworthy.** Current backup scripts omit
   critical production session/secret assets and can report success after
   `pg_dump` failure; the documented real Postgres restore was not executed.
3. **PARTIAL — released identity.** Static `0.9.0-rc1` cannot identify the
   deployed SHA.
4. **PARTIAL — dependency/security gate.** Install reports one high-severity
   advisory; dependency audit is not a blocking CI gate.
5. **PARTIAL — credentials.** Any password posted in chat must be treated as
   exposed and rotated. It must never be committed or reused as a GitHub
   secret. Key-based, non-root deployment remains the recommended path.

## Prioritized implementation plan after Step 0

1. Close the public admin auto-login vulnerability and add production
   regression tests; preserve the development-only convenience explicitly.
2. Restore a green hard gate: fix the two existing type errors, make relevant
   test suites run, and obtain a production build result.
3. Make retry/reclaim submission-aware so UNKNOWN/UNSAFE work becomes terminal
   `RESULT_UNCERTAIN`, never requeued; cover file and PostgreSQL paths.
4. Close image validation propagation: carry confidence and historical hashes
   (or validated asset metadata) through Worker Media/Result and reject unknown
   provenance rather than defaulting it to HIGH.
5. Wire structural canary fingerprints and selector candidate outcomes through
   the real Worker result path; persist shared active/candidate state and add a
   real, separately throttled paid-image canary.
6. Add consistent Postgres/provider/capability/API-key backpressure with 429/503
   and `Retry-After`.
7. Run every locally available unit/typecheck/build/contract/concurrency/chaos/
   runtime/leak gate, fix, retest, and commit in small stages.
8. Record healthy-session/account/infrastructure limitations as
   `BLOCKED_BY_ENVIRONMENT`, then execute real Chat/Image/concurrency/chaos/soak
   only when those prerequisites genuinely exist.

## Current acceptance disposition

Production deployment certification is **BROKEN**. The repository contains
substantial, targeted reliability work that should be preserved, but current CI
is red, a public admin vulnerability is active, submitted image work can still
be requeued after a crash, and provider self-healing is only partially wired.
No live correctness counter can be claimed as zero from the present evidence.
