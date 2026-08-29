# Tenant mutation audit dark-launch acceptance

Date: 2026-08-30 (Asia/Shanghai)

## Release

- version: `0.10.0-rc13`
- schema: `15`
- runtime commit: `fa56455eecc9fc06d45dfab1f91ca48031c4963b`
- production remains fail-closed dark launch

## Delivered

- dedicated `relay_tenant_audit_events` table for customer control-plane
  mutations, separate from operational audit and the billing ledger;
- durable `started` plus `succeeded`/`failed` phases with a unique
  operation/outcome invariant;
- database trigger rejecting every update and delete;
- coverage for API-key create/revoke, member invite/update, Checkout/manual
  recharge, scheduled plan changes, MFA enrollment and logout;
- raw IP and User-Agent replaced by HMAC-SHA256; credentials, tokens, Cookies,
  email and secret-shaped values are removed or redacted; details are bounded;
- Owner/Admin tenant-isolated query and Portal view, plus a bounded platform
  administrator view;
- critical `TENANT_AUDIT_INCOMPLETE` monitoring after five minutes without a
  terminal outcome;
- versioned encrypted `security.auditHashKey`, deployment fallback and a
  commercial-readiness blocker for missing/short keys;
- application retention has no update/delete path for the tenant audit trail.

## Verification

- Relay tests: 324 passed;
- commercial tests: 61 passed;
- operations, migration and security tests: 21 passed;
- template, backup and restore tests: 103 passed;
- TypeScript, ESLint with zero errors, Linux/Windows production builds,
  generated route diff, secret scan and official npm dependency audit passed;
  dependency audit found zero known production vulnerabilities;
- tests prove success/failure phases, terminal target correlation, HMAC-only
  network identity, nested secret/email redaction, update/delete rejection,
  cross-tenant isolation, bounded listing, route coverage and incomplete-audit
  alerting;
- a simulated terminal-write loss preserves the completed business result and
  leaves one detectable `started` event, preventing duplicate payment retries;
- browser QA created a local tenant and API key, then verified exactly one
  terminal customer audit row, the cross-tenant platform view and the
  versioned audit-key configuration without displaying the one-time key again.

## Production evidence

- isolated restore rehearsal applied `0015_tenant_audit.sql` to a schema-14
  production dump and proved schema 15, five accounts, zero tenants/audits and
  one audit guard trigger;
- public and loopback `/healthz` report `0.10.0-rc13`, schema 15 and the exact
  runtime commit;
- source HEAD, `.deploy-rev`, runtime commit and recovered Git Bundle HEAD are
  identical;
- production contains 44 public tables and eight non-internal triggers;
- five internal web accounts remain present; SaaS tenants, sessions, orders,
  ledger, configuration, evidence, sandbox, plan periods and tenant audit rows
  remain zero;
- readiness reports `tenantAuditConfigured=true`, while commercial,
  registration, payment, live Canary, legal and privileged-customer MFA gates
  remain disabled; readiness remains false;
- anonymous `GET /api/saas/audit` returns HTTP 401;
- one Worker is online, Gateway/PostgreSQL/Redis are healthy and the deployment
  log fatal/uncaught/unhandled/migration-error scan is clean.

## Recovery proof

Backup: `/opt/backups/relay-tenant-audit-final-20260830000055`

- all listed SHA-256 checks passed;
- PostgreSQL custom dump restored into an isolated database and matched the
  live signature exactly: schema 15, 44 tables, eight triggers, five accounts
  and zero SaaS/commercial/audit rows;
- complete Git Bundle cloned on branch `main`, passed `git fsck --full` and
  matched the runtime commit;
- filesystem storage restored 272 files;
- MinIO was backed up through its S3 API with `mc mirror`, not by accepting a
  changing live volume: 96 objects / 45,849,211 bytes were archived, restored
  and matched by a per-object SHA-256 manifest;
- the first online raw-volume attempt was rejected when live and archive file
  counts diverged; that unaccepted archive was deleted and replaced by the
  authoritative object-level export;
- temporary database and extraction directories were removed.

## Activation remains pending

No production SaaS tenant or fake audit evidence was created. Public charging
still requires the genuine external contracts, credentials, reviewed prices,
Stripe/Tax/email/legal approvals, HA/offsite/alerting/load/soak evidence,
administrator/customer MFA enrollment and GitHub release-workflow authority
listed in `COMMERCIAL_COMPLETION_AUDIT.md`.

