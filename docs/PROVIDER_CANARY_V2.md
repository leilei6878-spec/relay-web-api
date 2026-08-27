# Provider canary v2

Existing control-plane canary is unchanged. This layer **schedules** it.

## Structural (default 5–10 min + jitter)

ChatGPT: login, composer, send, assistant, model state  
Gemini: login, composer, send/generate, image result **structure**  
Leonardo: login, AI Creation, model selector, Generate, result container  

`kind=canary` does **not** produce a billed image.

## Paid real image canary

`REAL_IMAGE_CANARY_INTERVAL` (default `3h`, also `1h` / `6h`). Independent of the structural ticker so structure probes cannot drain Leonardo/Gemini quota every few minutes.

## Circuit

Multiple independent accounts `DOM_CHANGED` → DEGRADED. Canary confirms failure → OPEN. OPEN customer traffic is refused.

## Selector candidate

```
candidate_selector_pack
→ canary
→ N consecutive PASS (N >= 3)
→ promote to active
```

Any fail rolls the candidate back. Active pack is untouched until promote.

## Queue

When queued+running depth ≥ `RELAY_QUEUE_CAP` (default 200): HTTP **429** `QUEUE_FULL`. Canary jobs bypass the cap. Drain remains `markWorkerDraining`.

Live automatic canary loop: **NOT_EXECUTED**.
