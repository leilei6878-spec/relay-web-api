# Durable commercial alert delivery

Schema 16 replaces one-shot best-effort alert Webhooks with a PostgreSQL
Outbox. `relay_alert_events` remains the deduplicated alert state;
`relay_alert_deliveries` stores independently retryable `opened` and `resolved`
notifications.

Execution is driven by the dedicated Compose `scheduler` service, not an
`unref()` timer inside the HTTP process. The scheduler has no port, writes a
30-second heartbeat to `relay_meta` and also owns plan renewal, retention,
provider Canary and internal account maintenance. Commercial readiness blocks
launch if that heartbeat is older than 90 seconds.

## Lifecycle

- The first observation of an open fingerprint creates one `opened` delivery.
- A non-2xx or network failure records only a bounded error code and HTTP
  status, then retries after 1, 2, 4, 8, 16, 32 and at most 60 minutes.
- A missing URL/secret uses `not_configured`, does not consume an attempt and
  is reconsidered every five minutes.
- A database `sending` claim expires after two minutes; another Gateway safely
  reclaims it. PostgreSQL conditional update is authoritative even if Redis is
  unavailable.
- If an alert recovers before its opening notification was observed, the
  opening becomes `superseded` and no meaningless recovery is sent.
- If opening was delivered, recovery creates its own stable delivery ID and is
  retried until delivered.
- Payload SHA-256 is checked before every network attempt. A mismatch blocks
  delivery with `ALERT_DELIVERY_PAYLOAD_HASH_MISMATCH`.
- Resolved alerts and their delivery rows follow bounded operational retention;
  tenant mutation audit and billing ledgers remain unaffected.

Commercial Operations displays delivery event/status, attempts and safe error
code. **立即重试投递** sets all pending/retrying/not-configured rows due now;
the same administrator MFA and commercial audit controls apply.

## Signed Webhook contract

Configure versioned values:

- `alerts.webhookUrl` / `RELAY_ALERT_WEBHOOK_URL` — public HTTPS URL;
- `alerts.webhookSecret` / `RELAY_ALERT_WEBHOOK_SECRET` — dedicated secret of
  at least 32 characters. Never reuse `RELAY_SECRETS_KEY`.

Requests contain:

- `X-Relay-Event-Id`: stable delivery ID used for idempotency;
- `X-Relay-Timestamp`: Unix seconds;
- `X-Relay-Signature`: `v1=` plus lowercase HMAC-SHA256 hex of
  `<timestamp>.<exact raw body>`.

The receiver must use constant-time comparison, reject stale timestamps (five
minutes is recommended), deduplicate the event ID and return 2xx for both a new
event and an already processed duplicate. Do not return 409 for a duplicate or
the sender will correctly continue retrying.

Payload fields are `source`, `deliveryId`, `alertId`, `event`, `code`,
`severity`, `status`, `message`, `occurrences`, timestamps and sanitized
`detail`. Password/token/Cookie/Authorization/API-key/email/IP/User-Agent keys
and secret-shaped values are removed or redacted before durable storage.

The fixed Commercial Configuration connection test uses the same signature.
Commercial readiness remains false unless both signed-delivery settings are
valid; a URL flag alone is insufficient.
