# Job Lease Design

On `claimNext` the gateway:

1. `SET NX job-claim:{jobId} {workerId} PX timeout` — only one claimant across processes.
2. `INCR job-fence:{jobId}` — fencing token.
3. Issues `leaseId`, `attemptId`, `workerId` on the job.
4. `SET lease:{jobId}` with TTL.

`finishJob` and `/api/worker/chunk` call `assertLease`. Mismatched or missing leases return `STALE_LEASE` and do not mutate the job. A second callback after the job is terminal is also `STALE_LEASE`.

Release is compare-and-delete (`EVAL` if Redis, same predicate in memory) so a stale owner cannot drop a newer lease.

Account lock: `SET NX account-lease:{id}` so one account has one active lease.

Backend is Redis when `REDIS_URL` is set. In production Redis is **required**. Otherwise in-process memory with the same API (dev/test only).

`concurrencyPerWorker` is enforced at claim time. Draining workers receive no new jobs.

Verified dual-process: `scripts/multi-process-lease.test.mjs`, `scripts/multi-process-job-claim.test.mjs`.
