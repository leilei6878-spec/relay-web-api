# Canary Design

Each provider may mark one or more accounts with `canary: true`.

When the provider circuit is `OPEN` or `HALF_OPEN`, `pickAccount` returns **only** canary accounts. If none exist, dispatch fails closed (`PROVIDER_UNAVAILABLE: circuit OPEN, no canary`) instead of iterating the pool.

## Probe steps

`src/lib/canary.ts`:

1. `dns_network`
2. `login_state`
3. `input_selector`
4. `send_action`
5. `response_detection`
6. `image_generation_path` (Gemini only)

A probe outcome is applied with `applyCanaryProbe` → `recordCanaryResult`. That updates **Provider Health**, never `failCount`.

## What was actually executed

- Control-plane effect of canary success/failure: **PASS** (`circuit.test.ts`).
- Live browser probe against chatgpt.com / Gemini (DNS, selector, send, image path): **not executed** in this sandbox. No production ChatGPT/Gemini session was driven as a canary this round.

Do not treat the live probe path as soak-proven.
