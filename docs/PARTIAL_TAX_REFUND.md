# Partial refunds for Stripe Checkout automatic tax

Relay creates one Stripe Checkout line item representing refundable wallet
credit. Stripe calculates tax on that hosted Checkout Session. A refund of the
associated Checkout charge is already reflected in Stripe Tax reporting, so
Relay must not also create a custom Tax Transaction reversal.

Official references:

- https://docs.stripe.com/tax/reports
- https://docs.stripe.com/api/refunds/create
- https://docs.stripe.com/tax/checkout

## Deterministic allocation

The administrator enters the net wallet credit to reverse. Relay computes the
tax portion from cumulative refunded credit, not independently per request:

```text
target_refunded_tax = floor(original_tax * target_refunded_credit / original_credit)
this_refund_tax = target_refunded_tax - already_refunded_tax
Stripe refund amount = credit + this_refund_tax
```

The final remaining credit absorbs all residual tax cents. Therefore one full
refund and any partition of partial refunds finish with exactly the same net,
tax and gross totals. Allocation version
`checkout_cumulative_proportional_v1` is stored on every refund row.

Before the Stripe call, Relay reserves only refundable cash credit, not plan
credit or tax. The returned Refund ID and gross amount must match the stored
request. Successful settlement reverses tenant wallet, tax payable and external
cash with an equal-zero immutable ledger transaction.

## External Dashboard refunds

Stripe refund Webhooks contain gross amount but no tax breakdown. Relay
inverts the cumulative single-line formula with a bounded binary search. The
event is accepted only when one exact net/tax allocation maps to the gross
amount. A cent value that falls into a rounding gap is rejected as
`STRIPE_REFUND_TAX_ALLOCATION_AMBIGUOUS`; no wallet or ledger mutation occurs.

This fail-closed rule avoids guessing the tax portion of arbitrary Dashboard
refunds. Operators should initiate partial refunds through Relay whenever
possible and reconcile a rejected external refund before issuing another.

## Acceptance boundary

The arithmetic and idempotency are fully tested, but a real test-mode and
minimum-value live Stripe Tax partial-refund drill remains required. The drill
must compare Relay net/tax/gross ledger totals with Stripe Tax exports and be
recorded as `payment_acceptance` evidence before public charging.
