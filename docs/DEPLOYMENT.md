# Deployment

Two supported ways. Neither requires the Grok preview.

## A. Docker Compose (recommended)

Files: `Dockerfile`, `Dockerfile.worker`, `docker-compose.production.yml`.

Services: `postgres`, `redis`, bundled `minio`, `gateway`, and `worker`.

```
cp .env.example .env
# set RELAY_ADMIN_TOKEN, RELAY_WORKER_TOKEN, RELAY_SECRETS_KEY, S3_* 
docker compose -f docker-compose.production.yml up -d --build
```

Gateway entrypoint runs `npm run db:migrate` then `vite preview` on container
port `8080`, published by default at host `127.0.0.1:8088`.
Worker entrypoint runs the Playwright Python daemon against `RELAY_GATEWAY`.

**Compose-up in the Grok workspace: NOT_EXECUTED** (no Docker daemon). Verify on the first real host before calling the install production.

## B. Bare metal

Node 22 + Python 3.12 + Playwright Chromium + Postgres 16 + Redis 7.

```
npm ci
cp .env.example .env   # fill production values
npm run build:app
npm run db:migrate
npm start              # 0.0.0.0:8080
# second process:
RELAY_HEADLESS=1 RELAY_GATEWAY=http://127.0.0.1:8080 \
  RELAY_TOKEN=$RELAY_WORKER_TOKEN python3 workers/relay-worker.py
```

Export the worker script with `node --experimental-strip-types scripts/export-worker.mjs`.

Production fail-closed list: [CONFIGURATION.md](./CONFIGURATION.md).
Do **not** set mock/demo env vars. Do **not** point `RELAY_TEST_URL=self`.
