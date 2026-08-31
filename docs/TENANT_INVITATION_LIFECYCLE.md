# Tenant invitation lifecycle

Tenant invitations are durable, tenant-scoped records with explicit
`pending`, `expired`, `accepted` and `revoked` states. Owner/Admin listings
return the invite ID, email, role, timestamps and send count, but never the
token hash, encrypted email payload or delivery credential.

## Credential invariants

- Every email link contains a fresh 256-bit random token; PostgreSQL stores
  only SHA-256.
- Re-send uses compare-and-swap against the current hash, replaces it with a
  new hash and increments `send_count` in the same statement that queues the
  new encrypted Outbox delivery.
- A 60-second per-invite database cooldown rejects double-click/retry mail
  amplification; the SQL predicate remains authoritative under concurrency.
- Concurrent re-sends from one invite have one winner; a losing writer cannot
  enqueue mail.
- Older undelivered messages in the same tenant/email HMAC scope are marked
  superseded and their ciphertext is scrubbed.
- Revoke compare-and-swaps the current hash to a random tombstone, records the
  actor/time and supersedes queued delivery ciphertext atomically.
- Acceptance locks the invite and rechecks the exact submitted hash, expiry
  and non-revoked state inside the membership-creation transaction. A token
  revoked or rotated after initial lookup cannot be consumed.
- `accepted_at` and `revoked_at` are mutually exclusive. Accepted/revoked
  invitation PII is pseudonymized after the configured operational-retention
  period; role/timestamps/counts remain for governance.

## Administration and audit

The customer Portal shows invitation history to Owner/Admin only. Pending and
expired records can be re-sent or revoked. Every create, re-send and revoke is
CSRF/Origin protected, follows the privileged session-level MFA policy and
writes tenant-audit start plus terminal events. Invite links and token hashes
are never written to audit detail.

Privacy export includes non-secret invitation lifecycle fields. Tenant closure
invalidates every invite hash, scrubs invite email and delivery ciphertext,
and preserves the accepted/revoked exclusivity constraint.

## Acceptance checklist

1. Create one invite and prove the listing contains no token/hash/ciphertext.
2. Re-send it and prove the old URL fails while the new URL remains usable.
3. Race two re-sends and retain evidence of one database winner and one queued
   delivery.
4. Revoke the current invite and prove its URL and queued delivery are invalid.
5. Attempt list/re-send/revoke from another tenant and a non-privileged role.
6. Accept a fresh invite once and prove replay fails.
7. Run retention and tenant closure against pending, accepted and revoked
   records and verify PII scrubbing without constraint failure.

Never store an invitation URL or token in long-lived acceptance evidence.
