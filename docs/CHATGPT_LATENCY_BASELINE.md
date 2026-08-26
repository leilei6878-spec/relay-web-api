# ChatGPT Web Latency Baseline

Prompt (fixed): `你好，你是什么模型？用三句话说明。`

Account: Plus, headed Chromium + Xvfb, warm page, account-bound SOCKS.

## Original (pre-stream, waiter bug)

Measured from live API tests in this workspace (n small, not 50):

| Metric | Value | Evidence |
|---|---|---|
| Original P50 TTFT | 39800 ms | API test UI, full-body wait, GPT-5.6 Sol |
| Original P95 TTFT | ~40000 ms | same (TTFT = TTLB, no SSE) |
| Original P50 complete | 39800 ms | API test HTTP 200 39.80s |
| Click timeout failures | 30100 ms | `Locator.click` default 30s |

Human ChatGPT UI 10× side-by-side: **NOT_EXECUTED** (no separate human browser). Playwright headed session **is** chatgpt.com; T6→T8 is the web model first paint.

## After this round (warm page + MutationObserver SSE)

API SSE bench `scripts/chatgpt-latency-bench.py` (n=5 success / 5):

| | P50 | P90 | P95 | MAX | MIN |
|---|---|---|---|---|---|
| TTFT | 3753 | 5595 | 5595 | 5595 | 3677 |
| TTLB | 7225 | 8624 | 8624 | 8624 | 7207 |

Worker T0–T10 marks after idle-on-delta fix (n=8, total<30s):

| Stage | P50 ms | P95 ms |
|---|---|---|
| browser_prepare | 9 | 220 |
| page_ready | 85 | 225 |
| composer_ready | 183 | 411 |
| input | 235 | 669 |
| send | 316 | 641 |
| submit_to_first_delta | 2776 | 3095 |
| first_delta_to_complete | 3359 | 4583 |
| generation (T6→T9) | 6245 | 7359 |
| **total** | **7037** | **8045** |

Warm page success: **8/8** of the <30s samples (`warm_page=true`).

## Floor

- Model first DOM delta after send: **P50 2.8s / P95 3.1s**
- Model remaining tokens: **P50 3.4s**
- Relay before send (T0–T6): **~1.5s** on warm page
- 10s TTFT: **reachable** on this prompt
- 10s complete: **reachable** on this prompt (P95 8.6s API, 8.0s worker)
- 50–100 run campaign: **PARTIAL** (5 API + 8 worker timings). Not 50.

## Failures observed

- `SEND_NOT_ACKED` after new-chat JS click (page recovery path)
- `TIMEOUT: empty assistant` once during a 180s job
- Two 181s jobs before idle-on-delta fix (mis-count as model time — they were waiter bugs)
