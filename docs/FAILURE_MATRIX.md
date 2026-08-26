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
