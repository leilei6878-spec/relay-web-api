# Tenant privacy rights dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc20`;
- schema: `20`;
- runtime/deployment commit:
  `24e0a94b79c44b007df06c8785d84b0b906aba39`;
- primary feature commit:
  `80d443702a989e05359ce2497b04712b44639fe6`;
- public charging, registration, payment, legal approval, live canary and both
  administrator/customer MFA hard gates remain disabled.

## Delivered

- Owner-only, tenant-scoped `relay-tenant-export-v1` JSON archive generated
  from one PostgreSQL statement snapshot;
- response and immutable evidence bind the exact SHA-256 and byte count without
  retaining a duplicate export payload;
- password/session/verification/API-key hashes, MFA material, Checkout URLs,
  provider references, network HMAC evidence and encrypted provider results
  are excluded;
- configurable 1–30 day closure cooling-off and 1–250 MiB complete-export
  ceiling are versioned configuration entries with deployment fallbacks;
- one open closure per tenant, idempotent replay and Owner cancellation;
- due execution locks the request and tenant, then atomically rechecks cash,
  included credit, reservations, open orders, refunds and disputes;
- clear requests close the tenant, revoke keys/sessions, disable memberships,
  consume verification tokens, invalidate invites, scrub transient email/
  Checkout/provider-result payloads, and pseudonymize only users without
  another active tenant;
- immutable billing, plan-period, legal-acceptance, tenant-audit and privacy
  event evidence is retained; privacy requests cannot be deleted and event rows
  are append-only;
- hourly Scheduler execution, administrator manual check and overdue/blocked
  commercial alerts;
- a separate `/saas/privacy-center` remains reachable without accepting a new
  legal bundle and by suspended tenants, while ordinary service APIs stay
  denied; MFA enrollment also remains reachable to protect the sensitive
  operation.

## Verification

- Relay tests: 357 passed;
- commercial tests: 82 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint (zero errors), production build and production dependency
  audit passed; audit found zero known vulnerabilities;
- privacy tests cover cross-tenant exclusion, secret-field omission, digest
  replay, cooling-off idempotency/cancellation, financial blocking, atomic
  closure, invite/email scrubbing, exclusive-user pseudonymization, shared-user
  preservation, suspended-tenant restricted login, stale-legal access and
  unconditional recent MFA;
- an isolated schema19 production backup restore plus migration20 produced
  schema20, 49 public tables and 20 migrations; request/event deletion and an
  invalid state were rejected by PostgreSQL;
- the isolated rehearsal database was removed.

## Production evidence

- exact public HTTPS release identity: rc20/schema20/commit
  `24e0a94b79c44b007df06c8785d84b0b906aba39`;
- public `/saas/privacy-center`: HTTP 200 with valid TLS;
- anonymous `/api/saas/privacy`: HTTP 401;
- public production readiness remains healthy for the internal platform while
  commercial readiness remains false;
- database: 49 public tables, 20 migrations, 21 information-schema trigger
  rows, five internal accounts, zero tenants/users/legal acceptances/privacy
  requests/privacy events/API keys/orders/billing transactions;
- dedicated Scheduler heartbeat is current; one Worker remains online;
- release evidence:
  `/opt/backups/relay-release-evidence-24e0a94b79c4`;
- release-manifest SHA-256:
  `a0b689ac1d3bba0665f807595910b279569ff0e3fd1776f91177cf0debec7ba8`;
- CycloneDX production SBOM SHA-256:
  `b77f942d7585eaa44920a806bdb64a1b428d1cb3e1ddf457f5089f814c018a58`.

The automated browser-control connection timed out in both available browser
surfaces. No authenticated tenant exists and registration is intentionally off,
so an interactive Owner export/closure visual flow was not executed in
production. This is recorded as a dark-launch limitation, not reported as a
pass. Build output, HTTPS, anonymous boundary and database/library integration
tests passed.

## Recovery evidence

- accepted pre-deploy backup:
  `/opt/backups/relay-privacy-predeploy-20260831122759`;
- final backup:
  `/opt/backups/relay-privacy-rights-final-20260831124220`;
- control-plane manifest/checksums and dry-run restore passed;
- full Git bundle cloned independently, passed `git fsck --full`, and restored
  the exact source HEAD;
- PostgreSQL custom dump restored to an isolated database and matched the live
  signature exactly: schema20, 49 tables, 20 migrations, 21 trigger rows, five
  accounts, zero commercial tenant/user/legal/privacy/key/order/ledger rows,
  alert/delivery/email rows `1/1/0` and one Scheduler heartbeat;
- MinIO S3 API snapshot contained 104 objects / 48,523,532 bytes; archive
  extraction matched the sorted per-object SHA-256 list exactly;
- final artifact sizes: PostgreSQL dump 44,552,098 bytes, complete source bundle
  13,939,287 bytes and object archive 46,898,250 bytes;
- the isolated restore database and staging directory were removed.

## Activation remains pending

Before commercial launch, create a reviewed test tenant in staging, enroll an
Owner authenticator, exercise export/digest verification, request/cancel a
closure, prove financial blocking, and complete a disposable zero-balance
closure. Retain reviewed evidence without placing exported customer data in the
release artifact or general logs.
