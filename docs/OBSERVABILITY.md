# Observability

Every `/v1` call logs: `request_id`, `trace_id`, `job_id`, `attempt_id`, `worker_id`, `account_id`, `proxy_id`, tokens, latency.

`GET /api/admin/metrics` (admin):

- success rate, P50/P95/P99 over the last hour
- queue depth, dead-letter count
- worker online / capacity / activeJobs / browsers / drain
- account health counts
- backend: `db` (`pglite` \| `neon`), `coord` (`memory` \| `redis`)

Usage rows dual-write to `storage/usage.json` and `relay_usage`.
