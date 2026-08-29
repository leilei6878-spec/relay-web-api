# Commercial SaaS Runbook

## Enablement checklist

1. Obtain written commercial/API rights for every enabled upstream.
2. Configure only official provider credentials.
3. Publish active price versions using the Commercial Operations page.
4. Deploy the HA contract: two Gateways, two Workers, managed multi-AZ
   PostgreSQL/Redis and versioned replicated object storage.
5. Configure and execute `scripts/offsite-backup.mjs`; restore the result in a
   separate environment.
6. Configure `RELAY_ALERT_WEBHOOK_URL` and an external HTTPS uptime probe.
7. Complete counsel review of terms/privacy/DPA; set `RELAY_LEGAL_APPROVED=1`.
8. Verify `/api/saas/readiness` returns `ready: true`.
9. Run the 200-request, 5×20 concurrency and 24-hour soak gates.
10. Only then set `RELAY_SAAS_REGISTRATION_ENABLED=1`.

## Billing incident

- Never edit `relay_billing_transactions` or `relay_billing_entries`; the DB
  will reject it.
- Correct mistakes with a new idempotent adjustment/refund transaction.
- `STALE_RESERVATION` means provider completion or settlement was interrupted.
  Inspect the official provider request before releasing or settling; never
  resend a paid image request without authoritative proof it did not submit.

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
