# Tenant invitation lifecycle dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc26`;
- schema: `26`;
- runtime/deployment commit:
  `e53beb364a345dad9dfb24f9b9b2b9ff71065963`;
- public charging, registration, legal approval, live provider Canary and both
  administrator/customer MFA hard gates remain disabled; payment provider is
  `disabled`.

## Delivered

- Owner/Admin receives tenant-scoped invitation lifecycle metadata for
  pending, expired, accepted and revoked records without token hash, encrypted
  payload or delivery credentials;
- fresh invitation links use 256-bit random tokens with SHA-256 only at rest;
- re-send compare-and-swaps the current hash, rotates to a fresh token,
  increments send count and queues an encrypted Outbox message atomically;
- concurrent re-send has one winner and a 60-second database cooldown returns
  HTTP 429 plus `Retry-After: 60` for rapid retries;
- revoke compare-and-swaps the hash to a random tombstone, records actor/time
  and supersedes queued delivery ciphertext in the same statement;
- acceptance locks and rechecks exact hash, expiry and non-revoked state inside
  membership creation, so a lookup raced by re-send/revoke cannot succeed;
- accepted/revoked are mutually exclusive and only one non-terminal invite per
  tenant/email exists; a revoked record does not prevent a fresh invitation;
- create/re-send/revoke remain CSRF/Origin protected, follow privileged
  session-level MFA policy and write tenant-audit start/terminal events;
- privacy export includes non-secret invitation state; terminal invitation PII
  follows operational retention; tenant closure invalidates token hashes and
  scrubs email/Outbox content without violating terminal-state constraints;
- Portal shows lifecycle, role, last send, send count and allowed actions.

## Verification

- Relay tests: 372 passed;
- commercial tests: 97 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint (zero errors), production build and production dependency
  audit passed; audit found zero known vulnerabilities;
- tests cover no-secret listing, tenant isolation, old-token rejection,
  rotation, cooldown, concurrent single winner, revoke, acceptance race guard,
  Outbox secret omission, audit route wiring, privacy export, terminal PII
  retention and pending/revoked tenant closure;
- isolated restore of the accepted rc25 backup plus migration26 produced
  schema26, 50 public tables, 26 migrations, 25 trigger rows and five original
  internal accounts;
- real PostgreSQL rehearsal proved terminal exclusivity, revoked-then-new
  invitation, active uniqueness, old-hash CAS one winner, defaults and rollback;
  the rehearsal database was removed.

## Production evidence

- exact public HTTPS identity: rc26/schema26/commit
  `e53beb364a345dad9dfb24f9b9b2b9ff71065963`;
- `/readyz` reports ready with database/Redis/object storage/Worker/migrations,
  trusted client network and release identity all healthy;
- `/saas/security-center`: HTTP 200 with valid TLS;
- anonymous `/api/saas/members`: HTTP 401;
- database: 50 public tables, 26 migrations, 25 information-schema trigger
  rows, five internal accounts, zero tenants/users/memberships/ownership/
  invitation rows; customer sessions/API keys/legal/privacy/order/billing rows
  all zero;
- migration columns `revoked_at`, `revoked_by`, `last_sent_at`, `send_count` and
  `updated_at`, both check constraints and the partial unique index were
  independently queried in production;
- one Worker and the dedicated Scheduler are online;
- Gateway, Worker and Scheduler fatal/uncaught/unhandled/migration error scan:
  zero;
- release evidence:
  `/opt/backups/relay-release-evidence-e53beb364a34`;
- release-manifest SHA-256:
  `aff850758c71eb2abd42f512c3abe5f0757f23c8c03245a58e930c16c95c0106`;
- CycloneDX production SBOM SHA-256:
  `798aa08b240810397a79c4295a1be060fe24513a90158efe97eb7b25f3b25061`.

No production SaaS user/invitation exists and registration remains disabled. A
real delivered invitation browser flow was therefore not executed in
production and is not reported as a pass. Built UI, anonymous boundary, route
guards, PostgreSQL/library integration and isolated real-database invariants
passed.

## Recovery evidence

- accepted pre-deploy backup:
  `/opt/backups/relay-ownership-final-20260831154207`;
- final backup:
  `/opt/backups/relay-invitation-final-20260831162752`;
- control-plane manifest, all checksums and dry-run restore passed;
- complete Git bundle independently cloned, passed `git fsck --full`, and
  restored the exact feature HEAD;
- PostgreSQL dump restored into an isolated database: schema26, 50 tables, 26
  migrations, 25 trigger rows, five accounts and zero tenant/user/membership/
  ownership/invitation/session/key/legal/privacy/order/billing rows;
- MinIO S3 snapshot contained 104 objects / 48,523,532 bytes and matched the
  sorted per-object SHA-256 list after extraction;
- final artifacts: PostgreSQL dump 44,594,104 bytes, complete source bundle
  14,009,576 bytes and object archive 46,898,170 bytes;
- isolated restore database and staging directories were removed.

## Activation remains pending

Configure the reviewed transactional-email receiver and create one staging
tenant. Create, list, re-send, race, revoke and accept invitations through the
Portal and email link; confirm audit terminal outcomes, HTTP 429 cooldown and
old-token failure. Store no invitation URL/token, cookie, CSRF value or email
payload in long-lived evidence.
