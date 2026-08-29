# Official-provider sandbox dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Release

- version: `0.10.0-rc6`
- schema: `10`
- runtime commit: `9c9b4629a01d13704a114ee11882e0b7f03e54c8`
- page: `/commercial-sandbox`
- production mode: fail-closed dark launch

## Delivered

- an administrator-only live sandbox for OpenAI, Gemini, Vertex AI and
  Leonardo official API adapters;
- exact provider/model/capability/currency matching against an active price;
- an environment hard gate, an explicit `LIVE_COST_ACCEPTED` confirmation and
  a configurable maximum estimated charge before any upstream request;
- fixed low-volume chat and image probes, so the administrator cannot use this
  surface as an arbitrary prompt relay;
- content-minimising evidence: no prompt, generated text, generated image or
  raw upstream response is retained;
- append-only final evidence with provider, model, capability, sanitized usage,
  latency, upstream reference and pass/fail status;
- commercial readiness and critical monitoring blockers when an active route
  lacks a recent passing exact-match Canary;
- configurable evidence age and maximum charge values, while contracts,
  credentials, reviewed prices and launch approval remain external acceptance
  requirements rather than editable booleans.

## Automated evidence

- Relay tests: 295 passed;
- operations, migration and security tests: 21 passed;
- template, backup and restore tests: 101 passed;
- commercial tests: 46 passed;
- TypeScript, ESLint, production build, generated diff check, secret scan and
  production dependency audit: passed; dependency audit reported zero known
  vulnerabilities;
- migration rehearsal applied migrations `0001` through `0010` in a temporary
  PostgreSQL database and verified schema 10, the sandbox table, recent-run
  index and immutable evidence trigger.

## Production evidence

- `/healthz` reports `0.10.0-rc6`, schema 10 and the exact runtime commit;
- `/commercial-sandbox` returns HTTP 200;
- anonymous `/api/admin/provider-sandbox` returns HTTP 401;
- authenticated `/api/admin/provider-sandbox` returns HTTP 200;
- the production hard gate is explicitly
  `RELAY_ALLOW_LIVE_PROVIDER_CANARY=0`;
- maximum estimated charge is 100 minor units and evidence maximum age is 24
  hours;
- sandbox evidence rows, active prices, configuration versions, commercial
  tenants, orders and billing transactions are all zero;
- the five existing internal web accounts remain present;
- one Gateway and one Worker are online, the Gateway is healthy and the first
  five minutes after deployment contained no fatal, uncaught, unhandled or
  migration errors.

No live provider request was made and no provider fee was incurred during this
dark-launch acceptance.

## Recovery proof

Backup: `/opt/backups/relay-commercial-sandbox-final-20260829105847`

- all archive and configuration SHA-256 checks passed;
- PostgreSQL custom dump restored into an isolated database;
- live and restored database signatures matched exactly;
- restored schema: 10;
- restored public tables: 40;
- restored accounts: 5;
- distinct immutable billing, payment, configuration and sandbox triggers: 5;
- sandbox/configuration/tenant/order/ledger rows: 0;
- filesystem storage extraction: 272 files;
- MinIO volume extraction: 169 files;
- complete Git bundle independently cloned and `git fsck --full` verified at
  the exact runtime commit;
- the temporary database and extraction directories were removed.

## Remaining acceptance gates

Public charging remains disabled. Activation still requires official
commercial rights and production credentials, reviewed active prices, a
passing live Canary for every active provider/model/capability route, live
Stripe and tax/legal acceptance, production email and alerts, HA data-plane
capacity, distinct-account offsite recovery, GitHub release authority,
concurrency acceptance and a production soak.
