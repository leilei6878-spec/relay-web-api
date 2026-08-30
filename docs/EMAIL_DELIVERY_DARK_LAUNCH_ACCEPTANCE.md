# Customer email Outbox dark-launch acceptance

Date: 2026-08-30 (Asia/Shanghai)

## Release

- version: `0.10.0-rc15`;
- schema: `17`;
- runtime/deployment commit:
  `95ddef50e11b0ec0b9368cf0df1a0e7311682b58`;
- production remains fail-closed: commercial traffic, registration, payment,
  live provider Canary and customer-MFA gates are disabled.

## Delivered

- encrypted PostgreSQL Outbox for email verification, password reset and
  tenant invitation;
- AES-256-GCM payload encryption and keyed recipient digest; the commercial
  admin API never returns ciphertext, raw addresses or action tokens;
- immediate ciphertext scrubbing on delivery, expiry or supersession;
- stable delivery ID, exact-body HMAC-SHA256, timestamp and fixed HTTPS
  receiver contract;
- exponential retry capped at one hour, two-minute crash-claim recovery,
  token-expiry bound and PostgreSQL conditional single winner;
- dedicated 30-second Scheduler task, MFA-protected manual retry, metrics,
  operations UI and bounded retention;
- versioned URL/HMAC configuration and a commercial-readiness hard blocker.

## Verification

- Relay tests: 332 passed;
- commercial tests: 69 passed;
- CI operations/security/recovery/scheduler tests: 35 passed, with two
  Windows-only symlink cases skipped (the same cases pass on Linux);
- template/release/backup tests: 117 passed, with two Windows-only symlink
  cases skipped;
- TypeScript, ESLint, production build and dependency audit passed; production
  dependency audit found zero known vulnerabilities;
- tests cover exact-body signing, stable IDs, encryption at rest, absence of
  raw address/token data, 5xx retry/backoff, delivery scrubbing,
  supersession/expiry, expired-claim recovery and concurrent single delivery;
- browser QA verified both versioned email settings and the Customer Email
  Outbox/manual-retry section with no console warnings or errors.

## Production evidence

- pre-deploy backup:
  `/opt/backups/relay-pre-email-outbox-20260830041620`;
- that schema-16 snapshot passed control-plane checksums, dry-run restore,
  independent Git-bundle verification and exact restoration of 96 object files
  / 45,849,211 bytes;
- isolated restore plus migration17 rehearsal produced schema 17, 46 tables,
  five accounts and zero email deliveries;
- public HTTPS health/readiness reports rc15, schema17 and the exact commit;
- PostgreSQL reports 17 applied migrations, 46 public tables, five existing
  internal accounts and zero tenant/order/ledger/tenant-audit/email-delivery
  rows;
- one Worker is online, Scheduler heartbeat stayed current across multiple
  cycles, and the existing alert Outbox remained unchanged;
- public SaaS readiness reports `schedulerOnline=true`,
  `emailDeliveryConfigured=false` and `registrationEnabled=false`; therefore
  no external email attempt occurred.

## Release and recovery evidence

- release evidence:
  `/opt/backups/relay-release-evidence-95ddef50e11b`;
- release-manifest SHA-256:
  `2967acd64074a98cc23d91defa931357f8f819784618c1590f473270a7bc1cea`;
- CycloneDX production SBOM SHA-256:
  `0049979b5f6090c3a3bb4908aa79665771049b497c090c446a2c29bf49c6817f`;
- final backup:
  `/opt/backups/relay-email-outbox-final-20260830043033`;
- every listed checksum, control-plane dry-run, independent Git bundle and
  object-media manifest passed;
- isolated PostgreSQL restore matched schema17, 46 tables, 15
  `information_schema` trigger rows, 17 migrations, five accounts, one alert,
  one alert delivery and zero tenant/order/ledger/audit/email rows;
- restored object media matched 96 files / 45,849,211 bytes exactly; the
  temporary restore database and staging directory were removed.

## Activation remains pending

No email provider, receiver URL or signing secret was fabricated. Before
public registration, the operator must configure a real provider-backed HTTPS
receiver and dedicated secret, verify all three templates, constant-time
signature/timestamp validation, stable-ID duplicate handling, 5xx recovery,
expiry/supersession and secret rotation, then record independently reviewed
launch evidence. `RELAY_SECRETS_KEY` remains an external root secret and is not
an ordinary database configuration item.
