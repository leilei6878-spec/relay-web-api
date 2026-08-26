# Leonardo Token and Queue

Leonardo web plans have Fast Tokens / Token Bank / queue / concurrent generation. Relay does not assume GPT Image 2 or Gemini-family is unlimited.

## Recorded when readable

- `tokenState`: `TOKEN_AVAILABLE` | `TOKEN_LOW` | `TOKEN_EXHAUSTED` | `UNKNOWN`
- `queueDepthHint` (integer only if UI yields a number)
- `planHint` (non-secret plan name if visible)

Unreadable values stay `UNKNOWN`. Scheduler treats:

| State | Dispatch |
|---|---|
| TOKEN_AVAILABLE / UNKNOWN / TOKEN_LOW | allowed |
| TOKEN_EXHAUSTED | **blocked** until a later probe clears it |

Worker copy that trips TOKEN_EXHAUSTED: “out of tokens”, “no tokens remaining”, “insufficient tokens”. Queue: “queue is full”, “too many pending generations”.

First-stage concurrency per account is **1** even if the membership allows more.
