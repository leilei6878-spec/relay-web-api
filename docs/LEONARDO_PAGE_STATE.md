# Leonardo Page State

Classifier: `src/lib/provider/page-state.ts` + worker `detect_page_state(page, "leonardo")`.

Missing Generate is **not** session death.

| State | Signal | Error | Pool |
|---|---|---|---|
| LOGIN_REQUIRED | `/auth/login`, Sign In/Sign Up nav, no session | `LEONARDO_LOGIN_REQUIRED` | demote account, switch |
| CHALLENGE | captcha / turnstile / just a moment | `LEONARDO_CHALLENGE` | no failCount, no switch |
| TOKEN_EXHAUSTED | out of tokens / insufficient tokens | `LEONARDO_TOKEN_EXHAUSTED` | cool, skip future dispatch |
| QUEUE_FULL | queue is full / too many pending | `LEONARDO_QUEUE_FULL` | cool, switch |
| RATE_LIMITED | rate limit copy | `LEONARDO_RATE_LIMITED` | cool, switch |
| ACCOUNT_RESTRICTED | banned / suspended | `LEONARDO_ACCOUNT_RESTRICTED` | banned, switch |
| IMAGE_GENERATOR_READY | composer + Generate, not a login wall | — | — |
| MODEL_SELECTOR_READY | Model: menu opened | — | — |
| MODEL_UNAVAILABLE | menu listed, requested label absent | `LEONARDO_MODEL_UNAVAILABLE` | cool, switch (account capability) |
| GENERATION_PENDING / RUNNING / COMPLETE / FAILED | after Generate | timeout / result-not-found / failed | see failure matrix |
| DOM_UNKNOWN + selector miss | composer/generate/model menu gone while authenticated | `LEONARDO_DOM_CHANGED` | **circuit trip**, no pool walk |

Token digits are recorded only when the page can be read reliably. Otherwise `tokenState=UNKNOWN`. Never invent remaining_fast_tokens.
