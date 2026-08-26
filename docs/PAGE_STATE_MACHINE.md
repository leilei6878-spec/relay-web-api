# Page State Machine

Selector miss is **not** session death.

```
goto(url)
  → CHALLENGE | LOGIN_REQUIRED | RATE_LIMITED | ACCOUNT_RESTRICTED
  → COMPOSER_READY | AUTHENTICATED | GENERATING | RESULT_READY
  → DOM_UNKNOWN | PROVIDER_ERROR
```

| State | Missing composer means | Account pool |
|---|---|---|
| LOGIN_REQUIRED | SESSION / LOGIN_REQUIRED | demote account |
| CHALLENGE | CHALLENGE | **no** failCount |
| RATE_LIMITED | ACCOUNT_RATE_LIMIT | cool |
| ACCOUNT_RESTRICTED | ACCOUNT_BANNED | banned |
| AUTHENTICATED / COMPOSER_READY / DOM_UNKNOWN | PROVIDER_DOM_CHANGED | **no** (trips provider circuit) |

Code: `src/lib/provider/page-state.ts` + Python `detect_page_state`.
