# Commercial SaaS Architecture

Status: **dark launch**. `RELAY_COMMERCIAL_ENABLED` must remain `0` until the
readiness endpoint returns `ready: true` and upstream contracts are approved.

## Hard traffic boundary

| Credential | Audience | Backend |
|---|---|---|
| `sk-saas-*` | Paying tenants | Official OpenAI, Gemini API, Vertex AI or Leonardo API only |
| `sk-relay-*` | Internal legacy operations | Web-account Worker pool |
| `as-relay-*` HttpOnly cookie | Internal administrator browser | Control plane |
| `ad-relay-*` | Loopback recovery/machine administrator | Control plane |
| `wk-relay-*` | Trusted Worker | Job execution only |

Commercial routing resolves `openai:<model>`, `google:<model>`,
`vertex:<model>` or `leonardo:<official-model-uuid>`. Web aliases such as `chatgpt-web-auto`,
`nano-banana-2` and `leonardo-gemini` are rejected before account selection.
Commercial streaming and image editing are intentionally disabled until their
official-provider usage/asset settlement paths are authoritative.

## Request and billing sequence

1. Hash-lookup the tenant API key in PostgreSQL.
2. Check tenant state, scope, model allowlist, minute/day rate limits and
   distributed concurrency semaphore.
3. Resolve an active immutable price-book version.
4. Row-lock the tenant wallet and create one idempotent usage reservation.
5. Call the official provider with a server-owned credential.
6. On provider failure release the reservation; on success settle from the
   provider's authoritative usage/count.
7. Append one billing transaction and two equal/opposite ledger entries.
8. Database triggers reject UPDATE/DELETE on billing transactions and entries.

## Tenant and identity

- Tenant, users and memberships are first-class SQL rows.
- Roles: owner, admin, billing, developer and viewer.
- Each tenant has one database-designated Owner referencing an active Owner
  membership. General invites/role edits cannot create Owner; an MFA-bound
  stored function atomically promotes the target and demotes the source while
  triggers reject direct orphaning. See
  [`TENANT_OWNERSHIP.md`](./TENANT_OWNERSHIP.md).
- Owner/Admin invitation governance exposes lifecycle metadata without token
  hashes. Re-send/revoke rotate or tombstone the hash via compare-and-swap,
  supersede encrypted Outbox payloads and make concurrent mutation one-winner;
  acceptance rechecks the exact hash under row lock. See
  [`TENANT_INVITATION_LIFECYCLE.md`](./TENANT_INVITATION_LIFECYCLE.md).
- Users with multiple active memberships can list and switch tenants from the
  shared SaaS Shell. Switching atomically revokes the source session, creates a
  target-bound session, recomputes target legal state and preserves the exact
  original MFA timestamp without extending step-up. See
  [`TENANT_SWITCHING.md`](./TENANT_SWITCHING.md).
- Passwords use scrypt with random salts.
- Customer sessions use HttpOnly/Secure cookies; mutations require matching
  CSRF header/cookie plus trusted Origin.
- TOTP secrets use the encrypted secret store; recovery codes are hash-only.
- Every SaaS session records whether and when TOTP or a one-time recovery code
  was verified. Privileged key, billing, plan and membership mutations require
  a fresh session-level proof when commercial mode is enabled; enabling MFA on
  one session does not upgrade older sessions. See
  [`TENANT_PRIVILEGED_MFA.md`](./TENANT_PRIVILEGED_MFA.md).
- Every user can inspect their own recent session device/IP/activity metadata,
  revoke one or all other devices, and rotate hash-only recovery codes. Session
  inventory never returns token/CSRF hashes; all mutations are CSRF/Origin
  protected and tenant-audited. Security access remains available during legal
  re-consent or tenant suspension while service APIs remain closed.
- TOTP enrollment/replacement is staged in a separate encrypted candidate with
  a ten-minute expiry. Existing protection stays active until atomic promotion;
  confirmation rotates recovery hashes and revokes other sessions. Expiry,
  password reset and privacy closure clear only the pending candidate.
- Authenticated password change verifies the old scrypt secret, requires fresh
  MFA when enabled, uses an exact-hash compare-and-swap, clears pending MFA and
  revokes all other user sessions. Distributed rate-limit failure is
  fail-closed and audit detail never contains password material.
- Tenant API keys are 256-bit `sk-saas-*` secrets, shown once and hash-only at
  rest. Listing returns hints only.
- Administrator browsers receive short-lived random `as-relay-*` sessions;
  PostgreSQL stores only their hashes. The `ad-relay-*` root token is
  loopback-only recovery/machine authentication in production. Commercial
  administrator surfaces require a TOTP-verified session when the MFA gate is
  enabled. See [`ADMIN_SECURITY.md`](./ADMIN_SECURITY.md).
- Effective key scopes and model allowlists are the intersection of the key and
  its plan features. A disjoint plan/key model set denies every model rather
  than falling back to unrestricted access.
- Plan RPM, concurrency, daily request and monthly-spend limits apply whenever
  a key does not define a stricter override. Tenant monthly budget is enforced
  across all keys, including active reservations.
- Expired monthly billing periods roll to the current calendar month before a
  new reservation, so old usage cannot permanently consume a new period's
  budget.

## Payments

Customer recharge uses a server-created Stripe Checkout Session. Internal order
and tenant IDs are attached as Checkout and PaymentIntent metadata. The Checkout
URL is short-lived and is cleared after expiry; card data never enters Relay.

`POST /api/webhooks/stripe` reads the raw body, validates the timestamped HMAC
signature with constant-time comparison, deduplicates the provider event, and
requires exact order, tenant, amount and currency matches. Only a paid Checkout
Session can append the recharge transaction. A browser success redirect cannot
credit a wallet. Separate Stripe events referring to the same PaymentIntent use
one ledger idempotency key and therefore cannot double-credit.

Refunds reserve available tenant credit before the provider call. A successful
Stripe refund appends a negative wallet entry with an equal cash-refund entry,
then releases the reservation. Failed calls release the hold without changing
balance. Dashboard/external refunds are associated through the unique
PaymentIntent and may suspend a tenant whose wallet becomes negative. Payment
events retain only the payload SHA-256 and reconciliation identifiers, not the
raw Stripe payload.

For the single Checkout wallet-credit line, partial taxed refunds use a
cumulative proportional tax allocation so arbitrary partitions finish at the
exact original net/tax/gross totals. Checkout refunds already affect Stripe Tax
reports; Relay does not create a second custom Tax reversal. External gross
refunds are accepted only when they map exactly back to one allocation. See
[`PARTIAL_TAX_REFUND.md`](./PARTIAL_TAX_REFUND.md).

Orders separate net wallet credit, tax and gross customer payment. With
`RELAY_TAX_MODE=stripe_automatic`, Checkout collects the billing address and
uses Stripe Tax. Settlement posts wallet credit and tax payable against gross
external cash; refunds reverse those same three accounts. `approved_exempt` is
accepted only as an explicit, documented tax/legal decision, never as a
default.

Dispute creation immediately suspends the tenant. Stripe's explicit
funds-withdrawn and funds-reinstated events mirror the financial effect through
separate idempotent ledger transactions. A won dispute restores funds but does
not automatically reactivate access; an operator must review the account.

## Plan periods

Monthly plans are funded from the prepaid cash wallet. Cash and non-refundable
included plan credit are separate balances and reservation buckets; usage
consumes included credit first. Each UTC calendar period snapshots the plan,
deducts its monthly fee, expires old included credit, grants the new allowance
and appends a balanced immutable transaction. Concurrent settlement is unique
per tenant/period. Plan changes are customer-visible but apply only at the next
period boundary. See [`PLAN_BILLING.md`](./PLAN_BILLING.md).

## Data and privacy

- Request content is redacted after the configured retention window (default
  30 days).
- Expired/revoked customer sessions default to 30 days.
- Operational checks default to 90 days and commercial audit to 365 days.
- Billing ledger retention is seven years and is never deleted by the app.
- Object media requires an S3 lifecycle matching the declared policy.
- Commercial tenant job/history APIs query by tenant ID and never expose the
  internal web account, Worker or proxy topology.
- A tenant Owner with a recent MFA proof can download a tenant-scoped,
  SHA-256-bound JSON export. Password/session/API-key hashes, MFA material,
  payment secrets, network HMACs and encrypted provider results are excluded.
- Tenant closure uses a configurable 1–30 day cooling-off period. The Owner can
  cancel it before execution; non-zero cash/included balances, reservations,
  open payments, refunds or disputes block completion instead of silently
  forfeiting money.
- Closure revokes API keys and sessions, disables memberships, consumes pending
  verification tokens and pseudonymizes users that have no other active
  tenant. Immutable billing, legal-acceptance, privacy-event and tenant-audit
  evidence remains under its declared legal retention policy.

## Readiness gates

`GET /api/saas/readiness` exposes non-secret state. Commercial readiness needs:

- a current official credential for every provider referenced by an active
  price route; an unrelated provider credential cannot satisfy this gate;
- at least one active price-book row;
- HTTPS public origin;
- Redis;
- two online Workers;
- declared two or more Gateway replicas;
- offsite backup target;
- completed legal review (`RELAY_LEGAL_APPROVED=1`).
- Stripe live API/restricted key, Webhook signing secret and payment-provider
  selection.
- configured Stripe automatic tax or a documented approved exemption.
- a recent exact passed live provider canary for every active
  provider/model/capability/currency price route.
- valid append-only launch evidence for provider rights, every exact price
  version, legal/tax approval, live payments, email delivery when registration
  is enabled, HA, offsite restore, alert delivery, load, soak and CI gates.
- administrator MFA hard gate plus a valid encrypted TOTP secret.
- privileged customer-session MFA hard gate and a bounded verification age.

The required infrastructure contract is
[`deploy/commercial-ha-contract.yaml`](../deploy/commercial-ha-contract.yaml).

## Versioned configuration

Application-level provider, payment, delivery and retention configuration is
versioned in PostgreSQL and managed at `/commercial-config`. Secret values are
AES-256-GCM encrypted, hint-only in every response, connection-tested against a
fixed official endpoint and activated atomically with audit history. Deployment
environment variables remain recovery fallbacks and hard launch gates. See
[`COMMERCIAL_CONFIG_CENTER.md`](./COMMERCIAL_CONFIG_CENTER.md).

Actual replica counts, managed-HA topology, offsite account ownership, legal
documents and upstream contracts are deliberately not mutable application
configuration. They are recorded as hashed, independently reviewed, expiring
evidence at `/commercial-readiness`; a configuration flag cannot satisfy the
evidence gate. See
[`COMMERCIAL_LAUNCH_EVIDENCE.md`](./COMMERCIAL_LAUNCH_EVIDENCE.md).

Real upstream evidence is managed at `/commercial-sandbox` with a separate
deployment cost gate, fixed prompts, price-based maximum and content-free
evidence rows. See
[`COMMERCIAL_PROVIDER_SANDBOX.md`](./COMMERCIAL_PROVIDER_SANDBOX.md).

## Upstream source references

- OpenAI Chat Completions accepts official model messages and exposes
  `prompt_tokens` / `completion_tokens`; streaming usage is not guaranteed if a
  stream is interrupted, which is why commercial streaming stays disabled for
  now: https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions
- Gemini `generateContent` uses
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,
  `x-goog-api-key` and `usageMetadata`: https://ai.google.dev/api/generate-content
- Vertex AI uses a service-account RS256 assertion exchanged for a short-lived
  OAuth token and the regional publisher-model `generateContent` endpoint:
  https://developers.google.com/identity/protocols/oauth2/service-account and
  https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling
- Leonardo Production API image generation uses Bearer auth, creates with
  `POST /api/rest/v1/generations` and polls `GET /generations/{id}`:
  https://docs.leonardo.ai/v1.0/docs/getting-started
- Stripe Checkout Sessions are created server-side with metadata for internal
  reconciliation: https://docs.stripe.com/api/checkout/sessions/create
- Stripe requires the raw request body for Webhook signature verification:
  https://docs.stripe.com/webhooks
- Stripe refunds support partial refunds and emit refund lifecycle events:
  https://docs.stripe.com/refunds
- Stripe defines dispute creation, closure, funds-withdrawn and
  funds-reinstated event types: https://docs.stripe.com/api/events/types
