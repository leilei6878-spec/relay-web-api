# Trusted client-network boundary acceptance

Date: 2026-08-30 (Asia/Shanghai)

## Release

- version: `0.10.0-rc17`;
- schema: `17`;
- runtime/deployment commit:
  `b65e3e1385f987fc78e5db88459b18b844a0a7ef`;
- commercial traffic and public registration remain disabled.

## Risk closed

The previous registration/login throttles and administrator/tenant audit
fingerprints preferred `CF-Connecting-IP`, then `X-Real-IP`, then
`X-Forwarded-For`. The production Caddy edge overwrote the latter two but did
not delete an arbitrary client-supplied Cloudflare header. A direct Internet
client could therefore select the value used for throttling and audit even
though it could not reach the loopback-bound Gateway directly.

rc17 introduces one shared resolver with these invariants:

- production reads no forwarding header until
  `RELAY_TRUST_PROXY_HEADERS=1`;
- exactly one of `x-real-ip`, `x-forwarded-for` or `cf-connecting-ip` is selected
  by `RELAY_CLIENT_IP_HEADER`;
- all competing headers are ignored rather than prioritized;
- selected values must parse as an IPv4/IPv6 address; malformed or unexpected
  multi-values become `unknown`;
- IPv4-mapped IPv6 is canonicalized;
- administrator login throttles/sessions, SaaS registration/login/recovery
  throttles and tenant audit HMACs use the same resolver;
- production `/readyz` fails closed when the trusted boundary is absent or
  unsupported.

## Edge contract

The live Gateway publishes only `127.0.0.1:8088`. The inspected Caddy
configuration for both the HTTP-IP and HTTPS nip.io sites overwrites:

- `X-Real-IP` with `{remote_host}`;
- `X-Forwarded-For` with `{remote_host}`;
- forwarded proto and host with edge-derived values.

Production now sets:

```text
RELAY_TRUST_PROXY_HEADERS=1
RELAY_CLIENT_IP_HEADER=x-real-ip
```

Thus a supplied `CF-Connecting-IP` or `X-Forwarded-For` cannot override the
identity chosen by Relay. Deployment/configuration documentation contains the
same Caddy and fail-closed contract.

## Verification

- Relay tests: 342 passed;
- commercial tests: 73 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same two platform skips;
- TypeScript, ESLint, production build and dependency audit passed; audit found
  zero known vulnerabilities;
- tests cover untrusted production defaults, forged competing headers,
  explicit Cloudflare/X-Forwarded-For selection, malformed/multi-value input,
  IPv4-mapped IPv6, administrator throttling/session hashing, tenant audit HMAC
  and production readiness rejection;
- a container preflight using the exact production Compose environment returned
  `ready=true`, `client_network=ok`, header `x-real-ip`, and no blockers;
- external HTTPS `/readyz` reports the same mandatory item and valid release
  identity; TLS verification passed.

## Production and recovery evidence

- PostgreSQL remains schema17 with 46 public tables, 17 migrations, five
  internal accounts and zero tenant/email rows;
- one Worker and the Scheduler heartbeat remain online;
- release evidence:
  `/opt/backups/relay-release-evidence-b65e3e1385f9`;
- release-manifest SHA-256:
  `77ec2426ea64b80df71e587cb369c30393ef6bf977535a1f7e550f944e9b5625`;
- CycloneDX production SBOM SHA-256:
  `c99c9cd3ea33c3fb9441a0ebf10fbdf04a7d0f8a07d25ea28aca55bbeeba57e2`;
- final backup:
  `/opt/backups/relay-client-network-final-20260830054626`;
- all checksums, control-plane dry-run, complete Git bundle, PostgreSQL restore
  and object-media verification passed; restored state matched schema17,
  46 tables, 17 migrations, five accounts, zero tenants/email deliveries and
  96 objects / 45,849,211 bytes;
- the isolated restore database and staging directory were removed.

