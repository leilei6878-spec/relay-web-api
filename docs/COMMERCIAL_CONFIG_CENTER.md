# Commercial configuration center

Route: `/commercial-config`

The configuration center lets administrators add, test, activate, replace and
roll back approved application-level commercial settings without placing raw
secrets in source control. It does not turn external facts such as contracts,
HA replicas or offsite accounts into editable booleans.

## Safety model

- The catalog is compiled into `commercial-config.ts`. Unknown keys and
  arbitrary upstream endpoints are rejected.
- Every change creates a new immutable version. Values, creator and creation
  time cannot be updated or deleted by SQL; only validation and lifecycle state
  may change.
- Secret versions require `RELAY_SECRETS_KEY` and are encrypted with the
  existing AES-256-GCM secret envelope. Lists and API responses return only a
  short hint.
- A draft must pass its fixed format/connection test before activation.
- Webhook URLs must use HTTPS, cannot contain credentials, reject local/private
  literal hosts, and are DNS-resolved before testing and every production
  delivery; any private/link-local/reserved result is rejected to limit SSRF.
- Activation retires the current version atomically and writes a commercial
  audit row. Any previously tested retired version can be reactivated as a
  rollback.
- Runtime lookups are cached for at most five seconds. Activation invalidates
  the local cache; other Gateway replicas converge within the cache window.

`RELAY_SECRETS_KEY` is a deployment master key and is intentionally not stored
inside the same database. Back it up in the external secret manager. Losing or
changing it without a managed re-encryption procedure makes encrypted config
versions unreadable.

## Fixed connection tests

Connection tests never accept an administrator-supplied upstream URL:

| Configuration | Test |
|---|---|
| OpenAI key | `GET https://api.openai.com/v1/models` |
| Gemini key | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1` |
| Leonardo key | `GET https://cloud.leonardo.ai/api/rest/v2/models` |
| Stripe key | `GET https://api.stripe.com/v1/balance` |
| Stripe Webhook secret | local `whsec_` format validation |
| Email/alert Webhook | explicit HTTPS configuration-test event |

Only HTTP status and small non-sensitive counts/codes are retained. Provider
error bodies and supplied secrets are never written to test detail or audit.

## Hard gates and fallbacks

Environment variables remain the recovery fallback. An active database version
overrides its mapped environment value, except these launch gates:

- `RELAY_COMMERCIAL_ENABLED`
- `RELAY_SAAS_REGISTRATION_ENABLED`
- `RELAY_LEGAL_APPROVED`

For those values, both deployment environment and active database version must
be true. A compromised administrator session therefore cannot open commercial
traffic, registration or legal approval when operations has closed the hard
gate.

Provider keys, Leonardo model mapping, payment provider, Stripe keys, tax mode,
email/alert Webhooks, recharge maximum and retention windows can use validated
active versions. If no version is active, the existing environment variable is
used.

## Rotation procedure

1. Keep the current version active.
2. Create a secret draft with a ticket/rotation reason.
3. Run the fixed connection test.
4. Activate the tested version.
5. Observe provider/payment canaries and commercial alerts.
6. If needed, reactivate the previous tested version.
7. Revoke the old vendor credential only after the observation window.

The configuration center does not add arbitrary providers. A new provider still
requires an explicit commercial agreement, a code-reviewed adapter, authoritative
usage settlement and catalog changes.
