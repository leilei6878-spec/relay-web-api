# Runbook

Worker offline 503: check `storage/server-worker.pid`, `/tmp/relay-server-worker.log`, `/api/admin/metrics`.

STALE_LEASE: old worker posted after reclaim. Safe to ignore; job was requeued.

SESSION_INVALID: account → invalid. Re-login via session upload. Do not keep sending.

PROXY_UNAVAILABLE: sticky node down or exit IP probe failed. Fix proxy, keep account.

cooling accounts: wait `coolDownSeconds`, they become probing, then healthy on success.

Rotate keys: Settings → 新建 Key (shown once) → disable the old one. Worker token is separate (`/api/admin/worker-kit`).

Drain: `POST /api/worker/control` `{ "action": "drain" }` then restart.
