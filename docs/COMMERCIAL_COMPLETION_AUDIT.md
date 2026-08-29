# Commercial SaaS completion audit

Date: 2026-08-29 (Asia/Shanghai)

This document evaluates the original public paid SaaS objective against current
code, automated tests and production evidence. A requirement is not marked
complete when only design intent or a narrow test exists.

## Current release

- production version: `0.10.0-rc10`
- schema: `13`
- runtime commit: `43d8185d38e8deed0b78210734766139936f82df`
- deployment mode: dark launch; registration, commercial traffic, payment and
  tax modes are disabled

## Requirement-by-requirement evidence

| Requirement | Evidence | Audit result |
|---|---|---|
| Commercial traffic uses only official/authorized upstreams | `commercial-gateway.ts` resolves only `openai:`, `google:`, `vertex:` and `leonardo:` official models; route-order tests prove the branch executes before web-account selection | Code complete; real upstream production calls blocked by missing contracts/credentials |
| Existing web pool remains internal | Separate `sk-relay-*` and `sk-saas-*` principals; commercial gateway has no Worker/account selector import | Complete |
| Tenants, users, RBAC and MFA | SQL tenant/user/membership/session/invite schema; owner/admin/billing/developer/viewer gates; TOTP and recovery-code tests; browser portal QA | Complete |
| Hash-only tenant API keys | 256-bit one-time secret, SHA-256 lookup, hints-only listing, revocation and tenant scoping tests | Complete |
| Plans and limits | Plan features intersect key scopes/models; disjoint model sets deny all; plan/key RPM, concurrency, daily and monthly limits; customer/admin next-period changes; hash-bound plan-review evidence | Complete |
| Monthly billing periods | Unique append-only UTC periods atomically debit monthly fee, expire old credit, grant new credit, snapshot plan and append balanced ledger; hourly retry/monitoring and concurrent replay tests | Complete |
| Prepaid balance and idempotent orders | Refundable cash and non-refundable included credit use separate balances/holds; included-first usage split; row locks, manual/Stripe orders and provider/request/period idempotency | Complete |
| Immutable usage/funds ledger | Append-only transaction/entry triggers, equal-and-opposite entries, tax/cash/wallet settlement and replay tests | Complete |
| Token/image/model pricing | Versioned price book, integer minor-unit calculation, authoritative provider usage/count settlement | Complete in code; live provider pricing still absent |
| Customer self-service and commercial admin UI | Login/register/reset/verification, keys, balance, usage, members, Checkout; tenant/price/order/refund/dispute/admin controls; browser QA | Complete |
| Official provider adapters and sandbox | OpenAI, Gemini API, Vertex AI and Leonardo request/usage adapters; every active provider requires its own current credential; cost-capped sandbox; append-only content-minimising provider/model/capability/currency Live evidence | Code and dark-launch acceptance complete; live Canary acceptance still requires contracts, credentials and reviewed prices |
| Tenant data isolation | Tenant-bound sessions/keys, tenant-filtered history/usage and no commercial exposure of account/Worker/proxy topology | Complete |
| CSRF/Origin and session security | Customer HttpOnly/Secure cookies and CSRF double submit; trusted Origin checks; administrator SHA-256-only short sessions, Strict cookies, revoke/logout, distributed login throttle and loopback-only root recovery | Complete |
| Administrator MFA | Versioned encrypted TOTP, password+TOTP login, MFA-aware commercial administration guards and readiness blockers | Code/dark-launch complete; real authenticator enrollment intentionally pending |
| Audit, privacy and retention | Commercial audit rows, request/result redaction, session/check retention and non-deleting billing policy | Complete |
| Monitoring and alerting | Worker/failure/balance/reservation/payment/refund/dispute/evidence/plan-period/provider-credential/exact-Canary signals, durable deduplication and optional Webhook delivery | Complete in code; production alert receiver not configured |
| Payment/tax/refund/dispute | Raw Stripe signature verification, exact identity/amount/currency checks, idempotent settlement, full taxed refunds and dispute fund events | Complete in code; live Stripe/Tax drill not possible without merchant configuration |
| Versioned commercial configuration | Fixed catalog, encrypted hint-only secret versions, fixed official connection tests, atomic activation/rollback, hard launch gates, audit and SSRF-resistant Webhooks | Complete |
| External launch evidence | Append-only, SHA-256-bound, independently reviewed and expiring evidence for provider rights, model prices, canonical plan snapshots, legal/tax, live payments, email, HA, offsite restore, alerts, load, soak and CI; readiness/Checkout fail closed | Complete in code and dark-launch production; genuine external evidence is intentionally absent |
| CI/CD release gates | GitHub Actions workflow runs all tests, type/lint/build, audit and SBOM | Workflow complete; cannot run remotely while GitHub push is denied |
| HA production topology | Versioned contract requires 2 Gateways, 2 Workers, managed multi-AZ PostgreSQL/Redis and replicated object storage | Not deployed; current host is one Gateway, one Worker and one VPS data plane |
| Offsite backup and recovery | Offsite mirroring script plus fail-closed full-Git check; same-host isolated full restore drill below | Same-host recovery proven; distinct-account/region offsite target missing |
| Production deployment and acceptance | HTTPS runtime reports exact release/schema; schema 13, remote-root denial, short-session, plan-period and exact-provider probes, hard MFA/Canary/evidence gates and zero unintended commercial rows verified | Dark launch complete; public charging deliberately disabled |

## Final recovery drill

Latest accepted backup:
`/opt/backups/relay-provider-readiness-corrected-20260829135821`

The first rc10 environment update contained an incorrect full commit suffix.
Independent Git-bundle validation detected it; the Gateway was rebuilt from
`git rev-parse HEAD`, and runtime, `.deploy-rev` and source now match exactly.
Only the corrected backup above is accepted as current evidence.

The initial drill discovered that a bundle created from the server's historical
shallow clone was checksum-valid but not independently clonable. This is why a
checksum alone is insufficient recovery evidence. The bundle was replaced with
a complete local-history bundle, the server repository was safely converted to
a complete Git history, and `offsite-backup.mjs` was hardened to:

- reject shallow repositories;
- run `git fsck --full`;
- bundle only the current branch and tags (not unrelated remote refs);
- verify the bundle;
- clone it into an isolated directory, run another full fsck and compare HEAD.

The corrected backup then passed the complete drill:

- all SHA-256 checks: pass;
- PostgreSQL custom dump restored into an isolated database: pass;
- live/restored database signature comparison: pass;
- restored schema: 13;
- restored public tables: 43;
- restored accounts: 5;
- restored administrator sessions: 0;
- restored plans: 2; plan periods: 0;
- distinct immutable billing/payment/config/sandbox/evidence/plan-period triggers: 7;
- restored evidence/sandbox/configuration/tenant/order/ledger rows: 0;
- filesystem storage extraction: 272 files;
- MinIO volume extraction: 163 files at the latest drill;
- independent Git clone/fsck and exact HEAD comparison: pass;
- temporary database and restore directories removed after the drill.

## Unmet external acceptance conditions

The objective is not yet achieved as a publicly chargeable SaaS. The remaining
conditions require user/vendor/infrastructure authority that is not present in
this task environment:

1. written official API/commercial rights and production credentials;
2. reviewed active provider price rows;
3. Stripe merchant live/restricted key, signing secret and enabled event set;
4. Stripe Tax configuration or written exemption for the actual sales scope;
5. production email delivery and counsel-approved Terms/Privacy/DPA;
6. at least two Gateway and two Worker replicas on managed HA data services;
7. a distinct-account/region offsite backup destination and restore from that
   destination;
8. alert receiver and external uptime probe;
9. live payment/refund/dispute and official-provider sandbox acceptance;
10. 200-request concurrency acceptance and 24-hour production soak;
11. GitHub repository write permission so the release workflow can execute on
    the authoritative remote.
12. administrator authenticator enrollment, MFA hard-gate activation and
    independently reviewed acceptance evidence.

Commercial readiness must remain false until these conditions are supplied and
verified. Enabling a flag alone is not acceptance.
