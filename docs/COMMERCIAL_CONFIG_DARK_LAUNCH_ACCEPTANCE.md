# Commercial configuration center dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Release

- version: `0.10.0-rc4`
- schema: `9`
- runtime commit: `433b5c781659d0ec553329a4869860dba6aefc10`
- page: `/commercial-config`
- production remains fail-closed dark launch

## Delivered

- fixed 18-item catalog for launch gates, official providers, Stripe/payment,
  tax, email/alerts and retention;
- immutable version history with one active version per key;
- AES-256-GCM encrypted secret values requiring `RELAY_SECRETS_KEY`;
- hint-only secret display and no secret/provider error body in API, audit or
  connection-test detail;
- draft, test, activate, rotate and tested-version rollback lifecycle;
- fixed read-only official connection endpoints for OpenAI, Gemini, Leonardo
  and Stripe plus local Stripe Webhook-secret validation;
- HTTPS Webhook validation, private/reserved address rejection and DNS checks
  before test and every production delivery;
- environment fallback and deployment hard veto for commercial, registration
  and legal gates;
- runtime integration for official adapters, Stripe Checkout/Webhook/refund,
  email verification/reset, alerts, retention and Readiness;
- administrator configuration UI, audit rows and five-second convergence.

## Evidence

- Relay tests: 287 passed after isolated rerun; the single parallel-load Chaos
  timing failure reproduced as passing both alone and in the full serial suite.
- Operations/migration/security tests: 21 passed.
- Template/backup/restore tests: 101 passed.
- Commercial tests: 38 passed.
- TypeScript, ESLint, production build, diff check and production npm audit:
  passed; 0 vulnerabilities.
- Browser QA: non-secret draft/publish/version/rollback passed; missing master
  key kept the secret form open with an explicit error; configured master key
  allowed secret create/test/activate while showing only `whse…5678`.
- Real production-host PostgreSQL migration rehearsal applied 0001–0009 and
  verified schema 9, active-version unique index and immutable-value trigger.
- Production health reports the exact version/schema/commit above.
- `/commercial-config`: HTTP 200.
- anonymous config API: HTTP 401; authenticated config API: HTTP 200.
- registration remains HTTP 503; unsigned Stripe event remains HTTP 400.
- production contains zero configuration versions, commercial tenants, orders
  and billing entries after deployment, so no environment fallback changed.
- five existing internal web accounts remain present.

## Latest recovery proof

Backup: `/opt/backups/relay-commercial-config-final-202608290957`

- every archive/config checksum: pass;
- restored PostgreSQL signature matches production;
- schema 9 and 39 public tables;
- four immutable billing/payment/config triggers;
- 272 filesystem storage files and 157 MinIO files extracted;
- complete Git bundle independently cloned and fsck-verified at the runtime
  commit;
- temporary database/directories removed.

## External blockers unchanged

No configuration value can replace official contracts/credentials, reviewed
prices, Stripe merchant and event setup, tax/legal approval, production email,
real HA replicas, distinct-account offsite backup, alert receiver, GitHub write
permission or live acceptance/soak evidence. Those remain required before paid
launch.
