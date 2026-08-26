# ChatGPT Streaming

## Path

```
ChatGPT assistant node
  → MutationObserver (scoped after send, count > before)
  → delta vs previous full text
  → Worker POST /api/worker/chunk
  → Gateway subscribeJob
  → OpenAI SSE data: { choices[0].delta.content }
```

Disconnect: SSE abort cancels the job (`REQUEST_CANCELLED: disconnect`). Worker still finishes the in-flight Playwright loop unless the generation idle window fires first.

## Timing

| | P50 | Notes |
|---|---|---|
| first_dom_delta (T8) | 3.7–5.6s from request | includes ~1.5s Relay + ~2.8s model |
| first_sse_delta | 3753 ms (API n=5) | |
| DOM→SSE extra | target <100ms | not isolated; chunk POST is best-effort |

## Complete

Not “2 identical polls”. Request-scoped:

1. Snapshot assistant_count before send
2. Observer only reads nodes after that count
3. Stop control optional
4. Complete when full text idle ≥1.8s, or stop gone + idle ≥0.45s

## 30s UI waits

Removed. Staged:

- PAGE_READY 8s
- COMPOSER 4s
- INPUT 1s
- SEND 1.5s
- SEND_ACK 4s
- default Playwright action timeout 4s
