# Commercial SaaS completion audit

Date: 2026-08-30 (Asia/Shanghai)

This document evaluates the original public paid SaaS objective against current
code, automated tests and production evidence. A requirement is not marked
complete when only design intent or a narrow test exists.

## Current release

- production version: `0.10.0-rc18`
- schema: `18`
- runtime commit: `9146eccd33036752e1a53bf4d4029c0f7809fa27`
- deployment mode: dark launch; registration, commercial traffic, payment and
  tax modes are disabled

## Requirement-by-requirement evidence

| Requirement | Evidence | Audit result |
|---|---|---|
| Commercial traffic uses only official/authorized upstreams | `commercial-gateway.ts` resolves only `openai:`, `google:`, `vertex:` and `leonardo:` official models; route-order tests prove the branch executes before web-account selection | Code complete; real upstream production calls blocked by missing contracts/credentials |
| Existing web pool remains internal | Separate `sk-relay-*` and `sk-saas-*` principals; commercial gateway has no Worker/account selector import | Complete |
| Tenants, users, RBAC and MFA | SQL tenant/user/membership/session/invite schema; owner/admin/billing/developer/viewer gates; session-level TOTP proof, bounded freshness, atomic one-time recovery and privileged mutation step-up | Complete in code/dark launch; real privileged-user enrollment pending |
| Hash-only tenant API keys | 256-bit one-time secret, SHA-256 lookup, hints-only listing, revocation and tenant scoping tests | Complete |
| Plans and limits | Plan features intersect key scopes/models; disjoint model sets deny all; plan/key RPM, concurrency, daily and monthly limits; customer/admin next-period changes; hash-bound plan-review evidence | Complete |
| Monthly billing periods | Unique append-only UTC periods atomically debit monthly fee, expire old credit, grant new credit, snapshot plan and append balanced ledger; hourly retry/monitoring and concurrent replay tests | Complete |
| Prepaid balance and idempotent orders | Refundable cash and non-refundable included credit use separate balances/holds; included-first usage split; row locks, manual/Stripe orders and provider/request/period idempotency | Complete |
| Immutable usage/funds ledger | Append-only transaction/entry triggers, equal-and-opposite entries, tax/cash/wallet settlement and replay tests | Complete |
| Token/image/model pricing | Versioned price book, integer minor-unit calculation, authoritative provider usage/count settlement | Complete in code; live provider pricing still absent |
| Customer self-service and commercial admin UI | Login/register/reset/verification, keys, balance, usage, members, Checkout; tenant/price/order/refund/dispute/admin controls; browser QA | Complete |
| Official provider adapters and sandbox | OpenAI, Gemini API, Vertex AI and Leonardo request/usage adapters; every active provider requires its own current credential; cost-capped sandbox; append-only content-minimising provider/model/capability/currency Live evidence | Code and dark-launch acceptance complete; live Canary acceptance still requires contracts, credentials and reviewed prices |
| Tenant data isolation | Tenant-bound sessions/keys, tenant-filtered history/usage and no commercial exposure of account/Worker/proxy topology | Complete |
| CSRF/Origin, network identity and session security | Customer HttpOnly/Secure cookies, CSRF double submit and session-level fresh MFA for high-risk mutations; trusted Origin checks; one explicit edge-overwritten client-IP header with competing-header rejection and production fail-closed readiness; administrator SHA-256-only short sessions, Strict cookies, revoke/logout, distributed login throttle and loopback-only root recovery | Complete |
| Administrator MFA | Versioned encrypted TOTP, password+TOTP login, MFA-aware commercial administration guards and readiness blockers | Code/dark-launch complete; real authenticator enrollment intentionally pending |
| Audit, privacy and retention | Append-only tenant mutation and legal-acceptance records; legal versions bind exact public content bundle SHA-256 and HMAC-only network evidence; explicit registration/invite consent commits atomically with account activation; no fabricated backfill or legal-record deletion; secret/email redaction; encrypted customer-email payload scrubbing; public recovery shape/timing equalization; tenant-isolated/platform views and non-deleting billing/tenant-audit policy | Complete |
| Monitoring and alerting | Dedicated scheduler heartbeat; Worker/failure/balance/reservation/payment/refund/dispute/evidence/plan-period/provider-credential/exact-Canary/incomplete-tenant-audit signals; separate durable alert and encrypted customer-email Outboxes; HMAC, payload hash, crash claim, backoff/manual retry, delivery metrics/state and retention | Complete in code and production dark launch; real signed alert/email receivers and external uptime probe not configured |
| Payment/tax/refund/dispute | Raw Stripe signature verification, exact identity/amount/currency checks, cumulative single-line partial-tax allocation, ambiguous external refund rejection, idempotent balanced settlement and dispute fund events | Complete in code; live Stripe/Tax export drill not possible without merchant configuration |
| Versioned commercial configuration | Fixed catalog including legal operator/contact/document versions/effective date and independently rotatable tenant-audit, alert/email delivery HMAC keys; encrypted hint-only secret versions, signed fixed connection tests, atomic activation/rollback, hard launch gates, audit and SSRF-resistant Webhooks | Complete |
| External launch evidence | Append-only, SHA-256-bound, independently reviewed and expiring evidence for provider rights, model prices, canonical plan snapshots, legal/tax, live payments, email, HA, offsite restore, alerts, load, soak and CI; readiness/Checkout fail closed | Complete in code and dark-launch production; genuine external evidence is intentionally absent |
| CI/CD release gates | Full-history workflow runs tests/type/lint/build/audit; pinned Actions/images; schema/17-migration and exact-commit contract; production CycloneDX SBOM; commit/tree/file hashes and root release-manifest digest; commit-named retained artifact | Gate passed locally and on production; authoritative GitHub execution still unavailable while push is denied |
| HA production topology | Versioned contract requires 2 Gateways, 2 Workers, managed multi-AZ PostgreSQL/Redis and replicated object storage | Not deployed; current host is one Gateway, one Worker and one VPS data plane |
| Offsite backup and recovery | Opt-in PostgreSQL-16/Node/Git/`mc` runner; complete Git check; S3 object path/size/SHA-256 manifest; upload then remote re-download/byte verification; root manifest digest; standalone downloaded-snapshot verifier; same-host isolated full restore drill below | Tooling and same-host recovery proven; distinct-account/region target and genuine offsite restore evidence missing |
| Production deployment and acceptance | HTTPS runtime reports exact release/schema; schema18, dedicated scheduler, alert/email Outboxes and immutable legal acceptance ledger; public legal metadata remains explicitly unconfigured/unapproved; remote-root denial, MFA, plan-period, provider and tenant-audit probes, hard gates and zero unintended tenant/financial/email/legal rows verified | Dark launch complete; public charging deliberately disabled |

## Final recovery drill

Latest accepted backup:
`/opt/backups/relay-legal-acceptance-final-20260831025159`

The first rc10 environment update contained an incorrect full commit suffix.
Independent Git-bundle validation detected it; the Gateway was rebuilt from
`git rev-parse HEAD`, and runtime, `.deploy-rev` and source now match exactly.
The rc10 pre-correction backup remains excluded; the current backup above also
passed the exact-identity check.

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
- restored schema: 18;
- restored public tables: 47;
- restored accounts: 5;
- restored administrator sessions: 0;
- restored plans: 2; plan periods: 0;
- `information_schema` trigger rows: 16;
- restored evidence/sandbox/configuration/tenant/order/ledger/tenant-audit/legal-acceptance rows: 0;
- restored alert/delivery/email/scheduler rows: 1 / 1 / 0 / 1;
- required filesystem storage manifest: 231 files;
- MinIO S3 API export: 102 objects / 46,172,450 bytes, restored with an exact
  per-object SHA-256 manifest;
- independent Git clone/fsck and exact HEAD comparison: pass;
- temporary database and restore directories removed after the drill.

The tenant-audit drill rejected an initial raw online MinIO-volume archive
because live metadata and archive file counts diverged. That unaccepted file
was removed and replaced with the authoritative bucket-level `mc mirror`
export above; the accepted checksum list does not include the raw volume file.

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
