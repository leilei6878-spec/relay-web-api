# Exact official-provider readiness dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Release

- version: `0.10.0-rc10`
- schema: `13`
- runtime commit: `43d8185d38e8deed0b78210734766139936f82df`
- production remains fail-closed dark launch

## Delivered

- every provider referenced by an active price must have its own currently
  effective credential; an unrelated provider credential cannot satisfy the
  gate;
- readiness exposes active providers and exactly which provider credentials
  are missing, without exposing secret values;
- Canary evidence now matches provider, model, capability and currency and
  explicitly requires `mode=live`;
- monitoring uses the configured 1–168 hour Canary age rather than a hardcoded
  24 hours;
- durable `PROVIDER_CREDENTIAL_MISSING` and exact Live Canary alerts;
- removing a credential immediately blocks readiness even while an earlier
  Canary remains within its age window.

## Verification

- Relay tests: 316 passed;
- commercial tests: 57 passed;
- operations, migration and security tests: 21 passed;
- template, backup and restore tests: 103 passed;
- TypeScript, ESLint, production build, generated diff, post-commit secret scan
  and production dependency audit passed; dependency audit found zero known
  vulnerabilities;
- tests prove a Leonardo route is blocked when only OpenAI is configured,
  credential removal overrides an old passing Canary, USD evidence cannot
  satisfy CNY, and the database rejects non-Live sandbox mode;
- monitoring tests verify the missing-provider alert.

## Production evidence

- `/healthz` reports `0.10.0-rc10`, schema 13 and the exact runtime commit;
- public readiness reports `activeProviders: []`,
  `missingProviderCredentials: []`, zero active prices/Canaries, 11 missing
  launch requirements, `enabled: false` and `ready: false`;
- production retains zero commercial tenants, prices, Canary rows, periods,
  orders and ledger transactions; all five internal web accounts remain;
- Gateway is healthy, Worker is online and deployment logs contain no fatal,
  uncaught, unhandled or migration errors.

## Release identity correction

The first rc10 environment update used the correct short prefix but an
incorrect full commit suffix. The image content was the intended source, but
`/healthz` was not an exact source identity and therefore was not accepted.
Independent backup Git verification exposed the mismatch.

The deployment was rebuilt using `git rev-parse HEAD`; `/healthz`, `.deploy-rev`
and server Git HEAD now match exactly at the commit above. The pre-correction
backup remains historical but is not cited as final recovery evidence.

## Recovery proof

Accepted backup:
`/opt/backups/relay-provider-readiness-corrected-20260829135821`

- source HEAD equals `.deploy-rev` before backup;
- all archive/configuration SHA-256 checks passed;
- PostgreSQL custom dump restored into an isolated database and exactly
  matched production;
- restored schema: 13; public tables: 43; immutable triggers: 7;
- restored accounts: 5; plans: 2;
- plan periods/prices/Canaries/evidence/tenants/orders/ledger rows: 0;
- filesystem storage: 272 files; MinIO snapshot: 163 files;
- complete Git Bundle independently cloned and `git fsck --full` verified at
  the exact runtime commit;
- temporary database and extraction directories were removed.

## External acceptance remains pending

No provider credential or price is configured. Authorized operators must add
official credentials, publish independently reviewed prices, run every exact
provider/model/capability/currency Canary, record provider-rights evidence and
verify zero missing provider credentials before commercial enablement.
