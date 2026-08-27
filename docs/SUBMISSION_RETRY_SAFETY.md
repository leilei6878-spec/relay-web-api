# Submission + retry safety

Chat and image jobs now carry:

```
submission_state
retry_safety = SAFE | UNKNOWN | UNSAFE
```

States: `PREPARING` → `COMPOSER_READY` → `INPUT_READY` → `SUBMITTING` →
`SUBMITTED` → `GENERATING` → `RESULT_DETECTED` → `RESULT_VALIDATED` →
`COMPLETED`. Abnormal: `SUBMISSION_UNCERTAIN`, `RESULT_UNCERTAIN`.

## Retry

| When | retry_safety | Account switch | Regenerate |
|---|---|---|---|
| Before submit (proxy/session/composer) | SAFE | policy | allowed |
| Click happened, ACK missing | UNKNOWN | no | no |
| Generate acknowledged / post-submit timeout | UNSAFE | no | no |

`SEND_NOT_ACKED` after a click maps to `SUBMISSION_UNCERTAIN`.
The worker waits on the same page instead of sending again.
`LEONARDO_GENERATION_FAILED` no longer `switch_account`.

Live duplicate-generation matrix: **NOT_EXECUTED**.
