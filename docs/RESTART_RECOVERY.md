# Restart Recovery

Sequence executed in `scripts/chaos-harness.mjs`:

1. Kill Gateway A (C3) — Gateway B still served the same Request / Idempotency-Key.
2. Close Redis TCP server, reopen on the same port with the persist file, restart both Gateways (C4) — enqueue succeeded, single claim winner.
3. SIGKILL shared-pg, restart with the same data directory (C5) — `jobCount: 24` survived.
4. SIGKILL Gateway A and B, start both again (P8) — `phantomRunning: 0`, new enqueue succeeded.

| Check | Result | Data |
|---|---|---|
| Request not lost across Gateway kill | **PASS** | C3 same job id, replay true |
| No duplicate execution after Gateway kill | **PASS** | idempotency replay |
| Redis restart does not double-claim | **PASS** | winners 1 |
| Postgres data dir restart keeps jobs | **PASS** | 24 jobs |
| No phantom `running` after dual Gateway restart | **PASS** | phantomRunning 0 |
| Expired leases / dead workers reclaim to `queued` | **PASS** | C1 status queued |
| Account not permanently locked | **PASS** | `/v1/unlock-all` + `locked_until IS NULL` after finish/cancel |
| Provider health recoverable | **PASS** | DOM_CHANGED left pool dispatchable |

## Resume

```
node scripts/chaos-harness.mjs
RELAY_RELIABILITY_MS=3600000 node scripts/reliability-run.mjs
```

Checkpoints:

- `storage/chaos-harness-report.json`
- `storage/reliability-run.json`
