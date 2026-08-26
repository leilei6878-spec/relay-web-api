# Final Code Audit

Source of truth: GitHub `main` at baseline `2c75aaf` plus the delivery commits on top of it.

Status vocabulary: **VERIFIED** | **PARTIAL** | **BLOCKER** | **NOT_TESTED**

## Security

| Item | Status | Evidence |
|---|---|---|
| Admin / Customer / Worker credentials isolated | VERIFIED | `src/lib/authz.ts` classify(); `scripts/qa-api-compat.test.mjs` customer key cannot poll worker |
| `/api/runtime` does not leak secrets | VERIFIED | Returns workers/queue/production readiness only; test "runtime does not leak secrets" |
| Customer API key has no Worker permission | VERIFIED | `assertWorker` requires `wk-relay-` |
| Browser does not receive production customer key | VERIFIED | Settings shows hint; new key once; `/api/runtime` has no key |
| Session encrypted at rest | PARTIAL | AES-256-GCM when `RELAY_SECRETS_KEY` set; production fail-closed without it. Preview may store plaintext. |
| Proxy password only in Secret Store | VERIFIED | `writeControlPlane` strips password; `publicProxy` |
| Admin endpoints authenticated | VERIFIED | `/api/admin/*`, `/internal/readiness` use `assertAdmin` |
| Worker endpoints dedicated auth | VERIFIED | `/api/worker/next|result|chunk|control` use `assertWorker` |
| CORS | PARTIAL | Public `/v1/*` uses `Access-Control-Allow-Origin: *` (Bearer, no cookies). Admin cookie is SameSite=Lax, not CORS-exposed. |
| Sensitive logs redacted | PARTIAL | `publicProxy` redacts password. No structured log redaction middleware. |
| Hardcoded SS share-link | VERIFIED (HEAD) | Removed in `2c75aaf`. **History still contains it** — rotate. |

No Security **BLOCKER** in HEAD.

## Jobs

| Item | Status | Evidence |
|---|---|---|
| request_id / attempt_id / lease_id / fencing_token | VERIFIED | `job-queue.ts`, `requests.ts`, chaos tests |
| idempotency | VERIFIED | same key ×20 → 1 job |
| stale result rejection | VERIFIED | chaos 2+14 |
| retry / dead letter / cancel / timeout | VERIFIED | reclaim, cancelJob, timeout_ms |
| automatic failover | VERIFIED | `decide()` + exclude failed account |

## Account

| Item | Status | Evidence |
|---|---|---|
| lifecycle healthy/cooling/probing/invalid/banned | VERIFIED | eligibility + control-plane |
| session expired → invalid | VERIFIED | chaos 12 |
| per-account concurrency = 1 | VERIFIED | concurrency.test.ts; claim lock |
| cooling recovery | PARTIAL | code path exists; live recovery **NOT_TESTED** against ChatGPT |

## Provider

| Item | Status | Evidence |
|---|---|---|
| ChatGPT account-bound proxy | VERIFIED | claim payload uses bound proxy, not `pick_proxy` |
| Gemini fail-closed / no fake success | VERIFIED | worker-script.test.ts; image-guard |
| model verification | VERIFIED | unit tests for UI label; live switch **NOT_TESTED** |
| session_version CAS | VERIFIED | session-cas.ts tests |
| page_state machine | VERIFIED | AUTHENTICATED…DOM_UNKNOWN in page-state.ts |
| selector packs chatgpt-v1 / gemini-v1 | VERIFIED | selectors.ts tests |

## Persistence / production

| Item | Status | Evidence |
|---|---|---|
| Production fail-closed | VERIFIED | production-guard.test.ts child process |
| PostgreSQL unique SoT in production | VERIFIED | persist-mode.ts; jsonAllowedFor("scheduling") false |
| Redis atomic SET NX / EVAL | VERIFIED | multi-process-lease + coord-redis tests (fake RESP) |
| Packaged Redis + two gateway containers | NOT_TESTED | no Docker in this workspace |
| Object media in production | PARTIAL | ObjectMediaStore SigV4 unit test; live S3 PUT NOT_TESTED |
| Local disk media in production | VERIFIED forbidden | production-guard media_store required |

## Delivery (this campaign)

| Item | Status | Evidence |
|---|---|---|
| `.env.example` | VERIFIED | no real secrets |
| JSON→PG dry-run | VERIFIED | migrate-json.test.mjs |
| Backup/restore round-trip | VERIFIED | backup-restore.test.mjs against two PGlite instances + schema_version=4 |
| `/healthz` `/readyz` `/metrics` | VERIFIED (code) | routes added; live HTTP checked after preview start |
| OpenAPI public-only | VERIFIED | openapi-contract.test.mjs |
| GitHub Actions CI | VERIFIED (file) | workflow present; first Actions run is NOT_TESTED until push |
| Docker compose up | NOT_TESTED | files present; daemon not in workspace |
