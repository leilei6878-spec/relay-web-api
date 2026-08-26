# Monitoring

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | Process alive. Always 200 if the HTTP server started. |
| `GET /readyz` | Postgres, Redis, secrets, media, worker token, migrations, provider config. 503 if production required item fails. |
| `GET /metrics` | Prometheus text. Optional `RELAY_METRICS_TOKEN`. |
| `GET /api/admin/metrics` | JSON SLO + queue + accounts + circuit (admin). |
| `GET /internal/readiness` | Live pings (admin). |

Series: `relay_requests_total`, `relay_requests_success`, `relay_request_latency_ms`, `relay_queue_depth`, `relay_active_jobs`, `relay_active_leases`, `relay_healthy_accounts`, `relay_cooling_accounts`, `relay_invalid_accounts`, `relay_worker_online`, `relay_provider_health_*`, `relay_failovers`, `relay_retries`, `relay_stale_results_rejected`.

Alert map: [ALERTING.md](./ALERTING.md).
