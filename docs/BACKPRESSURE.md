# Queue backpressure

Admission counts queued + running jobs before account execution.

| Scope | Environment | Default |
|---|---|---:|
| Global | `RELAY_QUEUE_CAP` | 200 |
| Provider | `RELAY_PROVIDER_QUEUE_CAP` | 100 |
| Chat capability | `RELAY_CHAT_QUEUE_CAP` | 100 |
| Image capability | `RELAY_IMAGE_QUEUE_CAP` | 50 |
| Customer API key | `RELAY_KEY_QUEUE_CAP` | 20 |

File mode applies the same checks under its process lock. PostgreSQL mode wraps
count + insert in a Redis distributed admission lock, preventing concurrent
Gateway replicas from exceeding the cap.

Rejection is `429 QUEUE_FULL` with scope/depth/cap and `Retry-After: 5` on
non-streaming HTTP responses. A streaming envelope reports the same logical
error and `retry_after=5` in its terminal SSE event.

Structural canaries bypass customer caps so an OPEN circuit can still recover.
Paid image canaries are ordinary image work and respect image capacity.
