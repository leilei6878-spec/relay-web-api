# Staged MFA enrollment and replacement

## Invariant

Starting TOTP enrollment must never weaken an already protected account. Relay
therefore stores a candidate Secret in `mfa_pending_secret_ciphertext` with a
ten-minute expiry. It does not change `mfa_enabled`, the active encrypted Secret
or existing recovery-code hashes.

For an account that already has MFA, both start and confirm require the current
session to carry a recent MFA proof. A password-only legacy session cannot
replace the authenticator. Initial enrollment remains possible from an
authenticated Owner/Admin session so a new tenant can establish its first
factor before commercial activation.

## Confirmation

The server verifies the code against the encrypted pending Secret. One SQL
statement then:

1. compares the exact pending ciphertext and checks its database expiry;
2. promotes it to the active Secret;
3. keeps/sets `mfa_enabled=true`;
4. replaces all eight recovery-code SHA-256 hashes;
5. clears pending Secret and expiry;
6. marks the current session recently MFA-verified; and
7. revokes every other active session with reason `mfa_reenrollment`.

Concurrent or stale confirmation cannot promote a cleared/replaced candidate.
Wrong codes leave both active and pending state intact. An expired attempt is
cleared and returns `MFA_ENROLLMENT_EXPIRED`; the old factor continues to work.

## Cleanup

The daily retention task clears expired pending Secrets. Password reset and
tenant privacy closure also clear pending enrollment immediately. Pending
Secrets and active MFA Secrets remain encrypted at rest and are excluded from
session inventory, privacy exports, tenant audit and general logs.

## Acceptance

For a real staging Owner, prove that beginning replacement does not change the
old-factor login, abandoning/expiring the candidate keeps the old factor, and
successful confirmation makes the old factor/recovery codes/other sessions
fail while the current session and one new recovery code remain valid.
