# Quick Start

You do not need the Grok workspace to run Relay.

## Development (single machine)

```
git clone git@github.com:leilei6878-spec/relay-web-api.git
cd relay-web-api
npm ci
cp .env.example .env          # leave NODE_ENV unset for preview
npm run dev                   # http://0.0.0.0:8080
```

Open the admin UI. Import a proxy (`ss://` or HTTP/SOCKS). Add an account. Use **本机登录助手** so the session is created on the same egress IP as the worker. Create a customer API key in Settings.

```
curl http://127.0.0.1:8080/v1/models \
  -H "Authorization: Bearer sk-relay-…"
```

## Production (Docker)

```
cp .env.example .env
# fill DATABASE_URL-equivalent via compose, RELAY_ADMIN_TOKEN, RELAY_WORKER_TOKEN,
# RELAY_SECRETS_KEY, S3_* (or enable the minio profile)
docker compose -f docker-compose.production.yml up -d --build
curl -sf http://127.0.0.1:8080/healthz
curl -sf http://127.0.0.1:8080/readyz
```

`NODE_ENV=production` without Postgres, Redis, admin/worker secrets, encryption key, or object storage **will not become READY**.
