# Model truth

Web UI labels are not model versions.

| Read from page | Means | Confirms gpt-5.6? |
|---|---|---|
| GPT-5.6 | version token | yes |
| ChatGPT | product | no |
| Instant / Fast | profile | no |
| Auto | profile | no |
| ChatGPT 5.2 Instant | product + older version + profile | no |

`model_verified=true` only when the actual string contains version evidence (`5.6`). Otherwise `MODEL_SELECTION_UNCONFIRMED`.

Public aliases that opt into this honesty:

- `chatgpt-web-auto`
- `chatgpt-web-fast`

`actual_model="ChatGPT"`, `model_verified=false` is correct.

## Selector pack (Leonardo refs)

UI recon originally recorded `Add reference to generation`. A later surface also uses `Add image reference`. Both stay as candidates. Neither test is deleted.

Live model-false-confirmation campaign: **NOT_EXECUTED**.
