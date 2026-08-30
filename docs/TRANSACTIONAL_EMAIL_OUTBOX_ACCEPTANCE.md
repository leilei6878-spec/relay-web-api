# Transactional customer-email Outbox acceptance

Date: 2026-08-30 (Asia/Shanghai)

## Release

- version: `0.10.0-rc16`;
- schema: `17` (no schema change from rc15);
- runtime/deployment commit:
  `dc852f2a7f528d22743b24711825cf3942b1b01b`;
- all public charging and registration gates remain disabled.

## Correctness and privacy changes

- initial registration now commits user, tenant, membership, email-verification
  token and encrypted Outbox row in one PostgreSQL statement;
- verification resend and password-reset rotation atomically retire old tokens,
  scrub still-queued old payloads, insert the new token and insert its Outbox
  row;
- tenant invitation upsert, token replacement, old queued-payload
  supersession and new Outbox insert are one PostgreSQL statement;
- a failed Outbox insert therefore cannot leave a stranded user, token or
  invitation;
- a new password-reset request immediately invalidates the preceding token;
- generic enqueue replay no longer supersedes its own idempotency row;
- public verification-resend and reset-request responses expose only
  `{ "ok": true }`, regardless of whether the email exists or queue
  configuration fails;
- those public recovery paths do not synchronously invoke the email receiver
  and use a randomized minimum response duration, preventing response shape or
  receiver latency from acting as an account-existence oracle;
- operational failure logs contain only a fixed event kind/error code, never
  the submitted email address.

## Automated verification

- Relay tests: 335 passed;
- commercial tests: 72 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint, production build and production dependency audit passed;
  dependency audit found zero known vulnerabilities;
- forced Outbox constraint failures prove registration and invitation leave no
  user/tenant/membership/verification/invite/delivery partial rows;
- token-rotation tests prove preceding verification and reset tokens fail;
- known/unknown response tests prove equal JSON shape, asynchronous delivery,
  bounded equalization delay and address-free failure logging.

## Real PostgreSQL rehearsal

The rc15 production backup was restored to isolated database
`relay_rc16_transaction_rehearsal`. The rc16 Gateway image then executed the
real application functions against PostgreSQL:

- a successful pending-verification registration produced one user, tenant,
  membership, verification and delivered Outbox row;
- a temporary PostgreSQL trigger forced the next verification-email Outbox
  insert to fail; the registration rejected and `failed_users` remained zero;
- a known password-reset request created one pending Outbox row without a
  synchronous receiver call;
- an unknown request returned the identical generic result and created no row;
- final isolated counts were users/tenants/memberships `1/1/1`,
  verifications/deliveries `2/2`, delivered/pending `1/1`, and receiver calls
  `1` (registration only);
- the temporary trigger and database were removed.

## Production and recovery evidence

- pre-deploy accepted backup:
  `/opt/backups/relay-email-outbox-final-20260830043033`;
- public HTTPS health/readiness reports rc16/schema17/exact commit and valid
  TLS; PostgreSQL remains at 46 public tables and 17 migrations;
- five internal accounts remain, with zero tenants, orders, billing
  transactions, tenant audits and email deliveries;
- one Worker and the dedicated Scheduler remain online; no external email
  delivery is configured or attempted;
- release evidence:
  `/opt/backups/relay-release-evidence-dc852f2a7f52`;
- release-manifest SHA-256:
  `4c722ef03887a186da0ef5302f8667299283aaad5dc4a6d6b3a7a2692f440237`;
- CycloneDX production SBOM SHA-256:
  `cf7b50bdcb6dfef79019aed1923f1a7805fac08b4f001ecccbbbe842fdd8dd44`;
- final backup:
  `/opt/backups/relay-transactional-email-final-20260830051425`;
- every listed checksum, control-plane dry-run, independent Git bundle,
  PostgreSQL restore and object manifest passed; restored state matched
  schema17, 46 tables, 17 migrations, five accounts, zero tenants/email rows
  and 96 objects / 45,849,211 bytes;
- the isolated final-restore database and staging directory were removed.

## Remaining launch dependency

This release closes an internal consistency/privacy gap; it does not fabricate
the external email provider or launch evidence. Public registration remains
blocked until a real signed receiver is configured and independently accepted
as described in `EMAIL_DELIVERY.md`.
