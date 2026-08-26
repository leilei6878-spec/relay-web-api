# Architecture

```
Client  --Bearer sk-relay-*-->  Gateway (/v1/*)
Admin   --cookie/ad-relay-*-->  Gateway (/api/admin/*)
Worker  --wk-relay-*--------->  Gateway (/api/worker/*)
Gateway --SQL-------------->  PostgreSQL (SoT)
Gateway --SET NX/EVAL------>  Redis (claim, lease, fencing, idempotency, limiter)
Worker  --Playwright------->  ChatGPT / Gemini (account-bound proxy)
Worker  --image bytes------>  Gateway --> MediaStore (S3/R2/MinIO)
```

- **Request** is the customer-visible unit. **Attempt** is each try (account/proxy/worker/lease).
- Production never schedules from JSON. JSON is import/export/dev fixture.
- Provider DOM failures trip a **provider circuit**, not the whole account pool.
- Canary accounts are the only ones dispatched while a circuit is OPEN/HALF_OPEN.
