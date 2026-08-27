# Quick Start

You do not need the Grok workspace to run Relay.

## Development (single machine)

```
git clone git@github.com:leilei6878-spec/relay-web-api.git
cd relay-web-api
npm ci
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
# fill POSTGRES_PASSWORD, RELAY_ADMIN_TOKEN, RELAY_WORKER_TOKEN,
# RELAY_SECRETS_KEY, RELAY_PUBLIC_URL and S3_*; no required value has a default
docker compose -f docker-compose.production.yml up -d --build
curl -sf http://127.0.0.1:8088/healthz
curl -sf http://127.0.0.1:8088/readyz
```

`NODE_ENV=production` without Postgres, Redis, admin/worker secrets, encryption key, or object storage **will not become READY**.
