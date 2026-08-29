# Commercial SaaS Runbook

## Enablement checklist

1. Obtain written commercial/API rights for every enabled upstream.
2. Configure only official provider credentials.
   Vertex AI requires a dedicated service-account JSON with only the required
   `aiplatform.endpoints.predict` permission, its project ID and location.
3. Publish active price versions using the Commercial Operations page.
4. Configure `RELAY_PAYMENT_PROVIDER=stripe`, a live `STRIPE_SECRET_KEY` (or
   restricted live key) and `STRIPE_WEBHOOK_SECRET`. Register the exact HTTPS
   endpoint `/api/webhooks/stripe` for `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `refund.created`, `refund.updated`, `charge.dispute.created`,
   `charge.dispute.updated`, `charge.dispute.closed`,
   `charge.dispute.funds_withdrawn` and
   `charge.dispute.funds_reinstated`. The two funds events are selection-required
   Stripe events and must be explicitly enabled.
5. Set `RELAY_TAX_MODE=stripe_automatic` after configuring Stripe Tax, or use
   `approved_exempt` only with written tax/legal approval for the actual sales
   scope. The readiness gate rejects an unconfigured tax mode.
6. Deploy the HA contract: two Gateways, two Workers, managed multi-AZ
   PostgreSQL/Redis and versioned replicated object storage.
7. Configure and execute `scripts/offsite-backup.mjs`; restore the result in a
   separate environment.
8. Configure `RELAY_ALERT_WEBHOOK_URL` and an external HTTPS uptime probe.
9. Complete counsel review of terms/privacy/DPA; set `RELAY_LEGAL_APPROVED=1`.
10. Verify `/api/saas/readiness` returns `ready: true` and `paymentReady: true`.
11. Complete a test-mode Checkout/payment/refund/reconciliation drill, then a
    separately approved live-mode minimum-value transaction and refund.
12. Temporarily set `RELAY_ALLOW_LIVE_PROVIDER_CANARY=1`, run every exact active
    provider/model/capability route in `/commercial-sandbox`, then close the
    canary hard gate. Readiness must report `missingCanaries: 0`.
13. Run the 200-request, 5×20 concurrency and 24-hour soak gates.
14. Only then set `RELAY_SAAS_REGISTRATION_ENABLED=1`.

## Configuration and secret rotation

Use `/commercial-config` to create a new immutable version, run its fixed
connection test, then activate it. Do not overwrite an active secret. Keep the
previous vendor credential valid through the observation window so a tested
version rollback remains possible. Environment launch gates retain final veto.

Back up `RELAY_SECRETS_KEY` in the external secret manager; it is required to
decrypt versioned provider/payment secrets after a database restore.

## Billing incident

- Never edit `relay_billing_transactions` or `relay_billing_entries`; the DB
  will reject it.
- Correct mistakes with a new idempotent adjustment/refund transaction.
- `STALE_RESERVATION` means provider completion or settlement was interrupted.
  Inspect the official provider request before releasing or settling; never
  resend a paid image request without authoritative proof it did not submit.
- `PAYMENT_EVENT_STUCK` or `REFUND_SETTLEMENT_STUCK` requires comparing the
  order against Stripe, then using **服务端对账**. Never credit from a browser
  success URL, Dashboard screenshot or unverified payload.
- If a refund succeeded remotely but local settlement is pending, do not retry
  with a new idempotency key. Reconcile the existing refund first.
- A dispute immediately suspends its tenant. Funds-withdrawn and
  funds-reinstated events append idempotent reversal/restoration transactions;
  only an administrator may reactivate the tenant after reviewing the case.

## Tenant suspension

Set tenant status to `suspended` in Commercial Operations. New Session/API-key
authorization fails immediately. Existing official upstream requests may
finish; their reserved charge must still settle.

## Provider outage

Disable affected model prices (publish no replacement / retire active row) or
remove the model from tenant key allowlists. Do not fail over a paying tenant
to the web account pool.

## Backup and restore

Nightly host job:

```bash
cd /opt/relay
node scripts/offsite-backup.mjs /opt/backups
```

The command fails unless PostgreSQL, control-plane storage, Git and production
object media are copied to the configured offsite target and the remote
manifest can be read. Run a monthly restore in a separate project/account.

## Alerts

Critical: zero Worker, stale reservation, ≥25% short-window failures.
Warning: ≥10% failure rate or low/exhausted tenant wallet. Alert events remain
in PostgreSQL, deduplicate while open and resolve automatically after recovery.

## Stripe reconciliation

- Checkout creation uses one internal order ID as both Stripe metadata and the
  Stripe idempotency scope.
- A wallet is credited only after raw-body signature verification plus exact
  order, tenant, amount and currency matching.
- Payment events store hashes and provider IDs, never raw payloads or card data.
- The order stores wallet credit, tax and gross cash separately. Payment ledger
  entries balance tenant wallet + tax payable against external settlement;
  refunds reverse the same three accounts.
- Refunds reserve tenant credit before the Stripe API call. Successful refunds
  append an equal-and-opposite ledger transaction; failed calls release the
  reservation.
- Taxed orders currently allow full remaining refunds only. Partial taxed
  refunds fail closed until a Stripe Tax transaction-reversal workflow is
  explicitly implemented and reconciled; do not work around this with a manual
  balance edit.
- The commercial admin page can retrieve a Checkout Session from Stripe and
  idempotently reconcile it. This path uses the same settlement key as Webhook
  delivery, so it cannot double-credit the wallet.
