# Selector Versioning

Packs:

- `chatgpt-v1` (current), `chatgpt-v2` (bounded fallback)
- `gemini-v1`

Max 4 selectors per slot. After primary + one fallback pack fail → `PROVIDER_DOM_CHANGED` and provider health, **not** account invalidation.

Jobs record `selector_pack_version`. Worker returns the pack it used plus a fingerprint of element existence / data-testid list (no page text).
