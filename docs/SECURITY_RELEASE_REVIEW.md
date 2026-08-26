# Security Release Review

Date: 2026-08-26. HEAD after delivery commits on `main`.

## Dependency audit

Run on the release host: `npm audit --omit=dev`. Not executed as a gate in this workspace.
CI does not fail the build on npm audit yet (noise vs supply-chain). Track as PARTIAL.

## Secret scan (HEAD)

`scripts/secret-scan.test.mjs` greps the index for:

- live `ss://…@x.x.x.x` share links
- `ghp_` / `github_pat_`
- RSA private keys

HEAD: **PASS** (share-link removed in `2c75aaf`).

## Git history

`ab0de46` `src/lib/proxy-link.ts` **contained a real Shadowsocks share-link**
(`Japan-BGP-SS2022` @ `38.175.201.137:8443`).

**Action: rotate that node password/port if the node is still in service.**
History rewrite was not performed (already pushed; coordinate with the owner).

No GitHub PATs in tree.

## Route auth

| Surface | Auth |
|---|---|
| `/v1/*` | Customer `sk-relay-` |
| `/api/worker/*` | Worker `wk-relay-` |
| `/api/admin/*`, `/internal/readiness` | Admin `ad-relay-` or cookie |
| `/api/runtime`, `/healthz`, `/readyz` | Unauthenticated, no secrets |
| `/metrics` | Open unless `RELAY_METRICS_TOKEN` |

## Session / proxy leakage

- Control plane JSON/DB extra field strips `password`.
- Worker claim still receives the bound proxy password **for that job** — required to open the browser. Treat worker host as trusted.
- `/api/runtime` does not return keys (regression test).

## CORS

Public API `*`. Admin session cookie is HttpOnly + SameSite=Lax. Do not put the admin cookie on a public CDN origin without `RELAY_REQUIRE_ADMIN_LOGIN=1`.

## Log redaction

PARTIAL. Proxy passwords are `***` in public objects. Install a request logger that redacts `Authorization` before production traffic.
