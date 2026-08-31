# Customer password change

## Authorization

`change-password` is available only through the authenticated customer security
API. It requires the HttpOnly session cookie, matching CSRF header/cookie and a
trusted Origin. If the account has MFA enabled, the current session must also
carry a recent MFA proof. The security surface remains reachable during legal
re-consent and tenant suspension, while ordinary service APIs remain closed.

## Verification and concurrency

The server rate-limits attempts per user/hour through the distributed
coordination store and fails closed if that store is unavailable. It verifies
the supplied current password with scrypt, rejects reuse of the current secret,
and validates the new password through the normal 10–1024 character hashing
contract.

The database update compares the exact previously read password hash. Two
concurrent changes using the same old password can therefore produce only one
winner; the stale update receives `PASSWORD_CHANGE_CONFLICT` instead of
silently overwriting the winner.

## Post-change effects

One statement updates the scrypt hash, clears any pending MFA replacement and
revokes every other active session with reason `password_change`. The current
session remains active, allowing the user to finish security review without a
race against their own logout. Sessions belonging to another user are never
updated.

The tenant audit records only action, actor and session/user IDs. Current/new
passwords and password hashes are not returned, exported, placed in audit
detail or written to general logs. Password fields are cleared from React state
when the dialog closes.

## Acceptance

Verify wrong-current, current-password-reuse, rate-limit and coordination
failure paths. Then change from two devices, prove one CAS winner, confirm the
old password and other device fail, and confirm the new password and current
device continue to work. Retain no password, cookie or password hash in
acceptance evidence.
