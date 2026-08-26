# Worker Architecture

Official execution path is the **server daemon** (`RELAY_WORKER_NAME=server-1`), started by `startup.sh`, not by visiting `/api/runtime`.

Credential: `wk-relay-…` from `storage/worker-token.txt` or `RELAY_WORKER_TOKEN`.

Per job:

1. Poll `/api/worker/next` with capacity / active / drain headers.
2. Open Chromium with the **job-bound** proxy. No 10808 fallback unless `RELAY_ALLOW_MOCK=1`.
3. Probe exit IP. Fail `PROXY_UNAVAILABLE` if empty.
4. Select model and assert switcher text. Fail `MODEL_MISMATCH` on mismatch.
5. Stream assistant deltas to `/api/worker/chunk`.
6. Return `sessionState` + `sessionVersion` + lease proof to `/api/worker/result`.

Concurrency: in-process semaphore (`RELAY_CAPACITY`) plus per-account lock. SIGTERM sets drain and stops polling when active jobs hit 0.

PC worker zip is only for first-time login on an operator machine. Production traffic must not depend on it.
