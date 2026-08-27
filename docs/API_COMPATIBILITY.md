# API Compatibility

Supported (OpenAI-shaped, not a full clone):

| Endpoint | What works | Explicit 400 |
|---|---|---|
| `GET /v1/models` | ids + capabilities metadata | — |
| `POST /v1/chat/completions` | messages (system/user/assistant), vision, stream | unknown params |
| `POST /v1/responses` | `input` string/messages, vision, stream | tools, temperature, previous_response_id, … |
| `POST /v1/images/generations` | OpenAI Images: `prompt`, `model`, `n`, `size` (`1024x1024` / `1536x1024` / `1024x1536` / `16:9` / `1K`…), `quality`, `aspect_ratio`, `image_size`. GPT Image defaults to `b64_json` | `mask`, unknown params |
| `POST /v1/images/edits` | multipart prompt+image | `mask` (unsupported), missing image |
| `POST /v1beta/models/{model}:generateContent` | Google imageConfig `aspectRatio` + `imageSize`; response `candidates[].content.parts[].inlineData` | unsupported `:action` |

Official size mapping (selected → generated native pixels):

| Request | GPT Image | Nano Banana / Gemini Image |
|---|---|---|
| `1024x1024` / `1:1` / `1K` | 1024×1024 | 1024×1024 |
| `1536x1024` / `3:2` | 1264×848 | 1264×848 |
| `1024x1536` / `2:3` | 848×1264 | 848×1264 |
| `16:9` | 1376×768 | 1376×768 |
| `9:16` | 768×1376 | 768×1376 |
| `2K` 1:1 | 2048×2048 | 2048×2048 |
| GPT Large 1:1 | 2880×2880 | — |
| `4K` 1:1 | — | 4096×4096 |

Usage is estimated tokens on chat/stream. Image usage remains 0 (no tokenizer for pixels).

SDK: a stock OpenAI client can call these URLs with a Relay key. Relay-specific fields live under `relay`.
