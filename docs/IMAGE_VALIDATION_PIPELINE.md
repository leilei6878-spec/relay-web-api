# Unified image validation pipeline

Every Gemini / Leonardo result goes through `ImageResultValidator` before HTTP 200.

```
bytes
→ magic (PNG / JPEG / WebP)
→ MIME
→ byte limits
→ dimensions (image-size)
→ aspect + native family
→ requested tier
→ sha256
→ reference hash exclusion
→ historical exclusion
→ confidence VERIFIED|HIGH
→ n == validated_results.length
```

Any step fails → not 200.

Missing confidence is rejected in the production finish path. Worker asset
metadata (sha256/MIME/bytes/dimensions/confidence) must match the gateway's
recalculation. Each account retains a bounded recent-result hash set, so the
same historical bytes are rejected even behind a new/cache-busted URL.

## Size truth

Response `relay` records:

- `requested_size`
- `actual_width` / `actual_height` / `actual_aspect`
- `requested_tier` / `actual_tier`

Client `1536x1024` maps to native `1264x848` (3:2 1K). That native is legal. `16:9` vs `1024x1024` is `OUTPUT_SIZE_MISMATCH`.

## n

Web UI capability `maxOutputs=1`. Client `n>1` is 400 `RESULT_COUNT_MISMATCH`. Never silently return fewer images.

If a future provider sets `maxOutputs=4`, `n=4` must yield 4 validated results.

Live E2E: **NOT_EXECUTED**.
