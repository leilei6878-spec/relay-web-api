# Playwright concurrency V2

`concurrencyPerWorker=3` is real browser concurrency only if Playwright
jobs do not share a single `pw_loop` thread.

## Sharded sync Playwright

`RELAY_PLAYWRIGHT_SHARDS` (default **3**) starts N independent shards:

| Per shard | Isolated |
|---|---|
| `sync_playwright()` | yes |
| Playwright thread | yes |
| Browser pool | yes |
| Context pool | yes |
| Job queue | yes |

Routing:

```
account_id → stable FNV shard index
same account → same shard (serial on that queue)
different accounts → may run in parallel
```

Global `ACCOUNT_LOCKS` still enforces **max_active_per_account = 1**.
Process `SEM` still caps in-flight jobs at `RELAY_CAPACITY`.

Gateway poll no longer waits for Playwright before the next claim.
Claimed jobs are dispatched on helper threads; each helper blocks on
its shard queue. The gateway `runningHere >= capacity` check remains
the admission cap.

## Not this commit

- `async_playwright` rewrite (V3 if data requires it)
- Live 5×20 concurrent Chat/Image matrix — **NOT_EXECUTED**

## Unit coverage

- `shard_for_account` is deterministic
- three distinct accounts overlap (`max_active_playwright_jobs >= 2`)
- the same account stays serial (`max_active_per_account = 1`)
