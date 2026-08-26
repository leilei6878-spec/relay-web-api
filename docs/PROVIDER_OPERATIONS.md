# Provider Operations

Selector packs: `chatgpt-v1`, `gemini-v1` (`src/lib/provider/selectors.ts`). Each job should record `provider`, `selector_version`, `page_state`.

Page states: `AUTHENTICATED`, `LOGIN_REQUIRED`, `CHALLENGE`, `RATE_LIMITED`, `ACCOUNT_RESTRICTED`, `COMPOSER_READY`, `GENERATING`, `RESULT_READY`, `DOM_UNKNOWN`, `PROVIDER_ERROR`.

A missing composer on an authenticated page is `PROVIDER_DOM_CHANGED`, **not** session death, and does **not** increment account `failCount`. Several independent accounts hitting DOM_CHANGED trips the provider circuit (OPEN). Half-open allows canary only.

Gemini never returns a fake image. Missing image / timeout / DOM change → explicit error. Bytes are downloaded, MIME/size validated, hashed, stored, then a stable URL is returned. `googleusercontent` URLs are not a commercial result.

ChatGPT must use the **account-bound** proxy from the job payload.
