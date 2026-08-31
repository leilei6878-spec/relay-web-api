# Designated tenant ownership

## Invariant

Every active/trial/suspended tenant must have one designated Owner in
`relay_tenant_ownership`. The row references the exact composite membership.
The membership must remain `role=owner,status=active`; database triggers reject
demotion, disabling or deletion outside the transfer function.

Migration backfill deterministically selects the earliest active Owner and
demotes any additional legacy Owner roles to Admin. The commercial monitor
raises critical `TENANT_OWNER_MISSING` when a live tenant lacks a valid
designated Owner/user/membership chain.

New tenant creation inserts its Owner membership and an after-insert trigger
registers the ownership row. A conflicting second Owner insert is rolled back.
Normal invitation and general role mutation reject `owner`; this role can only
be obtained through ownership transfer.

## Atomic transfer

`relay_transfer_tenant_ownership(tenant,source,target)` runs inside one database
transaction and serializes on the tenant. It requires:

- source equals the current designated Owner;
- target differs from source;
- target user and membership are active; and
- target has MFA enabled.

The function designates the target, promotes it to Owner, then demotes the
source to Admin. Any failure rolls back all three writes. Concurrent transfers
from the same source have one winner; the second observes a source mismatch.

The customer API additionally requires Owner role, recent MFA, CSRF/Origin
proof and tenant audit. The Portal requires typing the target email before
submitting and disables transfer when target MFA is off.

## Acceptance

Use a real staging tenant with an MFA-enabled target. Confirm ordinary Owner
invite/promotion and designated-Owner demotion fail, target-without-MFA fails,
successful transfer produces exactly one Owner/ownership row and source Admin,
and two concurrent targets yield one winner. Store no authenticator, cookie,
session token or personal email beyond the approved evidence system.
