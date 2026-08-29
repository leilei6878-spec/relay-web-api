# Commercial launch evidence dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Release

- version: `0.10.0-rc7`
- schema: `11`
- runtime commit: `cebf0dc361a6b6d9d287d59fd159626f61cbd49b`
- administrator page: `/commercial-readiness`
- production remains fail-closed dark launch

## Delivered

- fixed evidence catalog for provider rights, exact price review, legal, tax,
  live payments, production email, HA, distinct-account/region restore, alerts,
  200-request load, 24-hour soak and authoritative CI release gates;
- dynamic provider and exact price-ID requirements derived from active prices;
- append-only evidence versions with passed/failed/revoked conclusions;
- external artifact reference plus SHA-256, bounded note, observed time, expiry,
  recorder and a different independent reviewer;
- bounded validity from seven to 365 days depending on evidence type;
- rejection of credential-bearing URLs, OpenAI/Google/Stripe-shaped secrets,
  bearer tokens, private-key material and password-shaped notes;
- administrator-only history/API and non-secret public readiness counts;
- hard readiness and Stripe Checkout blockers for every missing, failed,
  revoked, expired or future-dated requirement;
- persistent warning during dark launch and critical alert after commercial
  enablement.

## Verification

- Relay tests: 299 passed;
- operations, migration and security tests: 21 passed;
- template/backup/restore tests: 101 passed;
- commercial tests: 50 passed;
- TypeScript, ESLint, production build, generated diff, post-commit secret scan
  and production dependency audit: passed; dependency audit found zero known
  vulnerabilities;
- PostgreSQL migration rehearsal applied `0001` through `0011`, verified the
  table/index/trigger and proved an UPDATE fails with the append-only guard;
- browser QA verified nine missing global requirements, zero history, the
  anti-forgery warning, confirmation gating and server rejection of incomplete
  evidence without inserting a row.

## Production evidence

- `/healthz` reports `0.10.0-rc7`, schema 11 and the exact runtime commit;
- `/commercial-readiness` returns HTTP 200;
- anonymous `/api/admin/commercial-evidence` returns HTTP 401;
- authenticated evidence API returns nine requirements, zero history and zero
  valid requirements;
- public readiness reports `evidenceTotal: 9`, `missingEvidence: 9`,
  `enabled: false` and `ready: false`;
- commercial, registration, legal and live-provider gates are zero and payment
  provider remains disabled;
- production contains zero evidence, active prices, commercial configuration,
  tenants, orders and billing transactions;
- all five existing internal web accounts remain present;
- Gateway is healthy, Worker is online and deployment logs contain no fatal,
  uncaught, unhandled or migration errors.

No evidence was fabricated for acceptance. No provider or payment request was
made and no fee was incurred.

## Recovery proof

Backup: `/opt/backups/relay-commercial-evidence-final-20260829114202`

- all SHA-256 checks passed;
- PostgreSQL custom dump restored into an isolated database and matched the
  production signature;
- restored schema: 11;
- restored public tables: 41;
- distinct immutable triggers: 6;
- restored accounts: 5;
- evidence/sandbox/configuration/tenant/order/ledger rows: 0;
- filesystem storage: 272 files;
- MinIO snapshot: 151 files;
- complete Git Bundle independently cloned and `git fsck --full` verified at
  the runtime commit;
- temporary database and extraction directories were removed.

## External acceptance remains open

The evidence ledger makes the remaining facts explicit but cannot create them.
Provider contracts/credentials, reviewed prices, Stripe live acceptance,
tax/legal documents, email, HA, offsite restore, alert receiver, load/soak and
authoritative GitHub CI must be completed by the responsible parties and then
recorded with genuine artifact hashes and independent reviewers.
