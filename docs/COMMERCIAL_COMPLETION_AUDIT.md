# Commercial SaaS completion audit

Date: 2026-08-30 (Asia/Shanghai)

This document evaluates the original public paid SaaS objective against current
code, automated tests and production evidence. A requirement is not marked
complete when only design intent or a narrow test exists.

## Current release

- production version: `0.10.0-rc20`
- schema: `20`
- runtime commit: `24e0a94b79c44b007df06c8785d84b0b906aba39`
- deployment mode: dark launch; registration, commercial traffic, payment and
  tax modes are disabled

## Requirement-by-requirement evidence

| Requirement | Evidence | Audit result |
|---|---|---|
| Commercial traffic uses only official/authorized upstreams | `commercial-gateway.ts` resolves only `openai:`, `google:`, `vertex:` and `leonardo:` official models; route-order tests prove the branch executes before web-account selection | Code complete; real upstream production calls blocked by missing contracts/credentials |
| Existing web pool remains internal | Separate `sk-relay-*` and `sk-saas-*` principals; commercial gateway has no Worker/account selector import | Complete |
| Tenants, users, RBAC, MFA and legal re-consent | SQL tenant/user/membership/session/invite schema; owner/admin/billing/developer/viewer gates; TOTP proof and privileged step-up; stale legal bundles restrict normal session APIs while consent/logout remain reachable; Login/Portal redirect to explicit re-consent | Complete in code/dark launch; real privileged-user enrollment and reviewed re-consent drill pending |
| Hash-only tenant API keys | 256-bit one-time secret, SHA-256 lookup, hints-only listing, revocation and tenant scoping; paid keys fail until an active Owner/Admin accepts the exact current legal bundle | Complete |
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
| Audit, privacy and retention | Append-only tenant mutation/legal/privacy events; exact legal and export SHA-256 evidence; Owner-only single-snapshot portable export excluding credentials; configurable closure cooling-off/cancellation, atomic financial blockers, access revocation and selective pseudonymization; stale-legal and suspended-tenant restricted rights surface; no application deletion of billing/legal/tenant-audit/privacy evidence | Complete in code/dark launch; authenticated staging rights drill pending |
| Monitoring and alerting | Dedicated scheduler heartbeat; Worker/failure/balance/reservation/payment/refund/dispute/evidence/plan-period/provider-credential/exact-Canary/incomplete-tenant-audit signals; separate durable alert and encrypted customer-email Outboxes; HMAC, payload hash, crash claim, backoff/manual retry, delivery metrics/state and retention | Complete in code and production dark launch; real signed alert/email receivers and external uptime probe not configured |
| Payment/tax/refund/dispute | Raw Stripe signature verification, exact identity/amount/currency checks, cumulative single-line partial-tax allocation, ambiguous external refund rejection, idempotent balanced settlement and dispute fund events | Complete in code; live Stripe/Tax export drill not possible without merchant configuration |
| Versioned commercial configuration | Fixed catalog including legal operator/contact/document versions/effective date and independently rotatable tenant-audit, alert/email delivery HMAC keys; encrypted hint-only secret versions, signed fixed connection tests, atomic activation/rollback, hard launch gates, audit and SSRF-resistant Webhooks | Complete |
| External launch evidence | Append-only, SHA-256-bound, independently reviewed and expiring evidence for provider rights, model prices, canonical plan snapshots, legal/tax, live payments, email, HA, offsite restore, alerts, load, soak and CI; readiness/Checkout fail closed | Complete in code and dark-launch production; genuine external evidence is intentionally absent |
| CI/CD release gates | Full-history workflow runs tests/type/lint/build/audit; pinned Actions/images; contiguous schema/migration and exact-commit contract; production CycloneDX SBOM; commit/tree/file hashes and root release-manifest digest; commit-named retained artifact | Gate passed locally and on production; authoritative GitHub execution still unavailable while push is denied |
| HA production topology | Versioned contract requires 2 Gateways, 2 Workers, managed multi-AZ PostgreSQL/Redis and replicated object storage | Not deployed; current host is one Gateway, one Worker and one VPS data plane |
| Offsite backup and recovery | Opt-in PostgreSQL-16/Node/Git/`mc` runner; complete Git check; S3 object path/size/SHA-256 manifest; upload then remote re-download/byte verification; root manifest digest; standalone downloaded-snapshot verifier; same-host isolated full restore drill below | Tooling and same-host recovery proven; distinct-account/region target and genuine offsite restore evidence missing |
| Production deployment and acceptance | HTTPS runtime reports exact release/schema; schema20, dedicated Scheduler, privacy closure task, alert/email Outboxes, immutable legal/privacy evidence and legal/session/paid-key gates; public legal metadata remains unconfigured/unapproved; hard gates and zero unintended tenant/financial/email/legal/privacy rows verified | Dark launch complete; public charging deliberately disabled |

## Final recovery drill

Latest accepted backup:
`/opt/backups/relay-privacy-rights-final-20260831124220`

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
- restored schema: 20;
- restored public tables: 49;
- restored accounts: 5;
- restored administrator sessions: 0;
- restored plans: 2; plan periods: 0;
- `information_schema` trigger rows: 21;
- restored evidence/sandbox/configuration/tenant/order/ledger/tenant-audit/legal-acceptance/privacy rows: 0;
- restored alert/delivery/email/scheduler rows: 1 / 1 / 0 / 1;
- required filesystem storage manifest: 231 files;
- MinIO S3 API export: 104 objects / 48,523,532 bytes, restored with an exact
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
