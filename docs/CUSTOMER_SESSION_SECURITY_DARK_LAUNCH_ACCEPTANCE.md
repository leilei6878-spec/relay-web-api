# Customer session security dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc21`;
- schema: `21`;
- runtime/deployment commit:
  `4241e902c0f97ba6c5069b783c193448cc13a3a2`;
- public charging, registration, payment, legal approval, live canary and both
  administrator/customer MFA hard gates remain disabled.

## Delivered

- personal session inventory across a user's tenants, showing only session ID,
  current marker, tenant name/status, IP, bounded User-Agent, create/activity/
  expiry/MFA/revocation timestamps and bounded revocation reason;
- token and CSRF hashes are never returned;
- activity timestamp refresh is write-throttled to once per five minutes;
- user-scoped single-device revocation rejects the current or a foreign user's
  session;
- idempotent all-other-device revocation preserves the current session;
- MFA recovery-code rotation always requires a recent MFA proof, takes a
  distributed per-user lock, replaces all eight SHA-256 hashes, returns
  plaintext once and revokes every other active session;
- Redis/lock failure rejects rotation rather than creating two competing code
  sets;
- every mutation is CSRF/Origin protected and writes tenant audit outcomes
  without IP, User-Agent, token or recovery-code detail;
- `/saas/security-center` and its API remain available during legal re-consent
  or tenant suspension, while ordinary service APIs remain denied;
- `relay-tenant-export-v1` now includes non-secret session IP/device/activity/
  revocation metadata while continuing to exclude token/CSRF hashes and MFA
  material.

## Verification

- Relay tests: 362 passed;
- commercial tests: 87 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint (zero errors), production build and production dependency
  audit passed; audit found zero known vulnerabilities;
- tests cover user isolation, secret omission, current-device protection,
  foreign-session rejection, individual/all-other revocation, durable reasons,
  one-time recovery hashes, rotation mutual exclusion/unavailable failure,
  current-session preservation, activity throttling, legal/suspension access,
  tenant audit wiring and privacy export coverage;
- isolated restore of the accepted rc20 backup plus migration21 produced
  schema21, 49 public tables, 21 migrations and five original internal
  accounts; a supported revocation reason succeeded and an arbitrary reason
  was rejected by PostgreSQL;
- the isolated rehearsal database was removed.

## Production evidence

- exact public HTTPS release identity: rc21/schema21/commit
  `4241e902c0f97ba6c5069b783c193448cc13a3a2`;
- `/saas/security-center`: HTTP 200 with valid TLS;
- anonymous `/api/saas/security`: HTTP 401;
- internal platform readiness is healthy while commercial readiness remains
  false;
- database: 49 public tables, 21 migrations, 21 information-schema trigger
  rows, five internal accounts, zero tenants/users/customer sessions/legal/
  privacy/key/order/ledger rows;
- one Worker and the dedicated Scheduler heartbeat remain online;
- release evidence:
  `/opt/backups/relay-release-evidence-4241e902c0f9`;
- release-manifest SHA-256:
  `843abc5625241c21bd0e78410852aedc85c19efb5576bfd7dc35582c42dde6f9`;
- CycloneDX production SBOM SHA-256:
  `4052b00f2250f6f317aa2e2efc9a26c8b0c43833abb71592e0eb44b77a692f65`.

No production SaaS user exists and registration remains disabled. An
authenticated real-device inventory/revoke/rotation UI flow was therefore not
executed in production and is not reported as a pass. The public page, anonymous
boundary, built UI, API wiring and PostgreSQL/library integration passed.

## Recovery evidence

- accepted pre-deploy backup:
  `/opt/backups/relay-privacy-rights-final-20260831124220`;
- final backup:
  `/opt/backups/relay-customer-session-final-20260831132026`;
- control-plane manifest, all checksums and dry-run restore passed;
- the full Git bundle independently cloned, passed `git fsck --full`, and
  restored the exact feature HEAD;
- PostgreSQL custom dump restored into an isolated database and matched live
  signature exactly: schema21, 49 tables, 21 migrations, 21 trigger rows, five
  accounts, zero commercial tenant/user/session/legal/privacy/key/order/ledger
  rows, alert/delivery/email rows `1/1/0` and one Scheduler heartbeat;
- MinIO S3 snapshot contained 104 objects / 48,523,532 bytes and matched the
  sorted per-object SHA-256 list after archive extraction;
- final artifact sizes: PostgreSQL dump 44,557,381 bytes, complete source bundle
  13,956,920 bytes, object archive 46,898,141 bytes and 231 storage files;
- isolated restore database and staging directory were removed.

## Activation remains pending

Before commercial launch, use a reviewed staging tenant with two real devices:
enroll MFA, confirm both sessions appear, revoke one, verify it fails on the
next request, rotate recovery codes, prove the previous codes and other device
are rejected, and verify the current session plus one new code remain valid.
Retain only content-minimised evidence—never plaintext recovery codes, raw
cookies or session-token hashes.
