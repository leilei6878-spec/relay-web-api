# Provider Architecture

Gateway no longer owns ChatGPT/Gemini DOM details. Provider-specific logic lives in `src/lib/provider/`.

```
Client → /v1/* → Adapter.prepareRequest() → Job queue → Worker
                                           ↘ Adapter.normalizeError()
Worker → page-state + selector pack + result → Adapter.verifyModel / extractResult
```

## Adapter surface

`ProviderAdapter` (`src/lib/provider/types.ts`):

| Method | Owner |
|---|---|
| `capabilities()` | TS |
| `validateSession()` | TS (`session-probe`) |
| `detectPageState()` | TS from signals; Python live page |
| `prepareRequest()` | TS prompt-map (role-delimited conversion) |
| `executeChat/Image/stream/cancel` | Python worker (Playwright) |
| `normalizeError()` | TS + page state |
| `healthCheck()` | circuit snapshot |
| `refreshSession()` | CAS in `session-cas.ts` on worker write-back |
| `extractResult()` | TS (Gemini image gate) + Python download |
| `verifyModel()` | TS label match |
| `selectorPack()` | versioned packs |
| `fingerprint()` | DOM feature hash |

## What Gateway must not know

`completions.ts` / `images/*.ts` call `prepareChatRequest` and enqueue. They do not mention `#prompt-textarea` or Gemini `ql-editor`.

## Conversion layer

ChatGPT web cannot inject a native OpenAI conversation. `toWebPrompt` emits `<relay:ROLE>` blocks so roles stay distinct. This is intentional, not a silent concat.
