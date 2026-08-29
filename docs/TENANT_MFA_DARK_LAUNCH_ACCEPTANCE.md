# Tenant privileged-session MFA dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Release

- version: `0.10.0-rc12`
- schema: `14`
- runtime commit: `192c99f2f145917d837fabad93feaa01f6393758`
- production remains fail-closed dark launch

## Delivered

- `mfa_verified_at` on every SaaS session rather than trusting only the user's
  account-level `mfa_enabled` flag;
- TOTP and one-time recovery-code logins create verified sessions;
- confirming enrollment verifies only the current session, leaving older
  sessions unverified;
- atomic SHA-256 recovery-code consumption: two concurrent uses yield exactly
  one successful session;
- configurable 1–168 hour MFA freshness (default 24); stale sessions require a
  new login;
- deployment + versioned-config hard gate for privileged customer MFA;
- automatic enforcement whenever commercial mode is enabled;
- Owner/Admin/Developer API-key mutations, Owner/Admin/Billing billing/plan
  mutations and Owner/Admin membership mutations require role + trusted Origin
  + CSRF + fresh session MFA;
- MFA never upgrades a role and read-only Portal access remains available for
  enrollment/recovery guidance;
- customer login UI accepts either six-digit TOTP or a recovery code, and the
  Portal warns when the current privileged session lacks step-up proof.

## Verification

- Relay tests: 319 passed;
- commercial tests: 60 passed;
- operations, migration and security tests: 21 passed;
- template, backup and restore tests: 103 passed;
- TypeScript, ESLint, production build, generated diff, post-commit secret scan
  and production dependency audit passed; dependency audit found zero known
  vulnerabilities;
- migration rehearsal proved legacy sessions receive NULL MFA proof and a
  verified session can store a timestamp;
- tests prove current-session enrollment, old-session rejection, 25-hour
  expiry under the 24-hour policy, concurrent one-time recovery consumption,
  TOTP login, CSRF and route wiring;
- browser QA verified the combined TOTP/recovery input and closed customer-MFA
  hard gate plus configurable freshness in Commercial Configuration.

## Production evidence

- `/healthz` reports `0.10.0-rc12`, schema 14 and the exact runtime commit;
- runtime, `.deploy-rev` and server Git HEAD match;
- public readiness reports `customerPrivilegedMfaRequired=false`, commercial
  and registration disabled, and `ready=false`;
- deployment gate is explicitly off and freshness is 24 hours;
- production contains zero SaaS sessions, tenants, orders and commercial
  ledger rows, so migration did not mark any legacy session as verified;
- five internal web accounts remain present;
- Gateway is healthy, Worker is online and deployment logs contain no fatal,
  uncaught, unhandled or migration errors.

## Recovery proof

Backup: `/opt/backups/relay-tenant-mfa-final-20260829145529`

- source HEAD equals `.deploy-rev` before backup;
- archive/configuration SHA-256 checks passed;
- PostgreSQL custom dump restored into an isolated database and matched
  production;
- restored schema: 14; public tables: 43; immutable triggers: 7;
- restored accounts: 5; SaaS sessions/tenants/orders/ledger/evidence: 0;
- filesystem storage: 272 files; MinIO snapshot: 175 files;
- complete Git Bundle cloned and `git fsck --full` verified at the runtime
  commit;
- temporary database and extraction directories were removed.

## Activation remains pending

There are no production SaaS users, so no authenticator or recovery code was
fabricated. Before public charging, privileged QA users must enroll real TOTP,
prove old-session and one-time recovery behavior, open both hard gates, verify
the configured freshness window and record independent acceptance evidence.
