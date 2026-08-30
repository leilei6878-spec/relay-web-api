# Deployment

Two supported ways. Neither requires the Grok preview.

## A. Docker Compose (recommended)

Files: `Dockerfile`, `Dockerfile.worker`, `docker-compose.production.yml`.

Services: `postgres`, `redis`, bundled `minio`, `gateway`, and `worker`.

```
cp .env.example .env
# set RELAY_ADMIN_TOKEN, RELAY_WORKER_TOKEN, RELAY_SECRETS_KEY, S3_*
# and RELAY_RELEASE_SHA=$(git rev-parse HEAD)
docker compose -f docker-compose.production.yml up -d --build
```

Gateway entrypoint runs `npm run db:migrate` then `vite preview` on container
port `8080`, published by default at host `127.0.0.1:8088`.
Worker entrypoint runs the Playwright Python daemon against `RELAY_GATEWAY`.
`/healthz`, `/readyz`, `/api/ready`, and `/api/runtime` expose the release
identity; production readiness is false when the exact commit is unknown.

Keep the Gateway bound to loopback or a private network and expose it only
through a controlled edge proxy. The edge must **overwrite**, not append or
preserve, exactly one client-IP header. For the recommended Caddy contract:

```caddy
reverse_proxy 127.0.0.1:8088 {
  header_up X-Real-IP {remote_host}
  header_up X-Forwarded-For {remote_host}
  header_up X-Forwarded-Proto {scheme}
  header_up X-Forwarded-Host {host}
}
```

set `RELAY_TRUST_PROXY_HEADERS=1` and
`RELAY_CLIENT_IP_HEADER=x-real-ip`. Relay then ignores client-supplied
`CF-Connecting-IP` and `X-Forwarded-For`. If Cloudflare is the trusted edge,
select `cf-connecting-ip` only after the next hop is restricted to Cloudflare
and overwrites that header. Production fails readiness when this trust boundary
is not explicit.

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
