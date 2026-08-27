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

Not “2 identical polls”, not Stop-only, **not 350ms idle**.

Request-scoped detector (`docs/CHAT_COMPLETION_DETECTION.md`):

1. Snapshot assistant_count before send; observer only reads nodes after that count
2. Stream every mutation immediately (TTFT unchanged)
3. Stop control is a **high-confidence** signal when seen then gone — never required
4. Fallback: last mutation stable `RELAY_CHAT_STABLE_MS` (1500) + confirm `RELAY_CHAT_CONFIRM_MS` (600)
5. Re-read DOM at confirm; `relay.finalText` replaces the client accumulator if it drifted
6. Deadline without confirm → `RESULT_UNCERTAIN` with **partial text**, job **not** ok

HTTP 200 on the SSE envelope is transport only. Logical success requires `relay.phase=done` or `finish_reason=stop` and no error.
## 30s UI waits

Removed. Staged:

- PAGE_READY 8s
- COMPOSER 4s
- INPUT 1s
- SEND 1.5s
- SEND_ACK 4s
- default Playwright action timeout 4s
