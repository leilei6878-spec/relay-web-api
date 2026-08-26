# Relay

Web-to-API gateway: ChatGPT (chat + vision) and Gemini (image generation) behind an OpenAI-compatible HTTP API, with an account pool, sticky proxies, leases, and a worker fleet.

You do **not** need the Grok workspace to deploy this. Start at [docs/QUICK_START.md](docs/QUICK_START.md).

## Public API

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

Machine contract: [`openapi.yaml`](openapi.yaml). Admin/Worker APIs are not in that file.

## Ops

| Doc | Topic |
|---|---|
| [docs/QUICK_START.md](docs/QUICK_START.md) | Clone, run, first key |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker / bare metal |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Fail-closed env |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Admin / Customer / Worker |
| [docs/MONITORING.md](docs/MONITORING.md) | `/healthz` `/readyz` `/metrics` |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | Backup |
| [docs/UPGRADE.md](docs/UPGRADE.md) / [ROLLBACK.md](docs/ROLLBACK.md) | Releases |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Incidents |
| [docs/ACCEPTANCE_REPORT.md](docs/ACCEPTANCE_REPORT.md) | RC evidence |

## Safety

Do not commit `storage/`, `.env`, sessions, API keys, or proxy passwords. Production refuses to start on PGLite, in-memory locks, mock providers, or local ephemeral media.

## Version

See `src/lib/release.ts`. Schema version follows `migrations/`.
