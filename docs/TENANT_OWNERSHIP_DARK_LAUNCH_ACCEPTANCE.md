# Designated tenant ownership dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc25`;
- schema: `25`;
- runtime/deployment commit:
  `8eba942a493b617ecd80417de330409a514b5a5a`;
- public charging, registration, legal approval, live provider Canary and both
  administrator/customer MFA hard gates remain disabled; payment provider is
  `disabled`.

## Delivered

- each live tenant has one composite-FK ownership row designating its exact
  active Owner membership;
- migration backfill deterministically retains the earliest active legacy
  Owner and demotes additional Owner roles to Admin;
- database triggers reject direct deletion, disabling or demotion of the
  designated Owner and reject any direct second-Owner insert or promotion;
- normal invitation and role mutation cannot grant Owner;
- one serialized PostgreSQL function verifies the source designation and an
  active, MFA-enabled target, then designates/promotes the target and demotes
  the source to Admin in one transaction;
- concurrent transfers from the same source have one winner;
- the customer endpoint additionally requires Owner role, trusted Origin,
  CSRF, unconditional recent MFA and append-only tenant audit;
- Portal displays the designated Owner, disables ineligible targets and
  requires typing the target email before transfer;
- commercial monitoring raises critical `TENANT_OWNER_MISSING` for any
  active/trial/suspended tenant without a valid Owner/user/membership chain;
- terminal privacy closure explicitly releases ownership before disabling all
  memberships, without weakening the general Owner guard.

## Verification

- Relay tests: 371 passed;
- commercial tests: 96 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint (zero errors), production build and production dependency
  audit passed; audit found zero known vulnerabilities;
- tests cover first-Owner registration, legacy uniqueness, Owner invite and
  direct role denial, target MFA, direct deletion/demotion/promotion guards,
  atomic role swap, concurrent single winner, unconditional route MFA,
  closure integration, monitoring and tenant-scoped member listing;
- isolated restore of the accepted rc24 backup plus migration25 produced
  schema25, 50 public tables, 25 migrations, 25 information-schema trigger
  rows and five original internal accounts;
- real PostgreSQL rehearsal proved no-MFA rejection, successful transfer,
  source Admin/target Owner, direct demotion/promotion rejection and test
  rollback; the isolated rehearsal database was removed.

## Production evidence

- exact public HTTPS identity: rc25/schema25/commit
  `8eba942a493b617ecd80417de330409a514b5a5a`;
- `/readyz` reports ready with database/Redis/object storage/Worker/migrations,
  trusted client network and release identity all healthy;
- `/saas/security-center`: HTTP 200 with valid TLS;
- anonymous `/api/saas/members` and `/api/saas/tenants`: HTTP 401;
- database: 50 public tables, 25 migrations, 25 information-schema trigger
  rows, five internal accounts, zero tenants/users/memberships/ownership rows,
  customer sessions/API keys/legal/privacy/order/billing rows all zero;
- one Worker and the dedicated Scheduler are online;
- Gateway, Worker and Scheduler five-minute fatal/uncaught/unhandled/migration
  error scan: zero;
- release evidence:
  `/opt/backups/relay-release-evidence-8eba942a493b`;
- release-manifest SHA-256:
  `803ab15638bffdeef26a29ad3081dd84ce247a8269a9605edc1868fc56c2dc1f`;
- CycloneDX production SBOM SHA-256:
  `ff1bc7b00a6a6cb9883cdaf3be455e68c0b6a3a4af6b95e5c90ffe6e03924d09`.

No production SaaS user exists and registration remains disabled. A real
browser ownership transfer was therefore not executed in production and is
not reported as a pass. The built UI, anonymous boundary, route guards,
PostgreSQL/library integration and isolated real-database flow passed.

## Recovery evidence

- accepted pre-deploy backup:
  `/opt/backups/relay-ownership-predeploy-20260831152608`;
- final backup:
  `/opt/backups/relay-ownership-final-20260831154207`;
- control-plane manifest, all checksums and dry-run restore passed;
- complete Git bundle independently cloned, passed `git fsck --full`, and
  restored the exact feature HEAD;
- PostgreSQL dump restored into an isolated database: schema25, 50 tables, 25
  migrations, 25 trigger rows, five accounts and zero tenant/user/membership/
  ownership/session/key/legal/privacy/order/billing rows;
- MinIO S3 snapshot contained 104 objects / 48,523,532 bytes and matched the
  sorted per-object SHA-256 list after extraction;
- final artifacts: PostgreSQL dump 44,587,536 bytes, complete source bundle
  13,998,487 bytes and object archive 46,898,252 bytes;
- isolated restore database and staging directories were removed.

## Activation remains pending

Create one reviewed staging tenant with an MFA-verified current Owner and an
active MFA-enabled target. Prove the Portal confirmation, audit start/terminal
events, source role/session permissions after transfer, target Owner
permissions, no-MFA denial and two-target concurrent single winner. Store no
authenticator secret, recovery code, cookie, CSRF value or session token in
acceptance evidence.
