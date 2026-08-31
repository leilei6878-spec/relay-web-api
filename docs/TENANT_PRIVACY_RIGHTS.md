# Tenant privacy rights and closure

## Scope

The customer Portal and `/saas/privacy-center` expose an Owner-only privacy
center. Reading request history needs an authenticated session, but does not
require accepting a newer legal bundle. Creating an export, requesting closure
or cancelling closure additionally requires same-origin CSRF proof and a recent
MFA verification even while commercial traffic is dark. MFA enrollment and the
privacy center remain reachable during re-consent so the right is not
conditioned on accepting a new contract.

A suspended tenant is also allowed to reauthenticate into this restricted
rights surface. Its session remains invalid for service, billing, keys and
member APIs; Login and Portal route it to `/saas/privacy-center`. Closed tenants
cannot authenticate because closure revokes sessions and pseudonymizes any
exclusive user profile.

## Portable export

`POST /api/saas/privacy` with `action=export` produces a no-store JSON download
with schema `relay-tenant-export-v1`. The response supplies the exact payload
SHA-256 in `X-Relay-Export-SHA256`; the same digest, payload size and immutable
event are recorded without retaining a second copy of the export.

The archive contains the requesting user, tenant/member directory, non-secret
session IP/device/activity/revocation metadata, non-secret API-key metadata,
orders, balanced ledger rows, usage charges, plan periods, legal acceptances,
tenant audits and prior privacy requests/events. Every query is bound to the
authenticated tenant. It deliberately excludes:

- password, session, verification and API-key hashes;
- MFA secrets and recovery-code hashes;
- Checkout URLs and payment-provider secret/reference fields;
- network evidence HMACs and encrypted provider-result payloads.

The configurable `RELAY_PRIVACY_EXPORT_MAX_MIB` safety limit is 1–250 MiB
(default 50). Oversized exports fail in full with `PRIVACY_EXPORT_TOO_LARGE`;
the API never labels a truncated archive as complete.

## Closure state machine

Only one `requested`/`blocked` closure may exist per tenant. The default
cooling-off period is seven days and can be versioned between 1 and 30 days with
`RELAY_TENANT_CLOSURE_GRACE_DAYS`. Replaying a request returns the existing open
request. Any current Owner may cancel it before completion.

The dedicated Scheduler examines due requests hourly. Completion locks the
request and tenant and rechecks financial blockers in the same SQL statement.
The request stays `blocked` if any of these exist:

- non-zero refundable cash, included credit or reservations;
- reserved usage;
- open Checkout/manual orders;
- pending/settlement-pending refunds;
- unresolved disputes.

When clear, one statement closes the tenant, revokes keys and sessions, disables
memberships, invalidates invites/verifications, scrubs undelivered customer email
payloads and Checkout URLs, and removes encrypted provider results. Users with
another active tenant keep their profile; exclusive users are pseudonymized and
made unable to authenticate.

## Evidence and retention

Privacy request identity and terminal state are protected by database triggers;
requests cannot be deleted and event rows are append-only. Tenant high-risk
audit records separately capture the authenticated request/cancel/export
operation. Closure does not delete immutable billing entries, plan periods,
legal acceptance, tenant audit or privacy events. Their retention still depends
on counsel-approved policy and applicable law; application retention has no
deletion path for those records.
