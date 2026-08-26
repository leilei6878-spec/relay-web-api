# Troubleshooting

**`/readyz` 503 in production**  
Read `blockers`. Missing `DATABASE_URL` / `REDIS_URL` / tokens / S3 / encryption key / mock env. Fix env; do not “just set NODE_ENV=development”.

**Chat 503 worker offline**  
Worker process dead or wrong `RELAY_WORKER_TOKEN`. Check worker logs. Admin kit: `/api/admin/worker-kit`.

**Image 422 / fail-closed**  
This is correct when Gemini did not produce a real image. Check page_state, proxy, session. There is no preview JPEG fallback in production.

**STALE_LEASE on result**  
Worker was reclaimed. The request was requeued. Ignore the late callback.

**Accounts flipping invalid after DOM change**  
Should not happen. If `failCount` rises on `PROVIDER_DOM_CHANGED`, file a bug; circuit should open instead.

**Proxy test fails in UI but v2rayN works**  
Gateway tests the node from *its* host. Server-side compose must reach the same proxy IP. Sticky binding is per account.

**Login IP ≠ worker IP**  
Use the in-app login helper / worker kit so Playwright starts with the bound proxy. Do not log in from a home IP and then run jobs through another egress.
