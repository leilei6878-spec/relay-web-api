# Leonardo Test Report

Date: 2026-08-26. Tags: **PASS** | **FAIL** | **BLOCKED_NO_SESSION** | **NOT_RUN**.

Live image generation requires a logged-in Leonardo `storage_state`. The pool currently has `AssanteFerraiolo98@hotmail.com` with **guest landing cookies only** (`anonymous-id`, `_landing_host`, `_landing_time`, `__cf_bm`). Status `pending_login`. Worker and Gateway fail closed — they do **not** return fake images.

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | GPT Image 2 text-to-image | **BLOCKED_NO_SESSION** | `POST /v1/images/generations` model `leonardo-gpt-image-2` → HTTP 504 ~6ms, `AssanteFerraiolo98@hotmail.com（状态不是健康）`, no URL / SVG / b64 |
| 2 | GPT Image 2 + 1 reference | **BLOCKED_NO_SESSION** | scheduler will not dispatch; same pool |
| 3 | Leonardo Gemini text-to-image | **BLOCKED_NO_SESSION** | `leonardo-gemini` HTTP 504 ~8ms, same message, no fake image. Earlier live worker hit `LEONARDO_LOGIN_REQUIRED` (job `dad5fb9c-…`) when status was still healthy |
| 4 | Leonardo Gemini + reference | **BLOCKED_NO_SESSION** | same |
| 5 | Account A session invalid → B failover | **PASS** (unit) | `LEONARDO_LOGIN_REQUIRED` `switch_account=true`; scheduler picks next eligible |
| 6 | Token exhausted not dispatched | **PASS** | `eligibilityReason` → 额度用尽; `leonardo.test.ts` |
| 7 | Two concurrent jobs do not share one account | **PASS** (existing) | account lease SET NX + worker account lock; concurrency.test.ts |
| 8 | DOM selector fault does not pollute pool | **PASS** | `LEONARDO_DOM_CHANGED` circuit trip, `account_health_effect=none` |
| 9 | Historical images rejected | **PASS** | `accept_result_image` baseline + favicon; extractResult |
| 10 | Worker crash recovery | **PASS** (existing infra) | WORKER_CRASH retry_same_account; not Leonardo-specific soak |
| 11 | MediaStore URL after persist | **PASS** (code) | finishJob persistImageUrl for platform leonardo; live download **BLOCKED_NO_SESSION** |
| 12 | Restart restores account/session metadata | **PASS** (existing) | Postgres extra JSON / control-plane; fields availableModels/tokenState in extra |
| 13 | Guest landing cookies rejected on upload | **PASS** | `parseStorageState` / `inspectSession`; helper no longer auto-saves public home composer |

Automated:

- `src/lib/provider/leonardo.test.ts` (15 tests including helper / guest cookie)
- `src/lib/fault-matrix.test.ts` Leonardo codes
- `src/lib/worker-script.test.ts` `run_leonardo` without session
- `src/lib/provider/adapter.test.ts` includes leonardo

Soak: **NOT_RUN**. A Leonardo-only soak is defined conceptually (GPT Image 2 + Gemini, text + reference, failover, canary) but was not executed.

Recon: `docs/LEONARDO_UI_RECON.md` generated 2026-08-26 against public home / login. Logged-in `/generate` **not** captured.

**Leonardo is not live.** Do not treat this as 已接入 until a Cognito/session `state.json` exists and a real image is returned.
