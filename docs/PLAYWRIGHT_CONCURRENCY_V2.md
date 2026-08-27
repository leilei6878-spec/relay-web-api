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

Warmup uses the same routing: `warmup_plan` only warms accounts whose
`shard_for_account(id) == current_shard`, and only through that
account's bound proxy. Missing proxy → skip warmup (never pick_proxy).

## Live 5 × 20 (Commit 12)

Target:

```
5 healthy accounts
20 simultaneous requests
3 shards
max_active_playwright_jobs >= 2
max_active_per_account == 1
```

**NOT_EXECUTED.** This environment does not have five healthy live
provider sessions to drive. If fewer than five healthy accounts are
present at run time the gate is **BLOCKED_BY_ACCOUNT_COUNT**, not PASS.

Unit tests with synthetic accounts prove shard overlap ≥ 2 and
per-account serial = 1. That is not the live 5×20 matrix.

## Not this campaign

- `async_playwright` rewrite (V3 if data requires it)

## Unit coverage

- `shard_for_account` is deterministic
- three distinct accounts overlap (`max_active_playwright_jobs >= 2`)
- the same account stays serial (`max_active_per_account = 1`)
- warmup respects shard owner and bound proxy
- same account is not warmed in multiple shards
