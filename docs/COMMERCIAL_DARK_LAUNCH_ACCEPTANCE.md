# Commercial SaaS dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Decision

The commercial SaaS control plane is deployed in dark-launch mode. It is not
approved for public registration or paid traffic yet. The fail-closed flags are:

- `RELAY_COMMERCIAL_ENABLED=0`
- `RELAY_SAAS_REGISTRATION_ENABLED=0`
- `RELAY_LEGAL_APPROVED=0`

Runtime identity:

- version: `0.10.0-rc1`
- schema: `7`
- implementation commit: `8a5bbc6b3cf32b3fc6f4cb597a68ea8beb68975b`
- production URL: `https://relay.38.175.201.137.nip.io`

## Delivered controls

- tenant users, memberships, invitations, owner/admin/member RBAC and TOTP MFA;
- email verification and password-reset tokens stored as hashes;
- tenant API keys stored as SHA-256 hashes, shown once, scoped, revocable and
  subject to RPM, spend and distributed-concurrency limits;
- versioned price book, row-locked balance reservations, idempotent orders,
  append-only double-entry ledger and provider-result settlement checkpoints;
- official OpenAI, Google and Leonardo adapters separated from the internal
  web-account pool;
- customer portal, commercial administrator console, legal draft pages,
  monitoring, retention jobs, offsite-backup script, CI security gates and an
  HA deployment contract.

## Verification evidence

- Relay unit/integration tests: 273 passed.
- Multi-process/operations tests: 21 passed.
- Backup/template tests: 101 passed.
- Commercial tests: 25 passed.
- TypeScript, ESLint, production build and `git diff --check`: passed.
- Official npm audit (`high`, production dependencies): 0 vulnerabilities.
- Production migration table contains `0007_commercial_saas.sql`.
- Production gateway, worker, PostgreSQL and Redis are running; gateway,
  PostgreSQL and Redis health checks are healthy.
- `/saas/login`, `/legal/terms` and `/legal/privacy`: HTTP 200.
- anonymous commercial-admin API: HTTP 401; authenticated administrator API:
  HTTP 200.
- registration while disabled: HTTP 503 `REGISTRATION_DISABLED`.
- invalid `sk-saas-` key on model discovery: HTTP 401.
- commercial tables contain zero tenants, users, orders, ledger entries,
  usage charges and prices, confirming that dark launch created no customer or
  billing data.
- all five pre-existing web accounts remain present. Four Leonardo accounts are
  healthy. The ChatGPT account was already marked invalid at 06:29:51 UTC,
  before the first commercial deployment at 06:36:28 UTC.

The verified pre-migration backup is
`/opt/backups/relay-pre-commercial-202608290632`. It includes PostgreSQL,
filesystem storage, MinIO data, configuration, Caddy configuration and a full
Git bundle, with SHA-256 verification completed on the host.

## Blocking conditions before paid launch

Paid traffic and self-registration must remain disabled until all of the
following are independently verified:

1. official provider contracts and production API credentials;
2. an approved active price book and funded settlement tests;
3. at least two gateway replicas and two workers on production-grade shared
   PostgreSQL, Redis and object storage;
4. a separate-account/offsite backup target plus a successful restore drill;
5. counsel-approved terms, privacy notice and data-processing terms;
6. a production email delivery webhook for verification and password reset;
7. payment-provider webhook verification and reconciliation, if automatic
   card payments are enabled;
8. provider canaries, 200-request acceptance and a 24-hour soak with alerts.

No readiness blocker may be bypassed by setting the commercial flag alone.
