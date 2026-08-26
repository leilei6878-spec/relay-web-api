# Nightly Provider Baseline (Phase 0)

Audit date: 2026-08-26. Source of truth: current `main` code, not design docs.

Tags: **VERIFIED** | **PARTIAL** | **BRITTLE** | **FAKE_SUCCESS** | **NOT_WIRED** | **MISSING**

This campaign does **not** add providers. Scope is ChatGPT + Gemini only.

## ChatGPT Worker

| Item | Status | Evidence |
|---|---|---|
| Playwright `storage_state` + sticky proxy | **PARTIAL** | `run_chat` in `local-worker-script.ts`; proxy required unless mock |
| Exit IP probe | **PARTIAL** | `exit_ip()`; skipped when `TEST_URL` set |
| Per-request Chromium launch | **BRITTLE** | `open_browser` + `browser.close()` every job; no process pool |
| Account lock (concurrency=1 per account) | **VERIFIED** | `account_lock` + `SEM` |
| `concurrencyPerWorker` semaphore | **PARTIAL** | Python `SEM`; not load-tested at 20×5 / 20×10 |
| Selector miss → `SESSION_INVALID` | **BRITTLE** | composer missing is labelled session failure; no page-state split |
| Model switch | **PARTIAL** | `select_model`; center compares raw strings and can false-positive (`GPT-5.6` vs `gpt-5.6`) |
| Streaming chunks | **PARTIAL** | `post_chunk` of full assistant text, not tokenizer deltas |
| Multi-turn history | **BRITTLE** | Gateway concatenates `role: text` into one string |
| Vision attach | **PARTIAL** | `attach_images` file input; no assert that attach succeeded |
| Session write-back | **PARTIAL** | Worker returns `storage_state`; center writes **without CAS** and double-increments version |
| Live chatgpt.com soak | **NOT_WIRED** | sandbox has no production ChatGPT session |

## Gemini Worker

| Item | Status | Evidence |
|---|---|---|
| Authenticated cookie check | **PARTIAL** | any cookie name set counts as `real` |
| Composer fill + send | **BRITTLE** | first matching selector; no page state |
| Result image detection | **BRITTLE** | last 6 `<img>` tags; accepts any `googleusercontent` / `data:image` |
| Exclude avatar / favicon / UI icon / old images | **MISSING** | no baseline snapshot of pre-submit images |
| MIME / dimension gate | **MISSING** | download only; no min size |
| Fake SVG success | **PARTIAL** | `make_image` SVG only when `RELAY_ALLOW_MOCK=1`; production path returns `ok=false` without session |
| Image persist to MediaStore | **PARTIAL** | `persistImageUrl` on finish; production requires S3 |
| Image edit vs generate | **NOT_WIRED** | `/v1/images/edits` calls the same `handleImage` |
| Live gemini.google.com soak | **NOT_WIRED** | no production Gemini session |

## Selector logic

| Item | Status | Evidence |
|---|---|---|
| Pack in settings | **PARTIAL** | `GatewaySettings.chatgptSelectors` / `geminiSelectors` |
| Versioned packs (`chatgpt-v1`) | **MISSING** | no `selector_pack_version` |
| Primary + bounded fallback | **PARTIAL** | `first_visible` walks the list with no cap / no version |
| All selectors fail → `PROVIDER_DOM_CHANGED` | **BRITTLE** | ChatGPT maps to `SESSION_INVALID` |
| Record pack version on job | **MISSING** | |

## Model selection

| Item | Status | Evidence |
|---|---|---|
| Requested model sent to worker | **VERIFIED** | job.model |
| UI switch attempted | **PARTIAL** | `select_model` clicks switcher |
| `actual_model` recorded | **PARTIAL** | `modelActual` on result |
| Verify actual matches requested | **BRITTLE** | string equality on UI label |
| Unconfirmed → fail or metadata | **MISSING** | `MODEL_SELECTION_UNCONFIRMED` not a first-class code |

## Session lifecycle

| Item | Status | Evidence |
|---|---|---|
| `sessionVersion` field | **PARTIAL** | Account + job payload |
| CAS on write-back | **MISSING** | older worker can overwrite newer session |
| `last_refresh_at` / `last_validated_at` / `expires_hint` / `active_probe_at` | **MISSING** | probe returns `expiresAt` but account is not updated with full lifecycle |
| Cookie inspect | **VERIFIED** | `session-probe.ts` |
| Stale session tests | **MISSING** | |

## Proxy usage

| Item | Status | Evidence |
|---|---|---|
| Job-bound proxy required | **VERIFIED** | `job_proxy` no silent `pick_proxy` unless mock |
| Sticky bind on account | **VERIFIED** | control-plane `proxyId` |
| Exit IP recorded | **PARTIAL** | probed, not persisted on the job |

## Image extraction / media

| Item | Status | Evidence |
|---|---|---|
| Multimodal parse (`image_url`) | **VERIFIED** | `media.ts` |
| Download provider URL → bytes | **PARTIAL** | worker `context.request.get` |
| MediaStore local + object | **VERIFIED** | `media-store.ts`; production fail-closed without S3 |
| Hash / asset_id / expiry metadata | **MISSING** | |
| Stable URL (not provider cookie URL) | **PARTIAL** | persist to `/api/media/:id` on success |

## Streaming

| Item | Status | Evidence |
|---|---|---|
| SSE start / delta / finish | **PARTIAL** | `streamChat` + `job-events` |
| Usage on stream path | **VERIFIED** | `sseUsageChunk` + `logUsage` |
| Disconnect → `cancelJob` | **PARTIAL** | `attachSseLifecycle`; worker may still run until timeout |
| Backpressure | **PARTIAL** | `enqueueWithBackpressure` spin-wait |
| Dedicated cancel/timeout/usage tests | **PARTIAL** | timeout + disconnect unit tests only |

## Error mapping

| Item | Status | Evidence |
|---|---|---|
| Failure matrix | **VERIFIED** | `fault-matrix.ts`; DOM_CHANGED does not bump account health |
| Page state before SESSION_INVALID | **MISSING** | |
| CHALLENGE vs LOGIN_REQUIRED vs DOM_CHANGED | **MISSING** | |
| Provider circuit | **VERIFIED** | `circuit.ts` unique-account trip |

## Provider Health / Canary

| Item | Status | Evidence |
|---|---|---|
| Circuit HEALTHY/DEGRADED/OPEN/HALF_OPEN | **VERIFIED** | `circuit.ts` + tests |
| Canary accounts skip failCount | **PARTIAL** | `isCanaryAccount` + `recordCanaryResult` |
| Live canary probe steps | **NOT_WIRED** | `canary.ts` is control-plane only; no browser probe |
| Fingerprint-driven DEGRADED | **MISSING** | |

## API surface

| Item | Status | Evidence |
|---|---|---|
| `/v1/chat/completions` | **PARTIAL** | last-user + concatenated history; unsupported params 400 |
| `/v1/responses` | **PARTIAL** | input string/messages; **stream rejected**; no capability metadata |
| `/v1/images/generations` | **PARTIAL** | `mask` listed as allowed (silent accept) |
| `/v1/images/edits` | **NOT_WIRED** | alias of generations |
| `/v1/models` capabilities | **MISSING** | ids only |
| OpenAI SDK contract suite | **PARTIAL** | `qa-api-compat.test.mjs` (auth, unsupported param, responses exists) |

## Performance

| Item | Status | Evidence |
|---|---|---|
| Browser start P50/P95 | **MISSING** | `browser-baseline.ts` collector empty |
| Bounded browser pool | **MISSING** | deferred previously |
| Reliability run vs ChatGPT/Gemini | **NOT_WIRED** | previous reliability was job-queue, not provider DOM |

## Campaign rule

Do not treat “code exists” as “commercially complete”. Live ChatGPT/Gemini browser paths remain **NOT_WIRED** in this sandbox until a real session is present. This round must still make failure *decidable* and API behavior *standard*.
