# Leonardo Account Pool

Platform value: `leonardo`.

Add account → bind sticky proxy → download login helper (`https://app.leonardo.ai/generate`) → **Sign In until Sign In disappears and `/generate` stays** → save `storage_state` (must include Cognito/session cookies; landing-only `anonymous-id` / `_landing_*` is rejected) → probe → HEALTHY.

The public Leonardo home page has a prompt box and Generate button **without login**. The helper must not treat that as a session.

Canva / Google / Microsoft SSO verification is sent **direct** (home network), not through the sticky node. Canva treats datacenter/VPN IPs as `RRS` and refuses to send the email code. Leonardo (`app.leonardo.ai`) still uses the bound node. System TUN/v2rayN must be off during Canva 2FA or Canva still sees a VPN.

Each account stores (Postgres `extra` JSON / control-plane):

`availableModels`, `tokenState`, `planHint`, `generationConcurrency` (default 1), `queueDepthHint`, `lastPageState`, `sessionVersion`, proxy id.

Not stored in the browser as source of truth.

Two Leonardo accounts never share a BrowserContext. Worker must use the job's proxy, never a machine default.

Canary accounts (`canary=true`) are the only ones dispatched while the Leonardo provider circuit is OPEN / HALF_OPEN. Canary failures update provider health, not `failCount`.
