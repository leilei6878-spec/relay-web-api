# Administrator security dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Release

- version: `0.10.0-rc8`
- schema: `12`
- runtime commit: `c742685d2114e987e205f520c037dfb330861a80`
- production remains fail-closed dark launch

## Delivered

- random `as-relay-*` browser sessions instead of placing the long-lived
  `ad-relay-*` root token in a cookie;
- SHA-256-only session lookup, hashed IP/User-Agent audit fingerprints, fixed
  1–24 hour expiry, revocation and logout;
- `HttpOnly`, `SameSite=Strict` and production `Secure` cookies;
- TOTP verification and versioned encrypted administrator security settings;
- explicit administrator MFA and valid TOTP blockers in commercial readiness;
- MFA-aware guards on commercial operations, commercial configuration, launch
  evidence and live provider Canary routes;
- per-process plus Redis-backed distributed administrator login throttling;
- production remote root-token login and Bearer use disabled by default;
  direct loopback recovery rejects forwarded/proxied requests;
- an acknowledgement-gated one-time MFA secret/otpauth generator that never
  writes the value to disk;
- server-side logout audit and a visible desktop/mobile logout action.

## Verification

- Relay tests: 308 passed;
- operations, migration and security tests: 21 passed;
- template/backup/restore tests: 103 passed;
- commercial tests: 50 passed;
- TypeScript, ESLint, production build, generated diff, post-commit secret scan
  and production dependency audit passed; dependency audit found zero known
  vulnerabilities;
- PostgreSQL rehearsal applied `0001` through `0012` and verified the session
  table, active-session index and schema 12;
- unit/integration tests prove raw tokens are absent from database/audit,
  legacy root-token cookies fail, MFA is enforced, logout revokes, expired
  sessions fail, and remote root-token exchange is denied;
- browser QA verified the Administrator Security config group, logout action,
  username/password/TOTP-only login form and short-session security copy.

## Production evidence

- `/healthz` reports `0.10.0-rc8`, schema 12 and the exact runtime commit;
- anonymous administrator session request: HTTP 401;
- public root Bearer request: HTTP 401;
- direct loopback root Bearer request: HTTP 200;
- direct loopback recovery created a short `as-relay-*` session with
  `authMethod=recovery_token` and `mfaVerified=true`;
- the database contained one 64-character token hash, zero raw-token matches
  and no raw Cookie column;
- logout returned HTTP 200 and the same Cookie immediately returned HTTP 401;
- the QA session row was then precisely removed; production has zero
  administrator sessions;
- MFA, commercial, registration and remote-root overrides remain explicitly
  disabled for dark launch;
- readiness reports `adminMfaRequired=false`,
  `adminMfaConfigured=false`, `enabled=false` and `ready=false`;
- five internal web accounts remain present and commercial tenants/orders are
  still zero;
- Gateway is healthy, Worker is online and deployment logs contain no fatal,
  uncaught, unhandled or migration errors.

The current administrator password hash and root recovery token were preserved.
Existing legacy browser Cookies were intentionally invalidated; operators must
log in again with the configured username/password.

## Recovery proof

Backup: `/opt/backups/relay-admin-security-final-20260829123632`

- archive/configuration SHA-256 checks passed;
- PostgreSQL custom dump restored into an isolated database and exactly
  matched production;
- restored schema: 12; public tables: 42; distinct immutable triggers: 6;
- restored accounts: 5; administrator sessions: 0;
- evidence/sandbox/configuration/tenant/order/ledger rows: 0;
- filesystem storage: 272 files; MinIO snapshot: 151 files;
- complete Git Bundle cloned and `git fsck --full` verified at the runtime
  commit;
- temporary database and extraction directories were removed.

## Activation remains pending

No TOTP secret was generated or fabricated during dark launch. Before public
charging, an authorized operator must enroll a real authenticator, activate
the encrypted secret/config version, open the deployment MFA hard gate, verify
a fresh MFA login and loopback recovery, and record genuine acceptance
evidence. Remote root-token overrides must remain disabled.
