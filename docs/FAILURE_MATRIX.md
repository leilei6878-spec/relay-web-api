# Failure Matrix

Source of truth: `src/lib/fault-matrix.ts`. Wired into `finishJob` and chat/image failover (`decide()` / `switch_account`).

Failures are **not** uniformly “switch account”.

| code | fault_domain | retry_same_account | switch_account | switch_proxy | provider_circuit_effect | account_health_effect |
|---|---|---|---|---|---|---|
| ACCOUNT_SESSION_EXPIRED | account | no | **yes** | no | none | invalid |
| ACCOUNT_BANNED | account | no | **yes** | no | none | banned |
| ACCOUNT_RATE_LIMIT | account | no | **yes** | no | none | cool |
| PROXY_UNAVAILABLE | proxy | no | no | yes | none | **none** |
| PROXY_TIMEOUT | proxy | no | no | yes | none | **none** |
| WORKER_CRASH | worker | yes | no | no | none | **none** |
| WORKER_TIMEOUT | worker | yes | no | no | none | **none** |
| PROVIDER_DOM_CHANGED | provider | no | **no** | no | **trip** | **none** |
| PROVIDER_UNAVAILABLE | provider | no | **no** | no | **trip** | **none** |
| GENERATION_TIMEOUT | infra | yes | no | no | none | none |
| IMAGE_NOT_FOUND | provider | no | no | no | none | none |
| REQUEST_CANCELLED | client | no | no | no | none | none |
| INTERNAL_ERROR | infra | yes | no | no | none | none |
| STALE_LEASE | worker | no | no | no | none | none |
| MODEL_MISMATCH | provider | no | no | no | none | none |

## PROVIDER_DOM_CHANGED

Must not:

- increment a single account `failCount`
- walk the account pool retrying the same client Request

Must:

- record a unique-account fault on the **provider circuit**
- leave the Request failed (or waiting for half-open canary), not “try the next cookie”

Verified: `src/lib/fault-matrix.test.ts`, `src/lib/chaos.test.ts` “chaos 10”.


## Leonardo codes

| code | fault_domain | switch_account | circuit | account_health |
|---|---|---|---|---|
| LEONARDO_LOGIN_REQUIRED | account | yes | none | invalid |
| LEONARDO_SESSION_EXPIRED | account | yes | none | invalid |
| LEONARDO_CHALLENGE | provider | no | none | none |
| LEONARDO_TOKEN_EXHAUSTED | account | yes | none | cool |
| LEONARDO_QUEUE_FULL | account | yes | none | cool |
| LEONARDO_RATE_LIMITED | account | yes | none | cool |
| LEONARDO_ACCOUNT_RESTRICTED | account | yes | none | banned |
| LEONARDO_MODEL_UNAVAILABLE | account | yes | none | cool |
| LEONARDO_DOM_CHANGED | provider | **no** | **trip** | **none** |
| LEONARDO_GENERATION_FAILED | account | yes | none | failCount |
| LEONARDO_GENERATION_TIMEOUT | infra | no (retry same) | none | none |
| LEONARDO_RESULT_NOT_FOUND | provider | no | none | none |
| LEONARDO_DOWNLOAD_FAILED | infra | no (retry same) | none | none |
| LEONARDO_PROXY_UNAVAILABLE | proxy | no | none | none |
