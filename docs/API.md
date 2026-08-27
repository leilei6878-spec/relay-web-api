# Public API

OpenAPI machine contract: [`openapi.yaml`](../openapi.yaml). Admin/Worker APIs are **not** in that file.

Auth: `Authorization: Bearer sk-relay-…` (or `x-api-key`). Worker/Admin tokens return 401 on `/v1/*`.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/models` | ChatGPT + official GPT Image / Nano Banana / Gemini ids |
| POST | `/v1/chat/completions` | Multi-turn, vision, `stream: true` SSE |
| POST | `/v1/responses` | OpenAI responses subset |
| POST | `/v1/images/generations` | OpenAI Images drop-in: `gpt-image-*`, `nano-banana*`, `gemini-*-image`. `size` / `aspect_ratio` / `image_size` map to native pixels |
| POST | `/v1/images/edits` | multipart; `mask` → 400 |
| POST | `/v1beta/models/{model}:generateContent` | Google Gemini / Nano Banana official body (`contents` + `generationConfig.imageConfig`) |

Swap the official base URL and API key:

- OpenAI Images SDK → `baseURL` = this gateway, `apiKey` = `sk-relay-…`. Path stays `/v1/images/generations`.
- Gemini SDK / REST → host = this gateway, key via `x-goog-api-key` / `?key=` / Bearer. Path stays `/v1beta/models/{model}:generateContent`.

Unsupported JSON fields on chat completions are **rejected**, not ignored.

Errors: 401 invalid key, 403 missing scope, 429 quota, 400 bad input, 422/502 provider fail-closed.

Idempotency: header `Idempotency-Key`.
