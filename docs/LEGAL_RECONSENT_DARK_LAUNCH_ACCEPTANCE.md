# Legal re-consent and paid-key gate dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc19`;
- schema: `19`;
- runtime/deployment commit:
  `ae8392b2e48ae6af674d8b767fee5b87b8025347`;
- public charging, registration and legal approval remain disabled.

## Delivered

- append-only `reconsent` acceptance method;
- exact-current-bundle checks for individual users and active tenant
  Owner/Admin memberships;
- authenticated sessions expose `legalAcceptanceRequired`;
- all normal tenant APIs return `LEGAL_RECONSENT_REQUIRED` for a stale bundle,
  while the CSRF-protected consent endpoint and logout remain reachable;
- Login and Portal redirect stale sessions to `/saas/consent`;
- the consent page shows operator, versions, effective date and full bundle
  SHA-256, starts unchecked and appends an immutable record;
- replaying the same bundle is idempotent; publishing the next bundle makes the
  prior record stale without changing history;
- paid `sk-saas-*` authentication fails closed until an active Owner/Admin has
  accepted the exact current bundle;
- internal `sk-relay-*` web-account traffic remains outside the customer legal
  gate.

## Verification

- Relay tests: 350 passed;
- commercial tests: 75 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same platform skips;
- TypeScript, ESLint, production build and dependency audit passed; audit found
  zero known vulnerabilities;
- tests cover stale/current/next-version transitions, user and tenant-owner
  gates, idempotent replay, consent-only session access, Portal/Login routing,
  paid-key denial/recovery and continued append-only protection.

## Production and recovery evidence

- pre-deploy accepted backup:
  `/opt/backups/relay-legal-acceptance-final-20260831025159`;
- isolated schema18 restore plus migration19 produced schema19 and accepted
  `reconsent`; unknown methods and updates remained rejected;
- public HTTPS health/readiness reports rc19/schema19/exact commit; the consent
  page returns 200 with valid TLS;
- production remains at 47 public tables with 19 migrations, five internal
  accounts and zero tenants/legal rows; the new paid gate therefore causes no
  fabricated acceptance or internal account-pool impact;
- one Worker and the dedicated Scheduler remain online;
- release evidence:
  `/opt/backups/relay-release-evidence-ae8392b2e48a`;
- release-manifest SHA-256:
  `c67d0307ad00ac99947e1a6340c9f0e620bce8f7f5887cb701eea2437712bd29`;
- CycloneDX production SBOM SHA-256:
  `89c3d009104a106fd13d08c19c6ed73eeef5b862438656e505129d024ebadc6b`;
- final backup:
  `/opt/backups/relay-legal-reconsent-final-20260831032656`;
- all checksums, control-plane dry-run, Git bundle, PostgreSQL restore and
  object manifest passed; restored state matched schema19, 47 tables,
  19 migrations, five accounts, zero tenants/legal rows and 104 objects /
  48,523,532 bytes;
- the isolated restore database and staging directory were removed.

## External activation remains pending

The operator must still publish counsel-approved metadata and evidence. During
acceptance, change a reviewed version in staging, verify session redirect and
paid-key denial, complete Owner/Admin re-consent, and retain the resulting
immutable row before opening commercial traffic.

