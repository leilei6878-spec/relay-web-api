# Gemini / Leonardo warm runtime

Image pages stay open across requests.

```
WARM_IDLE → next request (no navigation)
DIRTY → cleanup prompt/refs → WARM_IDLE or recycle
GENERATING → wait
INVALID / CONTEXT_DEAD → new page
```

Only `WARM_IDLE` takes the next request.

After every request:

- Gemini: clear composer and attachments
- Leonardo: clear prompt and every reference card (`reference_count=0`)

Request B must not carry Request A’s prompt or references.

Metrics: `warm_hit`, `warm_miss`, `warm_recycle`, `reset_ms`, `navigation_ms`.

Live warm-hit E2E: **NOT_EXECUTED**.
