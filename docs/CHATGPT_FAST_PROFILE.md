# ChatGPT Fast Profile

## Detection (this Plus account)

Live DOM dump of `chatgpt.com/?temporary-chat=true` after login:

- No `data-testid=model-switcher-dropdown-button`
- No visible Instant / Thinking control in main or composer
- `?model=gpt-5` / `gpt-5-instant` / `auto` query params are stripped
- Header model label is only “ChatGPT”
- Previous unstreamed answers self-identified as **GPT-5.6 Sol**

| Field | Value |
|---|---|
| requested_model | gpt-5.6 (alias: latest) |
| requested_profile | auto |
| actual_model | ChatGPT (UI) / GPT-5.6 Sol when the model says so |
| actual_profile | unknown (Sol mentioned in some answers → reasoning, **unverified switch**) |
| profile_verified | false |
| FAST_CAPABLE | false |

## Fast Pool

`chatgpt-web-fast` is **not enabled**. Instant cannot be verified through normal UI.

`chatgpt-web-auto` uses the account’s webpage default. Do not advertise Instant.

Response metadata (SSE `relay` on done):

```json
{
  "requested_profile": "auto",
  "actual_model": "ChatGPT",
  "actual_profile": "unknown",
  "profile_verified": false
}
```

Cookie/localStorage hacks and private API replay were **not** used.
