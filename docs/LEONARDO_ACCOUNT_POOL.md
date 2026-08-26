# Leonardo Account Pool

Platform value: `leonardo`.

Add account → bind sticky proxy → download login helper (`https://app.leonardo.ai/generate`) → **Sign In until Sign In disappears and `/generate` stays** → save `storage_state` (must include Cognito/session cookies; landing-only `anonymous-id` / `_landing_*` is rejected) → probe → HEALTHY.

The public Leonardo home page has a prompt box and Generate button **without login**. The helper must not treat that as a session.

Canva China (`canva.cn`) and Canva global (`canva.com`) accounts are not interchangeable. A mainland-China IP sends visitors to `.cn`. The Leonardo helper:

- opens `https://www.canva.com/?disable-cn-redirect=true`
- routes Canva through the bound (non-CN) node so the site stays on `.com`
- intercepts `canva.cn` navigations and rewrites them to `canva.com`
After Canva is logged in, Leonardo is opened in a **new tab** (the Canva tab is not reused). The helper clicks Canva SSO once, waits for the OAuth popup, and does **not** reload `/generate` in a loop — that previously dropped the callback and left the login page.

Each account stores (Postgres `extra` JSON / control-plane):

`availableModels`, `tokenState`, `planHint`, `generationConcurrency` (default 1), `queueDepthHint`, `lastPageState`, `sessionVersion`, proxy id.

Not stored in the browser as source of truth.

Two Leonardo accounts never share a BrowserContext. Worker must use the job's proxy, never a machine default.

Canary accounts (`canary=true`) are the only ones dispatched while the Leonardo provider circuit is OPEN / HALF_OPEN. Canary failures update provider health, not `failCount`.
