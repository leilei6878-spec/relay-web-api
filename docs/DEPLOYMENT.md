# Deployment

Production (`NODE_ENV=production`) is fail-closed. Missing any of the following keeps the process from READY (`GET /api/ready` → 503):

- `DATABASE_URL` — Neon/Postgres. **No PGLite fallback in production.**
- `REDIS_URL` — `redis://host:6379`. **No in-process memory lock in production.**
- `RELAY_ADMIN_TOKEN` — `ad-relay-…` (file mint forbidden in production)
- `RELAY_WORKER_TOKEN` — `wk-relay-…`
- `RELAY_S3_BUCKET` + `RELAY_S3_ACCESS_KEY` + `RELAY_S3_SECRET_KEY` (or AWS_* equivalents)
- optional `RELAY_S3_ENDPOINT` / `RELAY_S3_REGION` / `RELAY_S3_PUBLIC_BASE` for MinIO/R2/OSS
- `RELAY_REQUIRE_ADMIN_LOGIN=1` on public hosts (disables loopback auto cookie)
- `RELAY_PUBLIC_URL` — absolute origin for persisted image URLs

Do **not** set `RELAY_TEST_URL`, `RELAY_ALLOW_MOCK`, or `RELAY_DEMO_MODE=true` in production.

Development / this preview may omit the above and will report `degraded` on `/api/ready`.

Start: `sh /workspace/startup.sh` starts the HTTP app and `server-1` worker daemon.
