# Multi-tenant session switching dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc24`;
- schema: `24`;
- runtime/deployment commit:
  `e676f7cb6d15766e10fbdff72150dad71c593df1`;
- public charging, registration, payment, legal approval, live canary and both
  administrator/customer MFA hard gates remain disabled.

## Delivered

- authenticated user tenant inventory returns only active memberships with
  tenant ID/slug/name/status/plan/role;
- active/trial tenants sort before suspended tenants; suspended membership
  remains selectable for privacy/security rights surfaces;
- SaaS Shell renders a selector only for users with multiple memberships;
- switch requires HttpOnly session, matching CSRF header/cookie and trusted
  Origin, but remains available during legal re-consent/suspension;
- one PostgreSQL statement validates target membership, revokes the exact
  source session with reason `tenant_switch` and inserts a new target-bound
  random token/CSRF hash session;
- invalid/foreign target does not revoke the source; concurrent switches from
  one session have exactly one winner/new active session;
- new session copies the original `mfa_verified_at` timestamp exactly, so
  repeated switching cannot extend privileged step-up;
- target legal acceptance is recomputed and the UI routes stale/suspended
  targets to consent or restricted rights surfaces;
- source tenant receives append-only audit start/terminal events without token,
  cookie, raw IP or User-Agent detail.

## Verification

- Relay tests: 369 passed;
- commercial tests: 94 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint (zero errors), production build and dependency audit
  passed; audit found zero known vulnerabilities;
- tests cover membership isolation, role/status mapping, foreign-target denial
  without logout, active and suspended targets, atomic source revocation/new
  authentication, exact MFA timestamp preservation, target role binding,
  concurrent single winner/session, CSRF/legal/suspension route guards, Shell
  selector wiring and tenant audit;
- isolated restore of the accepted rc23 backup plus migration24 produced
  schema24, 49 public tables, 24 migrations and five original internal
  accounts; `tenant_switch` was accepted and an arbitrary reason was rejected;
- isolated rehearsal database was removed.

## Production evidence

- exact public HTTPS identity: rc24/schema24/commit
  `e676f7cb6d15766e10fbdff72150dad71c593df1`;
- `/saas/security-center`: HTTP 200 with valid TLS;
- anonymous `/api/saas/tenants`: HTTP 401;
- internal platform readiness is healthy while commercial readiness remains
  false;
- database: 49 public tables, 24 migrations, 21 information-schema trigger
  rows, five internal accounts, zero tenants/users/memberships/customer
  sessions/pending-MFA/legal/privacy/key/order/ledger rows;
- one Worker and the dedicated Scheduler heartbeat remain online;
- release evidence:
  `/opt/backups/relay-release-evidence-e676f7cb6d15`;
- release-manifest SHA-256:
  `4e12b3439f3a12492cff0703e1c92921d5ae015d959f36f57f1d7e00e648dff1`;
- CycloneDX production SBOM SHA-256:
  `253c96e811d0a474f3846ce031a6498dd917d39e688f35e3fd2606c6e3f70b77`.

No production SaaS user/membership exists and registration remains disabled. A
real selector/switch flow was therefore not executed in production and is not
reported as a pass. Public pages, anonymous boundary, built UI, route guards
and PostgreSQL/library integration passed.

## Recovery evidence

- accepted pre-deploy backup:
  `/opt/backups/relay-password-change-final-20260831142156`;
- final backup:
  `/opt/backups/relay-tenant-switch-final-20260831145016`;
- control-plane manifest, all checksums and dry-run restore passed;
- complete Git bundle independently cloned, passed `git fsck --full`, and
  restored exact feature HEAD;
- PostgreSQL dump restored into an isolated database and matched live signature
  exactly: schema24, 49 tables, 24 migrations, 21 trigger rows, five accounts,
  zero tenant/user/membership/session/pending-MFA/legal/privacy/key/order/ledger
  rows, alert/delivery/email rows `1/1/0` and one Scheduler heartbeat;
- MinIO S3 snapshot contained 104 objects / 48,523,532 bytes and matched the
  sorted per-object SHA-256 list after extraction;
- final artifacts: PostgreSQL dump 44,572,266 bytes, complete source bundle
  13,988,038 bytes, object archive 46,898,221 bytes and 231 storage files;
- isolated restore database and staging directory were removed.

## Activation remains pending

Create one reviewed staging user with two tenant memberships and distinct roles.
Prove both selector entries and role boundaries, deny a foreign tenant, compare
MFA timestamps before/after, switch into suspended rights access, and race two
targets to retain evidence of one winner/active session. Store no cookies,
tokens, CSRF values or raw customer content.
