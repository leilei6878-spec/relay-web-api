# Delivery Baseline

Frozen after Phase 0 save. This is the commit that first contained the
production-hardening campaign **on GitHub**, not only in the Grok workspace.

| Field | Value |
|---|---|
| commit SHA | `2c75aaf7fe93cf60e728fbcc74d4bdf83edefe1c` |
| short | `2c75aaf` |
| branch | `main` |
| remote | `https://github.com/leilei6878-spec/relay-web-api.git` (private) |
| build timestamp | `2026-08-26T01:20:00Z` (commit time) |
| Node version | `v22.23.2` (workspace); Docker image `node:22-bookworm-slim` |
| schema version | `3` (`migrations/0003_relay_production.sql`) at this SHA |
| API version | `v1` (`/v1/chat/completions`, `/v1/responses`, `/v1/images/*`, `/v1/models`) |
| app version (planned RC) | `0.9.0-rc1` — tag created only after remaining delivery blockers close |

## Tests at this SHA

| Suite | Result |
|---|---|
| `npm run test:relay` | **69/69 PASS** |
| `scripts/multi-process-lease.test.mjs` | PASS (included in `npm test`) |
| `scripts/multi-process-job-claim.test.mjs` | PASS |
| `scripts/pg-cutover.test.mjs` | PASS |
| `npm test` full | **200 PASS / 6 FAIL** — all 6 are `scripts/grok-pwa-plugin.test.mjs` share-card chrome (og:title uses app name `Relay`). **Not Relay business logic.** |
| 1h soak | **NOT_EXECUTED** at this SHA |
| `docker compose up` | **NOT_EXECUTED** (no Docker in this workspace) |

## Secret handling at this SHA

- `storage/` is gitignored (sessions, api-keys, admin/worker tokens, secrets.json).
- Hardcoded Shadowsocks share-link **removed from HEAD**. It remains in git history of `ab0de46` / `src/lib/proxy-link.ts` and **must be rotated** if that node is still live. See `docs/SECURITY_RELEASE_REVIEW.md`.

## What this SHA is

A recoverable source snapshot of Security / Lease / Failover / Persistence /
Gemini fail-closed / Circuit / Canary / MediaStore. It is **not** yet a
Release Candidate. RC requires the delivery phases in this campaign
(config contract, Docker, CI, backup/restore proof, OpenAPI, healthz).
