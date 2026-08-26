# Public API

OpenAPI machine contract: [`openapi.yaml`](../openapi.yaml). Admin/Worker APIs are **not** in that file.

Auth: `Authorization: Bearer sk-relay-…` (or `x-api-key`). Worker/Admin tokens return 401 on `/v1/*`.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/models` | ChatGPT + Gemini + `leonardo-gpt-image-2` + `leonardo-gemini` |
| POST | `/v1/chat/completions` | Multi-turn, vision, `stream: true` SSE |
| POST | `/v1/responses` | OpenAI responses subset |
| POST | `/v1/images/generations` | Gemini or Leonardo (`leonardo-*`); fail-closed; stable media URL |
| POST | `/v1/images/edits` | multipart; `mask` → 400 |

Unsupported JSON fields on chat completions are **rejected**, not ignored.

Errors: 401 invalid key, 403 missing scope, 429 quota, 400 bad input, 422/502 provider fail-closed.

Idempotency: header `Idempotency-Key`.
