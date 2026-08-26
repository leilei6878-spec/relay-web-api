# Browser Runtime Benchmark

## Production config (current best)

- 1 headed Chromium (Xvfb)
- 1 BrowserContext per account
- 1 warm ChatGPT page, temporary chat
- Playwright owner thread (no cross-thread sync API)
- Account concurrency = 1
- Account-bound SOCKS (Xray local inbound)
- storage_state loaded at warm; not round-tripped each job

## Measured (1 account)

| | Result |
|---|---|
| 1 Chromium / 1 account | VERIFIED, warm page_ready P50 85ms |
| 1 Chromium / 5 accounts | NOT_EXECUTED (only one real Plus session) |
| 1 Chromium / 10 accounts | NOT_EXECUTED |
| persistent user_data_dir vs storage_state | NOT_EXECUTED — no rewrite without gain |
| Resource intercept A (none) | NOT_EXECUTED as isolated A/B |
| Resource intercept B (media only) | NOT_EXECUTED |
| Resource intercept C (aggressive) | NOT used in production; only analytics hosts aborted |

## Warm page

- max requests 20 / max age 2700s then recycle page
- After each request: JS new-chat click, not full `goto`
- Isolation: temporary chat + new chat; `conversation_isolation_test` is selector-level (script contains temp-chat + new-chat). Cross-prompt leak test **PARTIAL**.

## Recovery levels

1. Re-query composer  
2. Reload  
3. New page  
4. New context (idle recycle)  
5. Browser process reset only on Playwright thread death  

Selector miss no longer closes Chromium.
