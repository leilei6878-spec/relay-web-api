# Tenant privileged-mutation audit

Release `0.10.0-rc13` adds a dedicated, tenant-scoped audit trail for customer
control-plane mutations. It is separate from the short-lived operational
`relay_commercial_audit` table and from the immutable billing ledger.

## Covered operations

The following authenticated routes write a `started` event before the business
operation and a `succeeded` or `failed` terminal event afterwards:

- API key creation and revocation;
- member invitation, role changes and enable/disable changes;
- Stripe Checkout creation, manual recharge creation and scheduled plan changes;
- customer TOTP enrollment start/confirmation;
- SaaS session logout.

Every event carries the tenant, actor user/role, session, operation, request,
action, target, outcome and timestamp. A unique `(operation_id, outcome)` index
prevents duplicate phases. A database trigger rejects every update or delete.

## Privacy and secret handling

- Raw IP addresses and User-Agent strings are never stored. They are HMAC-SHA256
  values so repeated activity can be correlated without exposing the source.
- Password, token, Cookie, Authorization, credential, API-key, email, IP and
  User-Agent fields are removed. Secret-shaped strings and email addresses in
  nested values are replaced with `[REDACTED]`.
- User-controlled target identifiers outside the safe identifier alphabet are
  replaced with an HMAC. Detail JSON is bounded to 8 KiB.
- API key secrets, TOTP secrets/recovery codes, Checkout URLs and email invite
  tokens are not passed to the audit writer.

The HMAC key resolves in this order: active versioned
`security.auditHashKey`, deployment `RELAY_AUDIT_HASH_KEY`, then the existing
`RELAY_SECRETS_KEY`. Production rejects a high-risk mutation before it starts
if the resolved key is shorter than 32 characters. Key rotation is supported;
rotating it intentionally starts a new correlation epoch.
Commercial readiness exposes only the boolean `tenantAuditConfigured` and
blocks launch when the key is missing or too short; key material is never
returned.

## Failure and monitoring semantics

The durable `started` write is a fail-closed gate. If configuration or the first
write is unavailable, the mutation does not run and the route returns 503. If a
business operation fails, the original safe error is returned and the audit
records `failed` where possible.

If the business operation completes but the terminal audit write fails, the
business result is still returned. This avoids converting a completed payment
or external operation into a retry that could duplicate side effects. The
persisted `started` event remains unambiguous evidence of an incomplete audit;
after five minutes the commercial monitor raises the critical
`TENANT_AUDIT_INCOMPLETE` signal.

## Access and retention

Tenant Owner/Admin sessions can read only their tenant through
`GET /api/saas/audit`; the customer portal shows the same bounded history.
Platform administrators receive a bounded cross-tenant view in Commercial
Operations. All responses use `Cache-Control: no-store`.

Application retention never updates or deletes `relay_tenant_audit_events`.
Database backups therefore include the complete trail. Production archive or
expiry after the legally approved retention period must use a separately
reviewed privileged database procedure; application code provides no trigger
bypass. Because the table contains only pseudonymous identifiers
and bounded metadata, raw network and credential data are not retained with it.

## Verification

`tenant-audit.test.ts` proves:

- success/failure phases and terminal target correlation;
- HMAC-only network identity and nested secret/email redaction;
- update/delete rejection;
- tenant-isolated reads and bounded query limits;
- detectable terminal-write loss without duplicate business retries;
- route coverage and the absence of application retention deletion.

`commercial-operations.test.ts` proves the critical incomplete-operation alert.
