# Tenant API-key lifecycle and rotation

Tenant API keys are one-time 256-bit `sk-saas-*` credentials. PostgreSQL stores
SHA-256 only; customer/admin listings expose a current hint and non-secret
lifecycle metadata, never either credential hash.

## Zero-downtime rotation

Each key record has one current credential and at most one previous credential.
An authenticated rotation:

1. requires Owner/Admin/Developer, trusted Origin, CSRF and unconditional recent
   MFA;
2. validates a 5-minute to 7-day requested overlap window;
3. compare-and-swaps the exact current hash;
4. moves that hash into the previous slot, installs a fresh random current
   credential, updates the one-time hint and increments `rotation_count`;
5. returns the new plaintext once and the effective previous-credential expiry.

The previous expiry is the earlier of the requested overlap and the API key's
own expiry. Expired keys cannot rotate. A 60-second database cooldown returns
HTTP 429 plus `Retry-After: 60`; two concurrent rotations from the same current
hash have one winner. A later rotation immediately evicts any older previous
credential, keeping the accepted credential set bounded to two.

Revoke and tenant closure disable the key and erase the previous credential
slot immediately. The daily retention task erases an expired previous hash even
when no request attempts to use it.

## Least-privilege creation

The Portal exposes Chat/Image scope, model allowlist, expiry, RPM, concurrency,
daily request and monthly-spend limits. Zero inherits the plan limit. The
server independently bounds every numeric input and requires an expiry to be
between five minutes and two years in the future. Plan features and limits
continue to intersect every per-key choice.

## Acceptance checklist

1. Create a scoped, expiring key and prove listings contain no current/previous
   hash or plaintext.
2. Rotate it and prove both old and new credentials work only during overlap.
3. Race two rotations and prove one new secret/winner.
4. Prove rapid retry is HTTP 429 and expired keys cannot rotate.
5. Rotate again and prove the oldest credential immediately fails.
6. Expire the previous slot and prove it fails before/after retention cleanup.
7. Revoke and close tenants, proving both credential slots fail and the previous
   hash is cleared.

Never place a customer API key in logs, audit detail, screenshots or retained
acceptance evidence.
