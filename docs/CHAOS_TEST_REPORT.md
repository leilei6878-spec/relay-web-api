# Chaos Test Report

Date: 2026-08-25T17:39:52Z

Runner: `node scripts/chaos-harness.mjs`

Topology actually started:

- shared-pg (PGLite file dir `/tmp/relay-pgdata`) on `:19010`
- RESP Redis on a random TCP port
- Gateway A `:19001` (`gw-a`)
- Gateway B `:19002` (`gw-b`)

Raw JSON: `storage/chaos-harness-report.json`

**18 / 18 PASS. 0 FAIL.**

| # | Scenario | Result | Evidence |
|---|---|---|---|
| seed | 8 accounts | **PASS** | `accounts: 8` |
| P4 | B sees A's request | **PASS** | id `d606b006-d5ca-4967-b29d-c98a8a33e5d1` on both |
| P4 | two workers one claim | **PASS** | `winners: 1` |
| P4 | no double account lease | **PASS** | leased 6 unique 6 |
| C6 | Idempotency × 20 | **PASS** | uniqueJobs 1, execs 1, ok 20 |
| C6 | Idempotency × 50 | **PASS** | uniqueJobs 1, ok 50 |
| C8 | duplicate finish | **PASS** | second `STALE_LEASE: job already terminal`, text `first` |
| C2 | stale worker | **PASS** | stale `lease_id mismatch`; text `fresh-text`; status `done` |
| C10 | timeout old result | **PASS** | text `fresh-text` status `done` |
| C1 | worker crash | **PASS** | status `queued`, requestId `R-crash` |
| C9 | cancel | **PASS** | status `cancelled`, lease `null` |
| C7 | 20 vs pool | **PASS** | ok 6 unique 6 fail 14 |
| DOM | DOM_CHANGED | **PASS** | second enqueue `ok: true` |
| C3 | kill Gateway A | **PASS** | same id, `replay: true` |
| C4 | Redis restart | **PASS** | enqueue true, winners 1 |
| C5 | Postgres restart | **PASS** | jobCount 24 after data-dir restart |
| P8 | stop all / restart | **PASS** | phantomRunning 0, enqueue true |
| P1 | /internal/readiness | **PASS** | 200 ready true, coord redis, persist postgres |

## In-process suite (complement)

`RELAY_SKIP_DB=1 node --test src/lib/chaos.test.ts` + coord/fault/lease tests: **37 pass / 0 fail** this campaign.

`scripts/multi-process-job-claim.test.mjs` + `multi-process-lease.test.mjs` + `pg-cutover.test.mjs`: **3 pass / 0 fail**.

## Acceptance bar

| Bar | Observed |
|---|---|
| no duplicate execution | 20-way and 50-way idempotency → 1 id; 3-way claim → 1 winner |
| no lost request | C1 requeue keeps `requestId`; C5/P8 jobs survive restart |
| no double lease | C7 unique == ok |
| stale result rejected | C2/C8/C10 |
| provider DOM does not drain pool | C6P secondOk true |
| redis/postgres temporary failure | C4/C5 PASS after real process restart |
