# Chaos Test Matrix

Runner: `node scripts/chaos-harness.mjs`

Two Gateway processes + shared Postgres + Redis. Each row is a **process-level** scenario, not a mock.

| # | Scenario | How | Expected |
|---|---|---|---|
| C1 | Worker crash | Claim, wait past `RELAY_WORKER_DEAD_MS`, do not finish | Job requeued (`queued`), `requestId` kept |
| C2 | Stale worker | Worker A claims; timeout; Worker B claims; A submits old lease | Old result rejected; new text wins |
| C3 | Gateway crash | Enqueue on A; SIGKILL A; B reads same job + same Idempotency-Key | No duplicate job |
| C4 | Redis restart | Close RESP server; restart with persist file; restart gateways | Enqueue works; at most one claim winner |
| C5 | Postgres restart | SIGKILL shared-pg; restart same data dir | Job rows survive |
| C6 | Idempotency storm | 20 then 50 concurrent same key across A+B | Unique jobs = 1, provider exec = 1 |
| C7 | Account contention | 20 enqueues vs healthy pool | unique(accountId) == ok count, no double lease |
| C8 | Duplicate result | Finish twice with the same lease (A then B) | Second `STALE_LEASE`; text unchanged |
| C9 | Cancel | Claim then cancel from the other gateway | `cancelled`; account lease key gone |
| C10 | Timeout | Combined with C2 | Old worker cannot overwrite `fresh-text` |
| DOM | Provider DOM changed | Finish with `PROVIDER_DOM_CHANGED` | Pool still dispatchable (`secondOk: true`) |
| P8 | Restart recovery | Kill A+B, restart both | `phantomRunning: 0`, enqueue still works |
| P1 | Readiness | `GET /internal/readiness` | HTTP 200, `ready: true` |

In-process complements (file SoT, `RELAY_SKIP_DB=1`): `src/lib/chaos.test.ts`, `src/lib/fault-matrix.test.ts`.
