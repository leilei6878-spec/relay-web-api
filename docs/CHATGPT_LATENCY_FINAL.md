# ChatGPT Latency Final

## Answers (required)

| # | Question | Answer |
|---|---|---|
| 1 | Original P50 TTFT | 39800 ms (non-stream, full body) |
| 2 | Original P95 TTFT | ~40000 ms |
| 3 | Optimized P50 TTFT | **3753 ms** (API SSE n=5) |
| 4 | Optimized P95 TTFT | **5595 ms** |
| 5 | Original P50 complete | 39800 ms |
| 6 | Optimized P50 complete | **7225 ms** API / **7037 ms** worker n=8 |
| 7 | Browser extra dropped | ~6s goto+launch+1MB session; warm page_ready P50 85ms |
| 8 | Model first-delta floor | **~2.8s** after send (T6→T8 P50 2776ms) |
| 9 | 10s TTFT reachable? | **YES** on this prompt |
| 10 | 10s full reply reachable? | **YES** on this short prompt (P95 8.6s). Longer/Sol-heavy prompts will exceed 10s — that is model time. |
| 11 | Model delay | T6→T9 P50 6245ms |
| 12 | Relay delay | T0→T6 ~1.5s warm (prepare+page+composer+input+send) |
| 13 | Warm page success | 8/8 of healthy samples |
| 14 | 30s click timeout gone? | **YES** (`box.click()` removed; 4s default) |
| 15 | Streaming first token earlier by | ~32s vs old full-wait (40s→4s TTFT) |
| 16 | Fast Pool verified? | **NO**. Instant UI not present. FAST_CAPABLE=false |
| 17 | Multi BrowserContext worth it? | Unknown. Only 1 real account. Keep 1 context/account. |
| 18 | Best production config | headed Xvfb, pool=1, warm temp-chat page, observer SSE, staged timeouts, sticky proxy, concurrency=1 |

## Latency equation (P50, this prompt, warm)

```
Total 7037ms
  = Queue ~0
  + Browser/DOM ~1500  (T0–T6)
  + Network overlap (send_to_network noisy)
  + Model reasoning/stream ~6200 (T6–T9)
  + Relay streaming overhead <100ms (not isolated)
```

Model dominates. Relay no longer waits for Stop or 30s clicks.

## Status of mandated volume

- 50–100 live runs: **PARTIAL** (5 API successes + 8 worker timings after fix)
- Human 10×: **NOT_EXECUTED**
- Fast-capable vs auto matrix: N/A (fast not verifiable)
- 1/5/10 accounts: **NOT_EXECUTED** beyond 1

Do not treat n=5 as capacity certification. The split (Relay ~1.5s vs model ~6s) is stable across the 8 healthy worker traces.

## Production recommendation

Keep the current Playwright DOM path. Stream deltas. Warm the Plus page. Report `actual_model=ChatGPT`, `profile_verified=false`. Do not promise Instant or sub-10s on arbitrary prompts.
