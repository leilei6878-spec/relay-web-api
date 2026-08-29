# Administrator session and MFA security

The administrator root token is a recovery/machine secret, not a browser
session. Relay never puts `ad-relay-*` in a browser cookie.

## Session boundary

- Successful password/TOTP or approved local recovery creates a random
  `as-relay-*` browser token.
- PostgreSQL stores only SHA-256 of that token plus hashed IP/User-Agent audit
  fingerprints; the raw token exists only in the HttpOnly cookie.
- Sessions have a fixed, non-sliding 1–24 hour lifetime (default 12 hours), use
  `SameSite=Strict`, and are server-revocable.
- Logout revokes the database row and expires the cookie. Expired/revoked rows
  are not authentication principals and are pruned after seven days.
- Password failures are limited both in-process and through the production
  Redis coordination layer.
- In production, exchanging the root token for a browser session and using the
  root Bearer token are loopback-only by default. Remote exceptions require the
  explicit deployment-only overrides
  `RELAY_ALLOW_REMOTE_ADMIN_TOKEN_LOGIN=1` or
  `RELAY_ALLOW_REMOTE_ADMIN_BEARER=1`; neither is application configuration.

## TOTP setup

Generate a one-time Base32 secret on a trusted administrator workstation. The
command refuses to print a secret unless the operator acknowledges the output:

```bash
npm run admin:mfa-secret -- --acknowledge-secret-output --issuer=Relay --account=admin
```

Add the generated URI to an authenticator. Never place the output in Git, CI
logs, tickets or chat. While the MFA hard gate is still closed:

1. create and activate `security.adminTotpSecret` in `/commercial-config`;
2. create and activate `security.adminMfaRequired=true`;
3. set deployment `RELAY_REQUIRE_ADMIN_MFA=1` and restart the Gateway;
4. open a fresh login session and verify password plus the six-digit code;
5. keep the root token only in the external secret manager and test loopback
   recovery from the host before ending the change window.

The TOTP secret is AES-256-GCM encrypted by `RELAY_SECRETS_KEY`, returns only a
hint, and can be rotated as a new immutable config version. Session duration is
versioned as `security.adminSessionHours`.

## Enforcement

Commercial readiness cannot become true unless the MFA hard gate is enabled
and the effective TOTP secret is valid. Commercial operations, configuration,
launch evidence and live provider Canary endpoints call the MFA-aware
administrator guard for reads and writes. A pre-MFA session receives HTTP 403
after the gate opens; the operator must log out and authenticate again.

The loopback root Bearer is treated as a recovery principal for automation and
passes the MFA guard. Because it bypasses interactive MFA, it must never be
made remotely accessible in a public deployment.
