# Commercial SaaS Architecture

Status: **dark launch**. `RELAY_COMMERCIAL_ENABLED` must remain `0` until the
readiness endpoint returns `ready: true` and upstream contracts are approved.

## Hard traffic boundary

| Credential | Audience | Backend |
|---|---|---|
| `sk-saas-*` | Paying tenants | Official OpenAI, Gemini API, Vertex AI or Leonardo API only |
| `sk-relay-*` | Internal legacy operations | Web-account Worker pool |
| `ad-relay-*` / admin cookie | Internal administrator | Control plane |
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
- Passwords use scrypt with random salts.
- Customer sessions use HttpOnly/Secure cookies; mutations require matching
  CSRF header/cookie plus trusted Origin.
- TOTP secrets use the encrypted secret store; recovery codes are hash-only.
- Tenant API keys are 256-bit `sk-saas-*` secrets, shown once and hash-only at
  rest. Listing returns hints only.
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

## Data and privacy

- Request content is redacted after the configured retention window (default
  30 days).
- Expired/revoked customer sessions default to 30 days.
- Operational checks default to 90 days and commercial audit to 365 days.
- Billing ledger retention is seven years and is never deleted by the app.
- Object media requires an S3 lifecycle matching the declared policy.
- Commercial tenant job/history APIs query by tenant ID and never expose the
  internal web account, Worker or proxy topology.

## Readiness gates

`GET /api/saas/readiness` exposes non-secret state. Commercial readiness needs:

- at least one official provider credential;
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
  provider/model/capability price route.

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
configuration; Readiness must verify them as external facts.

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
