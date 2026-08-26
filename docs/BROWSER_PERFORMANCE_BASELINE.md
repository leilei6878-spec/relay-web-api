# Browser Performance Baseline

Measured 2026-08-26 in this sandbox: Playwright Chromium headless, **local HTML fixture** (not chatgpt.com). N=8.

| Metric | P50 | P95 |
|---|---|---|
| browser_start_ms | 66 | 85 |
| context_start_ms | ~6 | ~11 |
| page_load_ms (blank) | ~43 | ~82 |
| time_to_composer_ms | ~145 | ~213 |
| crash_rate | 0 | 0 |

Raw: `storage/browser-baseline.json`.

## Is launch the bottleneck?

**Not for live providers.** Against a blank page, `browser_start` is ~10× `context_start`. Against chatgpt.com / Gemini the navigation + generation (seconds) dominates a 66ms launch.

Per campaign rule, a bounded Browser Process Pool is **implemented but opt-in** (`RELAY_BROWSER_POOL=1`). Default remains one browser per job until a live-provider baseline shows launch as the dominant cost.

Pool invariants if enabled:

- Account-scoped BrowserContext (never share a context across accounts)
- `RELAY_MAX_BROWSERS` (default 4)
- `RELAY_MAX_CTX_PER_BROWSER` (default 8)
- idle timeout + max requests recycle
