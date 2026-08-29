# Commercial payments dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Decision

The Stripe payment control plane is deployed to production in fail-closed dark
launch. No public registration, Checkout or paid API traffic is enabled.

Runtime identity:

- version: `0.10.0-rc2`
- schema: `8`
- implementation commit: `5843b60fb27dea5c209f95054787f87811f3b5d0`
- production URL: `https://relay.38.175.201.137.nip.io`

Production gates remain:

- `RELAY_COMMERCIAL_ENABLED=0`
- `RELAY_SAAS_REGISTRATION_ENABLED=0`
- `RELAY_PAYMENT_PROVIDER=disabled`
- `RELAY_TAX_MODE=unconfigured`
- `RELAY_LEGAL_APPROVED=0`

## Delivered payment controls

- server-created Stripe Checkout Sessions with internal order/tenant metadata
  and Stripe idempotency keys;
- raw-body timestamped HMAC verification with constant-time comparison and a
  five-minute replay window;
- provider-event deduplication without retaining raw Stripe payloads or card
  data;
- exact tenant, order, PaymentIntent, Checkout Session, currency, subtotal,
  tax and gross-total validation before wallet credit;
- one idempotent immutable settlement for separate wallet credit, tax payable
  and external cash entries;
- refunds reserve wallet credit before the Stripe call, release it on failure,
  and reverse wallet/tax/cash entries on success;
- taxed orders fail closed on partial refund until an authoritative Stripe Tax
  partial-reversal workflow is added; full remaining refunds are supported;
- external/Dashboard refunds reconcile through the unique PaymentIntent;
- dispute creation suspends the tenant; funds-withdrawn and
  funds-reinstated events append idempotent ledger transactions;
- manual server-side Checkout reconciliation in Commercial Operations;
- stuck Checkout, payment event, refund settlement and open-dispute alerts;
- short-lived Checkout URL cleanup and payment readiness/tax gates.

## Verification evidence

- Relay unit/integration tests: 281 passed.
- Multi-process, migration, secret-scan and operations tests: 21 passed.
- Template/backup/restore tests: 101 passed.
- Focused commercial tests: 32 passed.
- TypeScript, ESLint, production build and `git diff --check`: passed.
- Official production-dependency npm audit: 0 vulnerabilities.
- Browser QA passed for customer registration/portal, secure recharge dialog,
  fail-closed payment message and the administrator payment/refund/dispute UI.
- An isolated real PostgreSQL database on the production host applied
  migrations 0001 through 0008, reported schema 8, created payment/refund/
  dispute tables and installed the payment-identity trigger; the temporary
  database was then removed.
- Production `_migrations` contains `0008_commercial_payments.sql` and
  `relay_meta.schema_version=8`.
- Production health reports the exact version, schema and implementation
  commit above.
- Unsigned Stripe Webhook probe: HTTP 400 `INVALID_SIGNATURE`.
- Public registration probe: HTTP 503 `REGISTRATION_DISABLED`.
- Invalid `sk-saas-` model-discovery probe: HTTP 401.
- Authenticated commercial-administrator snapshot: HTTP 200.
- Production contains zero commercial tenants, orders, billing entries,
  payment events, refunds and disputes after deployment.
- All five pre-existing internal web accounts remain present: four Leonardo
  healthy and the same pre-existing ChatGPT account invalid.

The verified pre-migration backup is
`/opt/backups/relay-pre-payments-202608290753`. PostgreSQL, filesystem storage,
MinIO, deployment configuration, Caddy configuration and Git history were all
included and SHA-256 verified on the host.

## Still required before public charging

1. approved official upstream contracts and production credentials;
2. active, reviewed provider price-book rows;
3. Stripe live/restricted secret key and Webhook signing secret;
4. Stripe Webhook subscription including payment, refund and selection-required
   dispute funds events;
5. configured Stripe Tax, or a written tax/legal approval for the exact exempt
   sales scope;
6. production email delivery, counsel-approved legal documents and privacy/DPA;
7. two or more Gateways, two or more Workers and production-grade shared data
   services;
8. offsite backup configuration plus a successful isolated restore drill;
9. test-mode Checkout/payment/refund/dispute drills, then a separately approved
   minimum-value live payment/full-refund test;
10. 200 official-provider requests, concurrency acceptance and a 24-hour soak.

The commercial flag alone cannot bypass payment, tax, legal, pricing, provider,
replica, worker, Redis or offsite-backup readiness blockers.
