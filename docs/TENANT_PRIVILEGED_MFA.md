# Tenant privileged-session MFA

An account-level `mfa_enabled` flag does not prove that a particular browser
session completed MFA. Relay records `mfa_verified_at` on each SaaS session and
uses that timestamp for high-risk authorization.

## Protected operations

When `RELAY_REQUIRE_PRIVILEGED_SAAS_MFA=1` (or commercial mode is enabled), the
following CSRF-protected mutations also require a fresh MFA session:

- Owner/Admin/Developer API-key creation and revocation;
- Owner/Admin/Billing Checkout, recharge and plan changes;
- Owner/Admin member invitations, role changes and disable/enable actions.

Role checks execute before the MFA check. MFA never grants a role the user does
not already hold.

## Session proof and freshness

- Password-only sessions store no MFA timestamp.
- TOTP and one-time recovery-code logins create a verified session.
- Confirming MFA marks only the enrollment session as verified; sessions
  created before enrollment remain unverified.
- Verification is accepted for `RELAY_SAAS_MFA_MAX_AGE_HOURS` (default 24,
  bounded 1–168). An older session receives `MFA_STEP_UP_REQUIRED` and must log
  in again.
- The customer Portal shows whether the current privileged session requires
  step-up and exposes TOTP enrollment. `/saas/security-center` remains
  available when legal re-consent is pending or the tenant is suspended.

## Recovery codes

Eight random recovery codes are displayed once after TOTP confirmation. Only
SHA-256 hashes are stored. A login removes the matching hash atomically before
creating the session, so two concurrent attempts with the same code produce
exactly one successful session. A consumed or unknown code returns the same
`MFA_REQUIRED` result as an invalid TOTP code.

Recovery codes must be stored offline. Password reset revokes all existing
sessions but does not silently disable MFA.

An MFA-verified user can rotate all eight recovery codes. Rotation replaces the
hash set atomically, returns plaintext only once and revokes every other active
session. The current verified session remains active so the user can safely
store the new codes. Session inventory and revocation never return token or
CSRF hashes.

## Activation

1. Keep the deployment hard gate closed while privileged tenant users enroll.
2. Verify new TOTP sessions, one-time recovery and an old-session rejection.
3. Create/activate `security.customerPrivilegedMfaRequired=true` and the desired
   `security.customerMfaMaxAgeHours` in `/commercial-config`.
4. Set deployment `RELAY_REQUIRE_PRIVILEGED_SAAS_MFA=1` and restart Gateway.
5. Confirm public readiness reports
   `customerPrivilegedMfaRequired: true` and record acceptance evidence.

Commercial readiness remains false while the deployment/configuration gate is
closed. Database configuration alone cannot override the deployment veto.
