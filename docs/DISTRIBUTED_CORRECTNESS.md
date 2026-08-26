# Distributed Correctness

Evidence from **two OS processes** (Gateway A port 19001, Gateway B port 19002) sharing:

- one file-backed PGLite exposed over HTTP (`scripts/shared-pg.mjs`) — PostgreSQL SQL, unique indexes, restartable data dir
- one RESP TCP server (`scripts/fake-redis.mjs`) implementing `SET NX PX`, `INCR`, `EVAL` compare-and-del / compare-and-renew

These are not in-process maps with a Redis-shaped API. Children opened TCP connections and issued the real commands.

## Job claim

Two workers (`wa` on A, `wb` on B) claimed the same queued job.

Observed: **one winner**. SQL `UPDATE … WHERE status='queued'` + Redis `SET job-claim:{id} NX`.

Harness: `P4.two-workers-one-claim` **PASS** (2026-08-25T17:39:43Z).

## Account lease

Concurrent enqueues across A and B.

Observed: leased 6, unique 6 — no double lease.

`SET account-lease:{id} NX` **and** `UPDATE relay_accounts SET locked_until=… WHERE locked_until IS NULL`.

Harness: `P4.no-double-account-lease` **PASS**, `C7.account-contention` **PASS** (6 unique / 6 ok / 14 fail).

## Fencing

Fencing token is `COALESCE(fencing_token,0)+1` in PostgreSQL on claim. Finish requires `status='running' AND lease_id AND fencing_token` match.

Stale worker finish after a new claim: `STALE_LEASE: lease_id mismatch`. Text stayed `fresh-text`.

Harness: `C2.stale-worker-rejected` **PASS**, `C10.timeout-old-result` **PASS**.

## Idempotency

`Idempotency-Key` 20 concurrent requests to A and B: **1 job id**, `execs: 1`.

50 concurrent: **1 job id**.

Postgres unique index on `relay_jobs.idempotency_key` + Redis `SET NX idem:{key} __pending__`.

Harness: `C6.idempotency-20` **PASS**, `C6.idempotency-50` **PASS**.

## Lease renew / release

- Release: `EVAL` compare-and-delete (Lua `GET` then `DEL` if owner).
- Renew: `EVAL` compare-and-PEXPIRE (Lua `GET` then `PEXPIRE` if owner). **Not** GET → compare in JS → write.

Unit: `coord-renew.test.ts` against RESP server **PASS**. Memory path `coord.test.ts` **PASS**.

## Request visibility

Gateway A created job `d606b006-…`. Gateway B `GET /v1/job/{id}` returned the same id.

Harness: `P4.gateway-b-sees-request` **PASS**.

## Honest limits

- SQL transport in this sandbox is HTTP to one PGLite, not `pg` against Neon. The SoT operations are the same SQL (`UPDATE … WHERE status='queued'`, unique idempotency index).
- Redis is a RESP server implementing the commands Relay uses, not AWS ElastiCache.
- Preview `NODE_ENV` is not production; production still requires `DATABASE_URL` + `REDIS_URL` and will not load PGLite or memory locks.
