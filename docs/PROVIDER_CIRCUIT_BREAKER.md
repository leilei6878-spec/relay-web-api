# Provider Circuit Breaker

Per provider (`chatgpt` | `gemini`):

```
HEALTHY → DEGRADED → OPEN → HALF_OPEN → HEALTHY
```

Implementation: `src/lib/circuit.ts` (Redis/memory `SET NX` + `INCR` over a time window).

## Trip

If **three distinct accounts** report `PROVIDER_DOM_CHANGED` or `PROVIDER_UNAVAILABLE` in the window (`RELAY_CIRCUIT_WINDOW_MS`, default 60s; trip threshold `RELAY_CIRCUIT_TRIP`, default 3):

- state → `OPEN`
- `canDispatch(provider, isCanary=false)` is false
- the scheduler must not consume the rest of the pool

Two unique accounts in the window → `DEGRADED`.

The same account repeating the same error in the same window counts once (`SET NX` on `circuit:{provider}:{code}:acct:{id}:{window}`).

## OPEN / HALF_OPEN

- OPEN: only a **Canary Account** may run.
- After `RELAY_CIRCUIT_OPEN_MS` (default 30s) the next `getCircuit` promotes OPEN → HALF_OPEN.
- HALF_OPEN still routes through canary (`pickAccount` filters `account.canary`).
- Canary success (`recordCanaryResult(ok=true)`) deletes circuit keys → HEALTHY.
- Canary failure re-opens.

Verified: `src/lib/circuit.test.ts` (unique-account trip + canary close/reopen).
