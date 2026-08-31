# Changelog

## 0.10.0-rc25 — designated tenant ownership (2026-08-31)

- One composite-FK ownership row designates the active Owner membership for
  every tenant; migration demotes additional legacy Owners.
- Database triggers reject direct designated-Owner demotion/disable/delete and
  conflicting Owner insert/update.
- Owner role can no longer be granted by ordinary invite/role mutation.
- MFA-enabled active target receives ownership through one serialized database
  function; source becomes Admin and concurrent transfers have one winner.
- Commercial monitor raises critical evidence for a missing/invalid Owner chain.

## 0.10.0-rc24 — multi-tenant session switching (2026-08-31)

- Authenticated users can list only their active tenant memberships and roles.
- Shared SaaS Shell shows a selector for multi-tenant users, including
  suspended memberships for restricted rights/security access.
- Switch atomically revokes the source session and creates a random target
  session; invalid targets leave the current session intact and concurrent
  switches have one winner.
- Original MFA timestamp is copied exactly, preventing tenant switching from
  extending privileged step-up; target legal status is recomputed.

## 0.10.0-rc23 — authenticated password change (2026-08-31)

- Customer security center verifies the current password and fresh MFA (when
  enabled) before changing credentials.
- Distributed per-user rate limit fails closed when coordination is unavailable.
- Exact old-hash compare-and-swap prevents two concurrent changes from both
  succeeding; current-password reuse is rejected.
- Success clears pending MFA, preserves the current session and revokes every
  other user session with a bounded audit reason.

## 0.10.0-rc22 — staged MFA replacement (2026-08-31)

- TOTP candidates are encrypted separately with a ten-minute expiry; starting
  replacement never disables the active factor or recovery codes.
- Existing-factor replacement requires a recent MFA session at both start and
  confirmation.
- Confirmation atomically promotes the candidate, rotates recovery hashes,
  refreshes the current proof and revokes all other sessions.
- Wrong/expired/abandoned candidates keep the old factor active; retention,
  password reset and tenant closure clear expired/pending Secrets.

## 0.10.0-rc21 — customer session security (2026-08-31)

- Personal device/session inventory with IP, bounded User-Agent, current-device
  marker, activity, expiry, MFA and revocation metadata—never token/CSRF hashes.
- User-scoped single-device and all-other-device revocation with durable reason
  and tenant audit evidence.
- MFA recovery-code rotation replaces the hash set, displays new codes once and
  revokes every other active session.
- Independent security center remains reachable during legal re-consent and
  tenant suspension while ordinary SaaS APIs remain denied.
- Privacy export now includes non-secret session metadata required for data
  portability.

## 0.10.0-rc20 — tenant privacy rights (2026-08-31)

- Owner-only, tenant-scoped JSON export with exact response SHA-256 and no
  retained duplicate archive.
- Password/session/API-key hashes, MFA material, provider secrets, network
  HMACs and encrypted upstream results are excluded from exports.
- Configurable 1–30 day tenant-closure cooling-off period with cancellation,
  financial/dispute blockers and hourly Scheduler execution.
- Closure revokes keys/sessions, disables memberships, scrubs transient PII and
  pseudonymizes only users without another active tenant; immutable financial,
  legal and security evidence remains retained.
- Privacy request identity cannot be deleted and event history is append-only;
  overdue/blocked closures generate commercial alerts.
- Privacy and MFA enrollment remain reachable without accepting a newer legal
  bundle and for suspended tenants, while all ordinary service APIs stay
  denied.

## Leonardo Image Generator (2026-08-26)

- Third provider `leonardo` with logical models `leonardo-gpt-image-2` and `leonardo-gemini`.
- Default backend `web_account`. Official API adapter exists but is not production.
- Scheduler skips TOKEN_EXHAUSTED and known-missing models. DOM faults trip the Leonardo circuit.
- Recon: public home selectors only; logged-in generation **BLOCKED_NO_SESSION**.

# Changelog

## Production Resilience Campaign (2026-08-25)

- Fail-closed: `RELAY_SECRETS_KEY`, `provider_config`, `bootProductionGuard` on chat + `/internal/readiness` (admin).
- Postgres row-level claim/finish (`UPDATE … WHERE status='queued'`, fencing token in SQL). JSON is not a scheduling SoT.
- Redis compare-and-renew (`EVAL` PEXPIRE). `REDIS_URL` set ⇒ no memory fallback (`RELAY_REQUIRE_REDIS`).
- Two Gateway OS processes + shared SQL + Redis: chaos harness **18/18 PASS**.
- Reliability 3 min: **1504/1504**, lost=0, duplicate_execution=0. 1h not completed in this turn.
- Reports: `NIGHTLY_RESILIENCE_REPORT.md`, `DISTRIBUTED_CORRECTNESS.md`, `CHAOS_TEST_MATRIX.md`, `CHAOS_TEST_REPORT.md`, `RESTART_RECOVERY.md`, `RELIABILITY_METRICS.md`.

## Production semantics (this pass)

- Production fail-closed: DATABASE_URL, REDIS_URL, admin/worker secrets, object media, mock-mode forbidden. `GET /api/ready`.
- PostgreSQL is the only production Source of Truth for scheduling. JSON limited to import/fixture/dev bootstrap.
- Redis atomic job claim, lease compare-and-del, fencing `INCR`, idempotency `SET NX`. Dual-process tests against a RESP server.
- Request is a first-class entity; failover creates Attempts, not a new client Request.
- Formal failure matrix. PROVIDER_DOM_CHANGED trips the provider circuit and does not walk the account pool.
- ChatGPT/Gemini circuit breaker + canary accounts.
- MediaStore: Local (dev) vs S3-compatible object store (production).
- SSE disconnect/cancel/timeout/usage/backpressure. Chaos suite + 8s soak recorded. 1h+ soak not run.

## Commercial hardening

- Isolated admin / customer / worker credentials. Runtime no longer returns secrets.
- Job leases, fencing tokens, idempotency, dead-letter, `maxRetry`.
- Same-request account failover. Cooling expires into probing then healthy.
- Gemini: no SVG fake-success; images persisted under `/api/media`.
- ChatGPT: job-bound proxy, exit-IP probe, model switch assert, session_version.
- `/v1/responses`, multipart `/v1/images/edits`, unsupported-parameter 400s, non-zero token usage.
- Server worker daemon in `startup.sh` using `wk-relay-` token.
