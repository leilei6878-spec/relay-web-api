# Leonardo Account Pool

Platform value: `leonardo`.

Add account → bind sticky proxy → download login helper (`https://app.leonardo.ai/`) → save `storage_state` → probe → HEALTHY.

Each account stores (Postgres `extra` JSON / control-plane):

`availableModels`, `tokenState`, `planHint`, `generationConcurrency` (default 1), `queueDepthHint`, `lastPageState`, `sessionVersion`, proxy id.

Not stored in the browser as source of truth.

Two Leonardo accounts never share a BrowserContext. Worker must use the job's proxy, never a machine default.

Canary accounts (`canary=true`) are the only ones dispatched while the Leonardo provider circuit is OPEN / HALF_OPEN. Canary failures update provider health, not `failCount`.
