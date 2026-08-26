# Leonardo Provider

Third official Relay provider. Image generation only. Backend default: **`web_account`**.

Official REST (`official_api`) exists as a future adapter in `src/lib/provider/leonardo-api.ts` and is **not** the production path. Web subscription credits and API credits are billed separately. Session cookies are never reused as an API key.

## Logical models

| Relay id | Web target |
|---|---|
| `leonardo-gpt-image-2` | GPT Image 2 (`gpt-image-2`) |
| `leonardo-gemini` | Env `LEONARDO_GEMINI_MODEL` (`auto` default) picks the Gemini/Nano Banana label actually present on the logged-in Image Generator |

`auto` prefers, in order, labels that exist on **that account's** model menu: Nano Banana 2 → Nano Banana → Gemini Image 2 → Gemini 2.5 Flash Image. Names are not hardcoded as the only selectable web model.

## Runtime

Same contracts as ChatGPT/Gemini:

- Account-bound proxy (login IP = generation IP)
- Independent BrowserContext / storage_state / `session_version` CAS
- Redis account lease, concurrency **1** per Leonardo account
- Provider circuit on DOM / selector failure (does not walk the pool)
- Fail-closed image gate + MediaStore
- Observability: `provider=leonardo`, `backend_mode=web_account`, logical vs actual model, page state

Scheduler order: capability → HEALTHY → session → model available → proxy → token → queue → not leased → LRU → lease.

`TOKEN_EXHAUSTED` accounts are not dispatched. Accounts whose `availableModels` is known and does not include the requested logical model are skipped. Empty `availableModels` means unknown (first probe allowed).

## Worker

`run_leonardo` in the Playwright worker:

1. Open `/generate` (fallback home)
2. Classify page state (login / challenge / token / queue / composer)
3. Open **Model:** menu, enumerate labels, click the mapped one
4. Fill prompt (`#home-prompt-textarea`), optional references (max 6)
5. Aspect from recon'd `Aspect ratio: *` buttons
6. Quantity/quality only if the control is actually present; otherwise fail closed when the client asked for n>1 or explicit HIGH/LOW
7. Snapshot existing `<img>` srcs, click Generate, accept only **new** non-UI images on `leonardo.ai` hosts
8. Download bytes in the browser context, reject SVG / tiny assets
9. Persist via Relay MediaStore

Canary (`kind=canary`) stops after model-menu probe. It does not click Generate.

## Recon status

Logged-in `/generate` was **not** available in this environment (no Leonardo session). Selectors that shipped are from the public home + login redirect recon (`docs/LEONARDO_UI_RECON.md`). GPT Image 2 / Gemini family labels on the logged-in menu, token UI, quantity, quality, and result gallery remain **UNVERIFIED** until a real session exists. Missing controls fail closed; they are not faked.
