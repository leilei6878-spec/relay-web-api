# Partial taxed Checkout refund dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Release

- version: `0.10.0-rc11`
- schema: `13`
- runtime commit: `29b5f564fb7ed2962caaeba1835822bff71a5752`
- production remains fail-closed dark launch

## Authoritative API boundary

Stripe documents that refunds of charges associated with Checkout Sessions
decrease reported Stripe Tax, while the Refund object contains gross amount but
no tax breakdown. Relay therefore does not create a second custom Tax
Transaction reversal for its automatic-tax Checkout charge.

References:

- https://docs.stripe.com/tax/reports
- https://docs.stripe.com/api/refunds/create
- https://docs.stripe.com/api/refunds/object

## Delivered

- cumulative proportional net/tax allocation for the single wallet-credit
  Checkout line;
- partition-invariant rounding with the final refund absorbing residual tax
  cents;
- customer/admin input remains net refundable wallet credit; Stripe receives
  the exact gross net-plus-tax amount;
- refund rows retain allocation version/source but no raw Stripe payload;
- refundable cash is reserved before the provider call; non-refundable plan
  credit is never refundable;
- Stripe Refund ID and gross amount must match before settlement;
- successful partial refunds reverse wallet, tax payable and external cash in
  one balanced immutable transaction;
- external/Dashboard gross refunds are inverted only when one exact allocation
  exists; rounding-gap amounts fail closed without wallet or ledger mutation;
- idempotent repeated partial/final refunds converge to exact original
  net/tax/gross totals;
- no custom Tax reversal endpoint exists in the implementation, preventing
  double tax-report reduction.

## Verification

- Relay tests: 318 passed;
- commercial tests: 59 passed;
- operations, migration and security tests: 21 passed;
- template, backup and restore tests: 103 passed;
- TypeScript, ESLint, production build, generated diff, post-commit secret scan
  and production dependency audit passed; dependency audit found zero known
  vulnerabilities;
- unit tests prove partition invariance, final-cent absorption and ambiguous
  gross rejection;
- integration tests run a 2,500 net + 250 tax order through 1,000/100 partial
  and 1,500/150 final refunds, verify cash reservations, exact Stripe gross
  requests, order totals, replay and zero-sum ledger;
- external refund Webhook tests reconcile gross 1,100 to net 1,000/tax 100 and
  reject an ambiguous gross amount with no balance mutation.

## Production evidence

- `/healthz` reports `0.10.0-rc11`, schema 13 and the exact runtime commit;
- runtime commit, `.deploy-rev` and server Git HEAD match;
- production contains zero commercial tenants, orders, refunds and billing
  transactions, so deployment made no financial or tax mutation;
- all five internal web accounts remain present;
- Gateway is healthy, Worker is online and deployment logs contain no fatal,
  uncaught, unhandled or migration errors.

## Recovery proof

Backup: `/opt/backups/relay-partial-tax-refund-final-20260829141946`

- source HEAD equals `.deploy-rev` before backup;
- archive/configuration SHA-256 checks passed;
- PostgreSQL custom dump restored into an isolated database and matched
  production;
- restored schema: 13; public tables: 43; immutable triggers: 7;
- restored accounts: 5; tenants/orders/refunds/ledger/evidence: 0;
- filesystem storage: 272 files; MinIO snapshot: 169 files;
- complete Git Bundle cloned and `git fsck --full` verified at the runtime
  commit;
- temporary database and extraction directories were removed.

## External acceptance remains pending

No Stripe credential or transaction was used. Before public charging, an
authorized operator must run a test-mode and minimum-value live automatic-tax
Checkout with multiple partial refunds, compare Relay net/tax/gross totals to
Stripe Tax exports, and record the result as independently reviewed
`payment_acceptance` evidence. Code tests alone are not tax acceptance.
