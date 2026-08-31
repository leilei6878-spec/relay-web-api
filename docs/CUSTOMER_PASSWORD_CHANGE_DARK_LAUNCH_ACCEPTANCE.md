# Customer password change dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc23`;
- schema: `23`;
- runtime/deployment commit:
  `d38e5d51ea57d1fad914bbba74ada3207640215b`;
- public charging, registration, payment, legal approval, live canary and both
  administrator/customer MFA hard gates remain disabled.

## Delivered

- self-service password change in the independent customer security center;
- HttpOnly session, CSRF double submit and trusted Origin are mandatory;
- accounts with MFA enabled additionally require a recent session-level proof;
- current-password verification and new-password hashing use the existing
  bounded scrypt contract; current-password reuse is rejected;
- distributed per-user/hour attempt limiting; coordination failure rejects the
  change instead of falling back to a process-local counter;
- exact old-hash compare-and-swap gives concurrent changes one database winner;
- success clears pending MFA replacement, preserves the current session and
  revokes every other active user session with bounded reason
  `password_change`;
- another user's sessions are untouched;
- current/new passwords and password hashes are absent from responses, tenant
  audit detail, privacy export and general logs; dialog close clears React
  password state.

## Verification

- Relay tests: 365 passed;
- commercial tests: 90 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint (zero errors), production build and production dependency
  audit passed; audit found zero known vulnerabilities;
- tests cover wrong current password, current-password reuse, length contract,
  rate limit, coordination failure, MFA route step-up, successful hash change,
  pending-MFA cleanup, current/foreign-session preservation, other-session
  revocation/reason, secret omission, tenant audit wiring and concurrent CAS;
- isolated restore of the accepted rc22 backup plus migration23 produced
  schema23, 49 public tables, 23 migrations and five original internal
  accounts; `password_change` was accepted and an arbitrary revocation reason
  was rejected by PostgreSQL;
- the isolated rehearsal database was removed.

## Production evidence

- exact public HTTPS identity: rc23/schema23/commit
  `d38e5d51ea57d1fad914bbba74ada3207640215b`;
- `/saas/security-center`: HTTP 200 with valid TLS;
- anonymous `/api/saas/security`: HTTP 401;
- internal platform readiness is healthy while commercial readiness remains
  false;
- database: 49 public tables, 23 migrations, 21 information-schema trigger
  rows, five internal accounts, zero tenants/users/customer sessions/pending
  MFA/legal/privacy/key/order/ledger rows;
- one Worker and the dedicated Scheduler heartbeat remain online;
- release evidence:
  `/opt/backups/relay-release-evidence-d38e5d51ea57`;
- release-manifest SHA-256:
  `a43ed019b24c6ff073601ee651ba31b73bf9f74b4340661978d07e8d03467794`;
- CycloneDX production SBOM SHA-256:
  `0bf0dc534e654f9282c0cdb3ba8fdfcba3bf79e089fc5ba7fb42831f66e7760d`.

No production SaaS user exists and registration remains disabled. A real
password change from two devices was therefore not executed in production and
is not reported as a pass. Public page, anonymous boundary, built UI, route
guards and PostgreSQL/library integration passed.

## Recovery evidence

- accepted pre-deploy backup:
  `/opt/backups/relay-staged-mfa-final-20260831135735`;
- final backup:
  `/opt/backups/relay-password-change-final-20260831142156`;
- control-plane manifest, all checksums and dry-run restore passed;
- full Git bundle independently cloned, passed `git fsck --full`, and restored
  the exact feature HEAD;
- PostgreSQL custom dump restored into an isolated database and matched live
  signature exactly: schema23, 49 tables, 23 migrations, 21 trigger rows, five
  accounts, zero tenant/user/session/pending-MFA/legal/privacy/key/order/ledger
  rows, alert/delivery/email rows `1/1/0` and one Scheduler heartbeat;
- MinIO S3 snapshot contained 104 objects / 48,523,532 bytes and matched the
  sorted per-object SHA-256 list after extraction;
- final artifacts: PostgreSQL dump 44,568,815 bytes, complete source bundle
  13,977,481 bytes, object archive 46,898,203 bytes and 231 storage files;
- isolated restore database and staging directory were removed.

## Activation remains pending

With one reviewed staging user on two devices, change the password from the
MFA-verified current device. Prove the old password, pending MFA candidate and
other device fail; prove the new password and current device remain valid;
then run two simultaneous changes and retain evidence that exactly one wins.
Never retain a password, cookie, session token or password hash.
