# Leonardo Account Pool

Platform value: `leonardo`.

Add account → bind sticky proxy → download login helper (`https://app.leonardo.ai/generate`) → **Sign In until Sign In disappears and `/generate` stays** → save `storage_state` (must include Cognito/session cookies; landing-only `anonymous-id` / `_landing_*` is rejected) → probe → HEALTHY.

The public Leonardo home page has a prompt box and Generate button **without login**. The helper must not treat that as a session.

Canva China (`canva.cn`) and Canva global (`canva.com`) accounts are not interchangeable. A mainland-China IP sends visitors to `.cn`. The Leonardo helper:

- opens `https://www.canva.com/?disable-cn-redirect=true`
- routes Canva through the bound (non-CN) node so the site stays on `.com`
- intercepts `canva.cn` navigations and rewrites them to `canva.com`
The helper launches the user's real Chrome (same profile they already use with a proxy) over CDP, because Canva RRS blocks Playwright's isolated window even when the same proxy works in a normal browser. Chrome must be fully quit first so the profile is not locked.

Each account stores (Postgres `extra` JSON / control-plane):

`availableModels`, `tokenState`, `planHint`, `generationConcurrency` (default 1), `queueDepthHint`, `lastPageState`, `sessionVersion`, proxy id.

Not stored in the browser as source of truth.

Two Leonardo accounts never share a BrowserContext. Worker must use the job's proxy, never a machine default.

Canary accounts (`canary=true`) are the only ones dispatched while the Leonardo provider circuit is OPEN / HALF_OPEN. Canary failures update provider health, not `failCount`.
