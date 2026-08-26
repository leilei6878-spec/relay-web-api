# Provider Canary

Independent of account `failCount`.

- ChatGPT canary: network, login state, composer, model switcher, send button. Optional tiny ping when a canary account exists.
- Gemini canary: same + image path presence (not a billed generation in the control-plane probe).

`kind=canary` jobs skip account health mutation and call `recordCanaryResult`.

Circuit:

| State | Customer traffic |
|---|---|
| HEALTHY | pool |
| DEGRADED | pool (fingerprint drift) |
| OPEN | canary only |
| HALF_OPEN | canary only |

Live browser canary against chatgpt.com / gemini.google.com is **NOT_EXECUTED** in this sandbox (no production session). Control-plane + unit mapping are tested.
