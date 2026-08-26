# API Compatibility

Supported (OpenAI-shaped, not a full clone):

| Endpoint | What works | Explicit 400 |
|---|---|---|
| `GET /v1/models` | ids + capabilities metadata | — |
| `POST /v1/chat/completions` | messages (system/user/assistant), vision, stream | unknown params |
| `POST /v1/responses` | `input` string/messages, vision, stream | tools, temperature, previous_response_id, … |
| `POST /v1/images/generations` | prompt, optional reference images | `mask`, unknown params |
| `POST /v1/images/edits` | multipart prompt+image | `mask` (unsupported), missing image |

Usage is estimated tokens on chat/stream. Image usage remains 0 (no tokenizer for pixels).

SDK: a stock OpenAI client can call these URLs with a Relay key. Relay-specific fields live under `relay`.
