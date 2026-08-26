# Leonardo Test Report

Date: 2026-08-26. Tags: **PASS** | **FAIL** | **BLOCKED_NO_SESSION** | **NOT_RUN**.

Live image generation requires a logged-in Leonardo `storage_state`. This environment has none. Worker and Gateway therefore fail closed with `LEONARDO_LOGIN_REQUIRED` / empty pool — they do **not** return fake images.

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | GPT Image 2 text-to-image | **BLOCKED_NO_SESSION** | No Leonardo session; worker returns LOGIN_REQUIRED / PROXY |
| 2 | GPT Image 2 + 1 reference | **BLOCKED_NO_SESSION** | same |
| 3 | Leonardo Gemini text-to-image | **BLOCKED_NO_SESSION** | same |
| 4 | Leonardo Gemini + reference | **BLOCKED_NO_SESSION** | same |
| 5 | Account A session invalid → B failover | **PASS** (unit) | `LEONARDO_LOGIN_REQUIRED` `switch_account=true`; scheduler picks next eligible |
| 6 | Token exhausted not dispatched | **PASS** | `eligibilityReason` → 额度用尽; `leonardo.test.ts` |
| 7 | Two concurrent jobs do not share one account | **PASS** (existing) | account lease SET NX + worker account lock; concurrency.test.ts |
| 8 | DOM selector fault does not pollute pool | **PASS** | `LEONARDO_DOM_CHANGED` circuit trip, `account_health_effect=none` |
| 9 | Historical images rejected | **PASS** | `accept_result_image` baseline + favicon; extractResult |
| 10 | Worker crash recovery | **PASS** (existing infra) | WORKER_CRASH retry_same_account; not Leonardo-specific soak |
| 11 | MediaStore URL after persist | **PASS** (code) | finishJob persistImageUrl for platform leonardo; live download **BLOCKED_NO_SESSION** |
| 12 | Restart restores account/session metadata | **PASS** (existing) | Postgres extra JSON / control-plane; fields availableModels/tokenState in extra |

Automated:

- `src/lib/provider/leonardo.test.ts`
- `src/lib/fault-matrix.test.ts` Leonardo codes
- `src/lib/worker-script.test.ts` `run_leonardo` without session
- `src/lib/provider/adapter.test.ts` includes leonardo

Soak: **NOT_RUN**. A Leonardo-only soak is defined conceptually (GPT Image 2 + Gemini, text + reference, failover, canary) but was not executed.

Recon: `docs/LEONARDO_UI_RECON.md` generated 2026-08-26 against public home / login. Logged-in `/generate` **not** captured.
