# Leonardo Model Mapping

Relay never exposes Leonardo account emails, cookies, or internal generation ids to API clients.

## Logical → web

| Logical | `webId` | Web labels (candidates) | Status |
|---|---|---|---|
| `leonardo-gpt-image-2` | `gpt-image-2` | GPT Image 2, GPT Image | **UNVERIFIED on logged-in /generate**. Not visible on logged-out home. |
| `leonardo-gemini` | `LEONARDO_GEMINI_MODEL` or `auto` | Nano Banana 2, Nano Banana, Gemini Image 2, Gemini 2.5 Flash Image | **Nano Banana** seen as marketing on public home. Logged-in menu **UNVERIFIED**. |

`LEONARDO_GEMINI_MODEL=auto|nano-banana-2|gemini-image-2|gemini-2.5-flash-image`

`auto` uses `pickGeminiLabel(available)` against the labels the worker actually scraped from the Model menu. If none match → `LEONARDO_MODEL_UNAVAILABLE` for that account (switch account). If the menu cannot be opened → `LEONARDO_DOM_CHANGED` (provider circuit, no pool walk).

## Parameters (web_account)

| Param | API validation | Web application |
|---|---|---|
| prompt | required | `#home-prompt-textarea` **VERIFIED** public home |
| n | 1–8 | Quantity control **UNVERIFIED**. n=1 proceeds. n>1 without a control → `LEONARDO_DOM_CHANGED` |
| size | `1024x1024` and `\d+x\d+` | Mapped to nearest of 1:1, 2:3, 16:9, 4:3, 4:5, 9:16 (**VERIFIED** public home) |
| quality | LOW/MEDIUM/HIGH | Control **UNVERIFIED**. MEDIUM default is skipped. HIGH/LOW without a control → fail closed |
| images[] | max 6 | `Add image reference` + `input[type=file]` **VERIFIED** public home |
| seed / style / strength / enhance | rejected unless recon confirms | not advertised |

Official size hints for GPT Image 2: 1024×1024, 848×1264, 1264×848, 1376×768, 768×1376. Other `\d+x\d+` values are accepted and snapped to the closest **visible** aspect.

## official_api (not default)

Thin mapping to `POST https://cloud.leonardo.ai/api/rest/v2/generations` lives in `leonardo-api.ts`. Requires `LEONARDO_API_KEY` as `LeonardoProductionApiCredential`. Gateway image route does **not** call it.
