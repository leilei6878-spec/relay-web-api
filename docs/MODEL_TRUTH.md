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

The default public model is `chatgpt-web-auto`. It opts into the webpage's
default without claiming an exact model. `chatgpt-web-fast` is recognized for
compatibility but is not advertised until a live selector verifies the profile.

For a product-only label, the correct result metadata is
`actual_model="unknown"`, `actual_model_label="ChatGPT"`, and
`model_verified=false`. Exact IDs (`gpt-5.6`, `gpt-5`, `gpt-4o`) fail before
submission if the UI cannot select them and fail at result validation if the UI
does not confirm them.

## Selector pack (Leonardo refs)

UI recon originally recorded `Add reference to generation`. A later surface also uses `Add image reference`. Both stay as candidates. Neither test is deleted.

Live model-false-confirmation campaign: **NOT_EXECUTED**.
