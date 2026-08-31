# Tenant API-key rotation dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc27`;
- schema: `27`;
- runtime/deployment commit:
  `ef1203c8c27c21bbd7309fd6d5952947b1943f82`;
- public charging, registration, legal approval, live provider Canary and both
  administrator/customer MFA hard gates remain disabled; payment provider is
  `disabled`.

## Delivered

- tenant API keys retain one current SHA-256 credential and at most one
  bounded previous credential for zero-downtime rotation;
- rotation requires Owner/Admin/Developer plus trusted Origin, CSRF and
  unconditional recent MFA, independent of dark-launch gates;
- exact current-hash compare-and-swap gives concurrent rotations one winner;
- a 60-second database cooldown returns HTTP 429 and `Retry-After: 60`;
- requested overlap is bounded to 5 minutes–7 days and clamped to the API key's
  own expiry; expired keys cannot rotate;
- another rotation immediately evicts the older previous credential, bounding
  the accepted set to two credentials;
- revoke and tenant closure clear the previous hash immediately; retention
  clears an expired previous hash without waiting for a request;
- current/previous plaintext and hashes never appear in listings, privacy
  export, audit detail or responses other than the one-time new secret;
- Portal shows current hint, status/expiry/use/limits and overlap deadline;
  Owner/Admin/Developer can create or rotate, while Billing/Viewer do not see
  mutation controls;
- creation exposes Chat/Image scope, model allowlist, expiry, RPM, concurrency,
  daily requests and monthly spend; the server rejects NaN, negative,
  excessive and invalid-expiry values independently of the UI.

## Verification

- Relay tests: 373 passed;
- commercial tests: 98 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint (zero errors), production build and production dependency
  audit passed; audit found zero known vulnerabilities;
- tests cover one-time generation, no-secret listing, old/new overlap, second
  rotation eviction, overlap/key-expiry clamp, expired-key denial, strict input
  bounds, cooldown, concurrent single winner, revoke, closure, retention,
  forced route MFA, HTTP 429 and audit wiring;
- isolated restore of the accepted rc26 backup plus migration27 produced
  schema27, 50 public tables, 27 migrations, 25 trigger rows and five original
  internal accounts;
- real PostgreSQL rehearsal proved pair/distinct/count constraints, effective
  overlap clamp, current-hash CAS one winner, defaults and rollback; the
  rehearsal database was removed.

## Production evidence

- exact public HTTPS identity: rc27/schema27/commit
  `ef1203c8c27c21bbd7309fd6d5952947b1943f82`;
- `/readyz` reports ready with database/Redis/object storage/Worker/migrations,
  trusted client network and release identity all healthy;
- anonymous `/api/saas/keys`: HTTP 401;
- database: 50 public tables, 27 migrations, 25 information-schema trigger
  rows, five internal accounts and zero tenant/user/membership/ownership/
  invitation/API-key/session/order/billing rows;
- migration columns `previous_key_hash`, `previous_key_expires_at`,
  `rotated_at`, `rotation_count` and `updated_at`, three check constraints and
  the partial unique previous-hash index were queried in production;
- one Worker and the dedicated Scheduler are online;
- Gateway, Worker and Scheduler fatal/uncaught/unhandled/migration error scan:
  zero;
- release evidence:
  `/opt/backups/relay-release-evidence-ef1203c8c27c`;
- release-manifest SHA-256:
  `34a60079359e3fffaa939a066c908195ab5fc2ebfde1121eb15e47def4167c1e`;
- CycloneDX production SBOM SHA-256:
  `f000c8fc4f52d3bdd46f149f6ad95c104551f97c9bb0c402053be3a23656a6fa`.

No production SaaS user/API key exists and registration remains disabled. A
real client cutover from old to new credential was therefore not executed in
production and is not reported as a pass. Built UI, anonymous boundary, route
guards, library integration and isolated real-database invariants passed.

## Recovery evidence

- accepted pre-deploy backup:
  `/opt/backups/relay-invitation-final-20260831162752`;
- final backup:
  `/opt/backups/relay-key-rotation-final-20260831170807`;
- control-plane manifest, all checksums and dry-run restore passed;
- complete Git bundle independently cloned, passed `git fsck --full`, and
  restored the exact feature HEAD;
- PostgreSQL dump restored into an isolated database: schema27, 50 tables, 27
  migrations, 25 trigger rows, five accounts and zero tenant/user/membership/
  ownership/invitation/API-key/session/legal/privacy/order/billing rows;
- MinIO S3 snapshot contained 104 objects / 48,523,532 bytes and matched the
  sorted per-object SHA-256 list after extraction;
- final artifacts: PostgreSQL dump 44,599,994 bytes, complete source bundle
  14,020,485 bytes and object archive 46,898,058 bytes;
- isolated restore database and staging directories were removed.

## Activation remains pending

With one MFA-enabled staging tenant and a disposable client, create a scoped
key, use it, rotate with overlap, migrate the client, expire/revoke the old
credential, race two rotations and prove one winner plus audit terminal events.
Never retain either plaintext key in screenshots, logs or acceptance evidence.
