# Multi-tenant membership switching

## Tenant inventory

`GET /api/saas/tenants` lists only active memberships for the authenticated
user. It returns tenant ID/slug/name/status/plan and the user's role. Another
user's tenants are excluded. Active/trial tenants sort before suspended tenants;
suspended memberships stay selectable for security and data-rights access.

The SaaS Shell renders a tenant selector only when more than one choice exists.
Single-tenant users retain the compact name/role display.

## Atomic session rotation

`POST /api/saas/tenants` requires the HttpOnly session, matching CSRF
header/cookie and trusted Origin. Legal re-consent and suspension do not block
the switch surface, but the target must be an active membership in a
trial/active/suspended tenant.

One PostgreSQL statement:

1. resolves the target membership and role;
2. revokes the exact current session with reason `tenant_switch`;
3. inserts a new random token/CSRF hash-bound session for the target; and
4. returns the target tenant only if both revocation and insertion succeeded.

An invalid/foreign target does not revoke the current session. Two concurrent
switches from one current session have one winner because only one statement can
revoke it. The full secret is returned only as Secure/HttpOnly cookie material;
the database stores hashes.

## MFA and legal state

The new session copies the original `mfa_verified_at` timestamp exactly. It does
not replace it with `now()`, so repeated tenant switching cannot extend the
configured step-up window. Current legal acceptance is recomputed for the target
tenant. The UI routes a stale bundle to consent and a suspended tenant to the
restricted privacy/security surfaces.

## Audit and acceptance

The source tenant receives append-only `tenant.switch` audit start/terminal
events with target tenant ID and no token, cookie, IP or User-Agent detail.
Acceptance must use one real staging user with two memberships, prove both role
sets, prove a foreign tenant is absent/forbidden, compare the MFA timestamp
before/after, and race two switches to show one active session/winner.
