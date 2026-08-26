# Alerting

Scrape `/metrics` (optionally `Authorization: Bearer $RELAY_METRICS_TOKEN`) or poll `/api/admin/metrics`.

| Alert | Condition | Why |
|---|---|---|
| Provider OPEN | `relay_provider_health_chatgpt == 0` or gemini | DOM/provider outage; canary only |
| Success rate low | `relay_requests_success / relay_requests_total < 0.9` for 10m | Customer impact |
| Queue depth sustained | `relay_queue_depth > 20` for 10m | Workers starved or provider slow |
| Zero healthy accounts | `relay_healthy_accounts == 0` | Hard outage |
| Worker offline | `relay_worker_online == 0` | No executor |
| Redis unavailable | `/readyz` redis not ok | Leases/idempotency down |
| PostgreSQL unavailable | `/readyz` database not ok | SoT down |
| MediaStore unavailable | `/readyz` media_store not ok | Image persist down |
| High P95 | `relay_request_latency_ms{quantile="0.95"} > 60000` | SLO |
| Browser crash spike | `relay_browser_crash` delta | Worker instability |
| Account invalid spike | `relay_invalid_accounts` jump | Session wave |
| Stale result spike | `relay_stale_results_rejected` jump | Clock/lease bug or worker split-brain |

Page on: Postgres, Redis, zero healthy accounts, worker online = 0, provider OPEN > 15m.
Ticket on: P95, queue depth, invalid spike.
