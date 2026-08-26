# Request State Machine

A client call creates **one Request**. Failover creates **Attempts**, not a new Request.

```
Request  queued → running → succeeded | failed | cancelled
           └─ Attempt 1 (job/lease/account/proxy/worker/fence)
           └─ Attempt 2  …
           └─ final_attempt_id + final_error
```

Example:

```
Request R1
  Attempt A1 → ACCOUNT_SESSION_EXPIRED
  Attempt A2 → SUCCESS
Client only sees R1 succeeded.
```

Job machine (execution unit claimed by a worker):

```
enqueue → queued
        → running (lease + fencing token issued)
        → done | error | cancelled | dead
running + worker dead / wait timeout + attempts < maxRetry → queued
running + attempts >= maxRetry → dead
wait deadline / SSE disconnect → cancelJob
```

Idempotency: `Idempotency-Key` is `SET NX` then bound to the job/request id. Replays return the existing queued/running/done job.

Account path:

```
pick A → enqueue (same request_id) → wait
  ACCOUNT_* → exclude A → pick B → new Attempt, same Request
  PROVIDER_DOM_CHANGED / PROVIDER_UNAVAILABLE → trip circuit, do not walk the pool
  PROXY_* / WORKER_* → do not increment failCount
```
