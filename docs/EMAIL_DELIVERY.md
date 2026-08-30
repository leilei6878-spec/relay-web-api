# Customer email delivery

Schema 17 routes email verification, password-reset and tenant-invite messages
through a durable PostgreSQL Outbox. A request succeeds after the message is
durably queued; a temporary receiver failure no longer loses the message or
turns an already-created account/invite into an ambiguous HTTP failure.

## Configuration

Configure and activate both values in `/commercial-config`:

- `email.webhookUrl` / `RELAY_EMAIL_WEBHOOK_URL`: a public HTTPS receiver with
  no URL credentials, query string or fragment;
- `email.webhookSecret` / `RELAY_EMAIL_WEBHOOK_SECRET`: a dedicated random
  secret of at least 32 characters.

The URL and HMAC secret are immutable versioned configuration entries. Create,
test and activate a new version instead of overwriting the active value. Keep
the old secret accepted by the receiver during a rotation observation window.
`RELAY_SECRETS_KEY` is the external root key used to encrypt queued payloads
and versioned secrets; it is deliberately not stored in the database and must
be kept in the deployment secret manager and disaster-recovery escrow.

Commercial readiness remains blocked unless the signed email channel is
configured. Registration remains a separate final launch gate.

## Receiver contract

Relay sends `POST application/json` with these headers:

- `X-Relay-Email-Id`: stable Outbox delivery ID; use it as the provider
  idempotency key and return 2xx for an already accepted duplicate;
- `X-Relay-Timestamp`: Unix seconds;
- `X-Relay-Signature`: `v1=` followed by lowercase HMAC-SHA256 hex.

The signed bytes are exactly:

```text
X-Relay-Timestamp + "." + raw HTTP request body
```

The receiver must compare the HMAC in constant time, reject stale timestamps,
deduplicate on `X-Relay-Email-Id`, map only the three known templates and avoid
logging the raw body or links. Supported payloads are:

```json
{"template":"verify-email","to":"person@example.com","tenant":"Example","link":"https://relay.example/saas/verify?token=..."}
{"template":"password-reset","to":"person@example.com","link":"https://relay.example/saas/reset?token=..."}
{"template":"tenant-invite","to":"person@example.com","tenant":"Example","role":"developer","link":"https://relay.example/saas/invite?token=..."}
```

Return any 2xx only after the downstream provider has durably accepted the
message. A non-2xx or network timeout is retried with exponential backoff up to
one hour, bounded by the token/invite expiry time.

## Data handling and operations

`relay_email_deliveries` stores only a keyed recipient digest and an AES-256-GCM
ciphertext. Plain email addresses and tokens are not exposed by the commercial
admin API. When a newer token supersedes an older one, or a message is
delivered/expired, its ciphertext is immediately replaced by a marker.
Terminal metadata is deleted by the operational retention policy.

The dedicated `scheduler` service checks due messages every 30 seconds and
recovers claims left by a crashed process after two minutes. Commercial
Operations shows status, attempts and bounded error codes and provides an
MFA-protected manual retry. `/api/admin/metrics` exposes `emailPending` and
`emailFailed` under `commercial.alerts`.

Before enabling public registration, test all three templates, a duplicate
delivery, a receiver 5xx/recovery, expiry/supersession and secret rotation.
Confirm the receiver and email provider logs do not contain raw action links.
