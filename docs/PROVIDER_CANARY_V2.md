# Provider canary v2

Existing control-plane canary is unchanged. This layer **schedules** it.

Each provider/kind/time-window is protected by a Redis `SET NX` dispatch lease,
so multiple Gateway replicas enqueue exactly one canary.

## Structural (default 5–10 min + jitter)

ChatGPT: login, composer, send, assistant, model state  
Gemini: login, composer, send/generate, image result **structure**  
Leonardo: login, AI Creation, model selector, Generate, result container  

`kind=canary` does **not** produce a billed image.

## Paid real image canary

`REAL_IMAGE_CANARY_INTERVAL` (default `3h`, also `1h` / `6h`). Independent of the structural ticker so structure probes cannot drain Leonardo/Gemini quota every few minutes.

Paid due items enqueue one real 1:1 image on the provider's designated canary
account. A due item is never marked successful merely because it was skipped.

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
Active/candidate/pass state is shared through Redis. A structural DOM failure
proposes the repository's bounded fallback pack; customer jobs read the shared
active pack, while canaries exercise the candidate until promotion/rollback.

## Queue

See `BACKPRESSURE.md`. Structural canaries bypass customer caps; real paid image
canaries use normal image admission.

Live automatic canary loop: **NOT_EXECUTED**.
