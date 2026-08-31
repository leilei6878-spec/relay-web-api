# Customer session security

## Surfaces

`/saas/security-center` and `GET /api/saas/security` are authenticated personal
security surfaces. They remain reachable when a legal bundle is stale or a
tenant is suspended. This exception does not grant access to billing, members,
keys or AI service APIs.

The inventory is scoped by `user_id` across the user's tenants and returns only:

- random session ID and current-device marker;
- tenant name/status;
- recorded IP address and bounded User-Agent;
- created, last-seen, expiry, MFA proof and revocation timestamps/reason.

It never returns session-token or CSRF hashes. `last_seen_at` is refreshed at
most once every five minutes to keep activity useful without a write on every
request. Revoked/expired sessions remain visible only inside the existing
bounded session-retention window.

## Revocation

All mutations require the authenticated HttpOnly cookie, matching CSRF
header/cookie and trusted Origin. A user may revoke an active non-current
session or every other active session. Both operations constrain the SQL update
by `user_id`; a foreign user's session and the current session cannot be
revoked through the single-device action. Logging out remains the explicit way
to revoke the current browser.

The database records bounded reasons and the revoking session ID. Tenant audit
records contain only session IDs and action outcomes—never raw IP, User-Agent,
tokens or recovery codes.

## Recovery-code rotation

Rotation always requires a recently MFA-verified session regardless of whether
commercial traffic is enabled. It generates eight new random codes, atomically
replaces the stored SHA-256 set and revokes every other active session with the
`mfa_recovery_rotation` reason. Plaintext codes are returned once and are not
written to audit detail or durable logs.

Changing the authenticator uses a separate encrypted pending Secret. The old
factor remains active until the pending code is confirmed; confirmation then
revokes other sessions with `mfa_reenrollment`. Starting a replacement from an
already protected account requires a recent MFA proof. See
[`STAGED_MFA_ENROLLMENT.md`](./STAGED_MFA_ENROLLMENT.md).

## Privacy export

`relay-tenant-export-v1` includes non-secret session IP/device/activity and
revocation metadata for the requesting user in the current tenant. This closes
the data-portability gap while still excluding token/CSRF hashes and MFA
secrets. Normal retention removes revoked or expired session rows after the
configured period.
