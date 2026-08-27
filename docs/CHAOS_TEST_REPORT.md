# Chaos Test Report

## Web Runtime V2 live campaign (2026-08-27)

Live Chat / Image / proxy-down / post-submit-crash against **real provider accounts**: **NOT_EXECUTED**.

The 18/18 table below is the **in-process chaos harness** (shared-pg + Redis + two gateways). It is not live provider traffic, not post-submit paid-generation chaos, and not Proxy-A-down on a real SOCKS node.

| Gate | Target | Status |
|---|---|---|
| F. Generate clicked → worker crash / gateway timeout | duplicate_paid_generation=0; SUCCESS / RESULT_RECOVERED / RESULT_UNCERTAIN only | **NOT_EXECUTED** |
| G. Account A Proxy A down, Proxy B healthy | PROXY_UNAVAILABLE, proxy_drift=0 | **NOT_EXECUTED** |
| H. 3 live accounts, shard metadata | cross_request_metadata=0 from chunk to result | **NOT_EXECUTED** |

Unit coverage that exists and is **not** a substitute for live:

- F: `retrySafety=UNSAFE` folds retry/switch off; post-submit `SUBMISSION_UNCERTAIN` / `RESULT_UNCERTAIN`
- G: `job_proxy()` fail-closed; `PROXY_IDENTITY_MISMATCH`; claim uses `job.proxyId`
- H: `JobRuntimeContext` isolation; no process-global `RELAY_JOB_ID`

---

Date: 2026-08-25T17:39:52Z

Runner: `node scripts/chaos-harness.mjs`

Topology actually started:

- shared-pg (PGLite file dir `/tmp/relay-pgdata`) on `:19010`
- RESP Redis on a random TCP port
- Gateway A `:19001` (`gw-a`)
- Gateway B `:19002` (`gw-b`)

Raw JSON: `storage/chaos-harness-report.json`

**18 / 18 PASS. 0 FAIL.** (in-process harness, not live V2 gates F/G/H)

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
