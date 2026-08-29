# Plan periods, prepaid cash and included credit

Relay plans are wallet-funded calendar-month subscriptions. They do not create
a second Stripe subscription: customers first add cash through signed Stripe
Checkout, and each plan period is settled from that prepaid cash balance.

## Separate balances

- `balance_minor` is refundable customer cash; `reserved_minor` is its active
  usage hold.
- `included_balance_minor` is non-refundable plan credit;
  `included_reserved_minor` is its active usage hold.
- Usage reserves and consumes included credit first, then cash. A usage charge
  records total and included portions while the immutable ledger posts
  `tenant_included_credit`, `tenant_wallet` and `service_revenue` entries that
  sum to zero.
- Recharge refunds and disputes affect cash only. Plan credit can never be
  converted into a Stripe refund.

## Period settlement

`relay_plan_periods` is append-only and unique by tenant/period start. A single
atomic settlement:

1. locks the tenant;
2. applies a due pending plan change;
3. rejects rollover while usage reservations are active;
4. verifies plan/currency and prepaid cash for the monthly fee;
5. expires unused prior plan credit;
6. deducts the monthly fee and grants the new non-refundable included credit;
7. snapshots plan price, limits and features;
8. appends one balanced five-account ledger transaction.

The unique period row and billing idempotency key prevent duplicate monthly
fees or duplicate grants under concurrent Gateway/scheduler calls. An
insufficient wallet fails with `PLAN_RENEWAL_PAYMENT_REQUIRED`; no period,
credit or transaction is written.

The Gateway scheduler retries missing/due periods hourly. API reservation also
settles the period synchronously, so an unpaid tenant cannot bypass renewal by
racing the scheduler. Durable monitoring opens `PLAN_PERIOD_DUE`; repeated
failure audit is limited to one row per tenant per 24 hours.

## Plan changes

Owner/Admin/Billing users may schedule a plan from the customer portal, and an
administrator may do the same from Commercial Operations. Changes are stored
as `pending_plan_id` and take effect only at the next period boundary; there is
no silent mid-period proration. Selecting the current plan cancels a pending
change.

Every active plan generates a `plan_review` launch-evidence requirement whose
subject includes a canonical SHA-256 of plan ID, currency, monthly fee,
included credit, limits and features. Editing any of those fields invalidates
the prior review even if the plan ID is unchanged.

## Current limitations

Periods use UTC calendar months. Mid-period proration, annual billing and
provider-managed subscription schedules are intentionally unsupported. They
must not be simulated with manual balance edits; add a versioned billing policy
and balanced ledger workflow before offering them.
