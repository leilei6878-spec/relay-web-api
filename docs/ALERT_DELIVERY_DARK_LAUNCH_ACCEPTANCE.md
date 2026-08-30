# Durable alert delivery dark-launch acceptance

Date: 2026-08-30 (Asia/Shanghai)

## Release

- version: `0.10.0-rc14`
- schema: `16`
- runtime/source/deployment commit:
  `deafdb92b5192271a28965720b048ea157650c17`
- production remains fail-closed dark launch

## Delivered

- PostgreSQL Outbox for stable `opened` and `resolved` alert events;
- exponential retry capped at 60 minutes, five-minute configuration recheck,
  two-minute crash claim recovery and PostgreSQL conditional single winner;
- fast recovery supersedes an unseen opening instead of sending a meaningless
  resolved event;
- canonical payload SHA-256 verified before every attempt;
- secret/email/IP/token-shaped alert details removed or redacted;
- dedicated versioned 32+ character alert HMAC secret and fixed signed
  connection test;
- `X-Relay-Event-Id`, timestamp and HMAC-SHA256 request contract;
- commercial readiness blockers for unsigned alert delivery and an offline
  scheduler;
- administrator-MFA manual retry, delivery state/attempt/error UI and delivery
  backlog metrics;
- resolved alert/delivery cascade under bounded operational retention;
- dedicated, portless Scheduler service for commercial monitor, provider
  Canary, plan renewal, retention, account checks/analytics and inspection
  cleanup; Gateway-local background timers are disabled;
- 30-second database heartbeat used as the scheduler health authority.

## Verification

- Relay tests: 329 passed;
- commercial tests: 66 passed;
- CI operations/security/recovery/scheduler tests: 35 passed, two Windows-only
  symlink cases skipped and passed in Linux;
- template/backup/release/scheduler tests: 117 passed, two Windows-only symlink
  cases skipped;
- tests cover signed raw body, stable ID, secret non-disclosure, HTTP retry,
  backoff suppression, manual retry, recovery delivery, fast supersession,
  expired-claim recovery, concurrent single winner, payload tamper rejection,
  durable sanitisation, retention cascade, task isolation and schedule cadence;
- browser QA verified the versioned HMAC Secret setting, durable Outbox copy,
  manual retry action and success notification with zero console errors;
- TypeScript, ESLint, production application build, migration round-trip,
  secret scan, release manifest and production dependency audit passed; audit
  found zero known vulnerabilities.

## Production evidence

- pre-deploy backup:
  `/opt/backups/relay-pre-alert-outbox-20260830105555`;
- the first backup-runner attempt failed closed because of an invalid explicit
  `pg_dump` path; its `complete=false` directory was deleted after the corrected
  backup and dry-run passed;
- isolated schema-15 restore plus migration16 rehearsal produced schema 16,
  45 tables, one existing alert, zero deliveries and the due index;
- pinned PostgreSQL/Redis/MinIO containers were recreated without deleting
  volumes; five accounts and all 96 objects / 45,849,211 bytes remained exact;
- public health reports rc14/schema16/exact commit; source HEAD and
  `.deploy-rev` match;
- dedicated Scheduler remains running with no inherited HTTP healthcheck;
  heartbeat age and alert `last_seen_at` were both observed at four seconds
  after multiple cycles;
- public readiness reports `schedulerOnline=true` and
  `alertDeliveryConfigured=false`;
- the current alert has one durable `opened|not_configured|0` delivery with
  `ALERT_WEBHOOK_NOT_CONFIGURED`, proving no network attempt was made;
- commercial, registration, payment, live Canary and customer-MFA gates remain
  disabled; one Worker is online and fatal log scan is clean.

## Release and recovery evidence

- release evidence: `/opt/backups/relay-release-evidence-deafdb92b519`;
- release-manifest SHA-256:
  `eae93abccddf4ec70e9b73a25b9ef084ec831fa93a31e15238033c9c38d0e8d5`;
- production SBOM SHA-256:
  `b57dd774f3930b92b5489da769e5f75050f05cf88ba404b4e69e3d5bad4e9f40`;
- final recovery backup:
  `/opt/backups/relay-alert-outbox-final-20260830113151`;
- isolated PostgreSQL restore matched schema 16, 45 tables, eight triggers,
  five accounts, zero tenant/order/ledger/audit/config rows, one alert, one
  delivery and one scheduler heartbeat;
- 231 required storage files, complete Git Bundle and 96 objects / 45,849,211
  bytes passed checksum/content restore; temporary database/directories were
  removed.

## Activation remains pending

No real receiver URL or signing secret was fabricated. Before public charging,
activate a reviewed secret and public HTTPS endpoint, verify constant-time
receiver signature/timestamp checks, duplicate-ID 2xx behavior and both
opened/resolved delivery, then record independently reviewed `alert_delivery`
launch evidence and an external uptime-probe result.

