# Commercial SaaS Architecture

Status: **dark launch**. `RELAY_COMMERCIAL_ENABLED` must remain `0` until the
readiness endpoint returns `ready: true` and upstream contracts are approved.

## Hard traffic boundary

| Credential | Audience | Backend |
|---|---|---|
| `sk-saas-*` | Paying tenants | Official OpenAI, Google or Leonardo API only |
| `sk-relay-*` | Internal legacy operations | Web-account Worker pool |
| `ad-relay-*` / admin cookie | Internal administrator | Control plane |
| `wk-relay-*` | Trusted Worker | Job execution only |

Commercial routing resolves `openai:<model>`, `google:<model>` or
`leonardo:<official-model-uuid>`. Web aliases such as `chatgpt-web-auto`,
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

## Payments

The MVP creates idempotent manual recharge orders. Only the internal commercial
administrator can mark an order paid; that action posts an immutable recharge
transaction. A later payment adapter must verify signed provider callbacks and
reuse the same order idempotency key. No browser redirect or unverified webhook
may credit a wallet.

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

The required infrastructure contract is
[`deploy/commercial-ha-contract.yaml`](../deploy/commercial-ha-contract.yaml).

## Upstream source references

- OpenAI Chat Completions accepts official model messages and exposes
  `prompt_tokens` / `completion_tokens`; streaming usage is not guaranteed if a
  stream is interrupted, which is why commercial streaming stays disabled for
  now: https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions
- Gemini `generateContent` uses
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,
  `x-goog-api-key` and `usageMetadata`: https://ai.google.dev/api/generate-content
- Leonardo Production API image generation uses Bearer auth, creates with
  `POST /api/rest/v1/generations` and polls `GET /generations/{id}`:
  https://docs.leonardo.ai/v1.0/docs/getting-started
