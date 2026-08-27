# ChatGPT completion detection

Date: 2026-08-27.

## Root cause of the truncated “我是”

The screenshot (`GPT-5.6 Instant（快）` / `你好，你是什么模型？用三句话说明。` → HTTP 200, body `我是`, ~16.8s) matches a **premature completion**, not a timeout.

Old `run_chat` loop:

```
idle = now - last_change
if text and not generating and idle >= 0.35: break
if text and idle >= 1.2: break
```

`generating` was only `Stop` button visibility. On current ChatGPT the Stop control is often missing, delayed, or selector-shifted. First assistant mutation (`我是`) + 350ms quiet + no Stop ⇒ worker declared **completed** while the model was still generating.

Yes: this was the 0.35s early-break. Streaming deltas themselves were correct; **completion** was wrong.

## Protocol

`AssistantCompletionDetector` states:

| State | Meaning |
|---|---|
| WAITING_FIRST_DELTA | submitted, no assistant text yet |
| STREAMING | mutation / delta observed. Partial SSE is allowed. **Not complete.** |
| POSSIBLY_COMPLETE | last mutation stable for the configured window |
| CONFIRMED_COMPLETE | second confirm window, DOM re-read matches |
| RESULT_UNCERTAIN | deadline hit without confirmation (partial text kept, job fails) |

Partial SSE ≠ completed. `submissionState = RESULT_VALIDATED` only after `CONFIRMED_COMPLETE`.

## Signals (priority)

1. **Stop cycle (high):** `stop_seen` then Stop gone + text stable `RELAY_CHAT_STOP_STABLE_MS` (default 400) + confirm `RELAY_CHAT_CONFIRM_MS` (default 600).
2. **Network finished (high, browser-only):** conversation `/backend-api/` request finished + stable text. Never replay ChatGPT private APIs outside the page.
3. **Semantic complete (supporting):** copy / good-response controls on **this** assistant node, plus stable text.
4. **Fallback stable (required when Stop never appears):** after first delta, last mutation stable `RELAY_CHAT_STABLE_MS` (default 1500) then confirm 400–800ms. **Never 350ms.**

Content length is **not** a completion condition. `length < 8` is a `very_short_completion` warning only (`OK` / `是` / `42` must still be allowed).

Final text is always re-read from the latest assistant node. If DOM ≠ stream accumulator, DOM wins (`relay.finalText` replace).

## Config

| Env | Default | Role |
|---|---|---|
| `RELAY_CHAT_STABLE_MS` | 1500 | fallback idle after last mutation (no Stop) |
| `RELAY_CHAT_CONFIRM_MS` | 600 | confirm window after POSSIBLY_COMPLETE |
| `RELAY_CHAT_STOP_STABLE_MS` | 400 | idle after Stop disappeared |

Vision jobs use `max(stable, 2000)`.

Target extra overhead on confirmation: **P50 ≤ 1.5–2s**. TTFT is unchanged (deltas still stream immediately).

## Observability

Printed as `CHAT_COMPLETION {…}` and folded into job `timing`:

`chat_stop_seen`, `chat_completion_signal` (`stop_cycle` / `network_finished` / `semantic` / `fallback_stable`), `chat_stable_ms`, `chat_final_dom_length`, `chat_streamed_length`, `chat_final_text_replaced`, `chat_premature_guard_triggered`, `completion_without_stop_seen`, `very_short_completion`.

SSE: `sse_transport_status`, `sse_logical_status`, `sse_partial_before_error`.

## Live 30× prompt

Fixed prompt `你好，你是什么模型？用三句话说明。` against real ChatGPT Web: **NOT_EXECUTED** in this workspace (needs a healthy session on the VPS). Unit tests cover the 350ms pause, no-Stop five-chunk, and Stop-cycle paths.
