# Acceptance Report — v0.9.0-rc1

Status values: **PASS** | **PARTIAL** | **FAIL** | **NOT_EXECUTED**

| Item | Status | Evidence |
|---|---|---|
| GitHub save of hardening campaign | PASS | `2c75aaf` pushed to `origin/main` |
| Hardcoded proxy secret removed from HEAD | PASS | `proxy-link.ts`; secret-scan test |
| Production fail-closed | PASS | `production-guard.test.ts` |
| PostgreSQL SoT in production | PASS | persist-mode + pg-cutover tests |
| Redis atomic multi-process | PASS | multi-process-lease/job-claim (fake RESP) |
| JSON→PG dry-run | PASS | `migrate-json.test.mjs` |
| Backup/restore round-trip | PASS | two PGlite instances, schema 4 |
| `/healthz` `/readyz` `/metrics` | PASS | routes + live check after preview start |
| OpenAPI public-only | PASS | `openapi.yaml` + contract test |
| CI workflow file | PASS | `.github/workflows/ci.yml` |
| First GitHub Actions run | NOT_EXECUTED | until this push |
| Docker compose up from empty clone | NOT_EXECUTED | no Docker daemon here; files present |
| Packaged Redis restart | NOT_EXECUTED | |
| Live S3/R2 PUT | NOT_EXECUTED | SigV4 unit only |
| Live ChatGPT/Gemini canary | NOT_EXECUTED | |
| 1h / 12h / 24h / 48h soak | NOT_EXECUTED | script exists (`scripts/soak.mjs`) |
| 50 / 500 account pool | NOT_EXECUTED | 5-account chaos verified |
| grok-pwa share-card tests | FAIL | 6 tests, platform chrome, not Relay API |

## Twenty questions

1. Current GitHub HEAD after this campaign: see `git rev-parse HEAD` (delivery commits on `main`).
2. Uncommitted important code: none at tag time.
3. Rebuild from a fresh machine: **yes, documented**; Docker compose itself **NOT_EXECUTED** here.
4. Need Grok workspace to run: **no**.
5. Production mock: **no** (fail-closed).
6. Production PGLite: **no**.
7. Production memory lock: **no**.
8. Production media on local ephemeral disk: **no** (config-forbidden; live S3 NOT_EXECUTED).
9. PostgreSQL unique SoT: **yes** in production mode.
10. Redis dual-node competition: **yes** against RESP children; **not** two compose gateways.
11. Duplicate execution in tests: **0 observed**.
12. Lost request in tests: **0 observed**.
13. Backup/restore actually run: **yes** (PGlite). `pg_dump` **NOT_EXECUTED**.
14. Rollback procedure: **documented**; not fire-drilled on Postgres 16.
15. CI: workflow present; Actions run **NOT_EXECUTED** until push.
16. Max verified concurrency: 20 jobs / 5 accounts in-process.
17. Max verified accounts: 5 (chaos) / 10 (unit).
18. Longest real soak: prior 3 min reliability (1504/1504). 1h **NOT_EXECUTED**.
19. PARTIAL: session encryption in preview, log redaction, CORS `*` on public API, live model-switch, Docker/S3/soak.
20. RC condition: **yes, with listed NOT_EXECUTED ops proofs**. No remaining **code** P0 BLOCKER in HEAD.

Known history issue: rotate the Shadowsocks node that appeared in `ab0de46`.
