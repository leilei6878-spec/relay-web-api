# Staged MFA replacement dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc22`;
- schema: `22`;
- runtime/deployment commit:
  `c82e689a0e99a8723a07219b707448a3cdbc29f6`;
- public charging, registration, payment, legal approval, live canary and both
  administrator/customer MFA hard gates remain disabled.

## Delivered

- TOTP candidates use a separate AES-GCM encrypted pending column and
  database-paired ten-minute expiry;
- starting enrollment/replacement does not change the active Secret,
  `mfa_enabled` or existing recovery-code hashes;
- replacing an existing factor requires a recent session-level MFA proof at
  both start and confirmation;
- initial enrollment remains available so a new Owner/Admin can establish the
  first factor before commercial activation;
- confirmation verifies the pending Secret, exact ciphertext and database
  expiry, then one PostgreSQL statement promotes it, rotates eight recovery
  hashes, clears the candidate, refreshes the current proof and revokes every
  other active session with `mfa_reenrollment`;
- wrong, expired, stale or concurrent confirmation cannot disable or overwrite
  the active factor; expired attempts clear only the candidate;
- UI closes clear plaintext pending/recovery state from React memory;
- daily retention, password reset and privacy closure clear expired/pending
  candidates without exposing them in exports, inventory, audit or logs.

## Verification

- Relay tests: 363 passed;
- commercial tests: 88 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint (zero errors), production build and production dependency
  audit passed; audit found zero known vulnerabilities;
- tests prove initial enrollment, abandoned replacement, wrong and expired
  codes, active Secret/recovery hash preservation, old-factor login before
  confirmation, exact promotion, old-factor/other-session rejection after
  confirmation, current/new-factor success, pending cleanup and password-reset/
  privacy-closure cleanup;
- isolated restore of the accepted rc21 backup plus migration22 produced
  schema22, 49 public tables, 22 migrations and five original internal
  accounts; active and pending ciphertext coexisted while `mfa_enabled=true`,
  the pair constraint and arbitrary revocation reason were rejected;
- the isolated rehearsal database was removed.

## Production evidence

- exact public HTTPS identity: rc22/schema22/commit
  `c82e689a0e99a8723a07219b707448a3cdbc29f6`;
- `/saas/security-center`: HTTP 200 with valid TLS;
- anonymous `/api/saas/security`: HTTP 401;
- internal platform readiness is healthy while commercial readiness remains
  false;
- database: 49 public tables, 22 migrations, 21 information-schema trigger
  rows, five internal accounts, zero tenants/users/customer sessions/pending
  MFA/legal/privacy/key/order/ledger rows;
- one Worker and the dedicated Scheduler heartbeat remain online;
- release evidence:
  `/opt/backups/relay-release-evidence-c82e689a0e99`;
- release-manifest SHA-256:
  `53d8218b4a1da2850e76fcba498fe58c53382c4fbfbfec8b1aba7c76f98e14c6`;
- CycloneDX production SBOM SHA-256:
  `2a92ff57897be46c461fed17a99f96f9af1291b1ac9d9da3a85be1e6539e4f67`.

No production SaaS user exists and registration remains disabled. A real
authenticator replacement was therefore not executed in production and is not
reported as a pass. The public security page, anonymous boundary, built UI,
route guards and PostgreSQL/library integration passed.

## Recovery evidence

- accepted pre-deploy backup:
  `/opt/backups/relay-customer-session-final-20260831132026`;
- final backup:
  `/opt/backups/relay-staged-mfa-final-20260831135735`;
- control-plane manifest, all checksums and dry-run restore passed;
- full Git bundle independently cloned, passed `git fsck --full`, and restored
  the exact feature HEAD;
- PostgreSQL custom dump restored into an isolated database and matched live
  signature exactly: schema22, 49 tables, 22 migrations, 21 trigger rows, five
  accounts, zero tenant/user/session/pending-MFA/legal/privacy/key/order/ledger
  rows, alert/delivery/email rows `1/1/0` and one Scheduler heartbeat;
- MinIO S3 snapshot contained 104 objects / 48,523,532 bytes and matched the
  sorted per-object SHA-256 list after extraction;
- final artifacts: PostgreSQL dump 44,565,280 bytes, complete source bundle
  13,967,490 bytes, object archive 46,898,234 bytes and 231 storage files;
- isolated restore database and staging directory were removed.

## Activation remains pending

With a reviewed staging Owner, begin replacement and prove the old factor still
works; abandon and expire a second candidate; then confirm a third candidate
and prove the old factor, prior recovery codes and another device fail while
the current session, new factor and one new recovery code work. Retain no
plaintext Secret, recovery code, cookie or token hash in evidence.
