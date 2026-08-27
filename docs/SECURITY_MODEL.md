# Security Model

Three principals, never interchangeable.

| Principal | Prefix | Used for |
|---|---|---|
| Admin | `ad-relay-` | Control plane, sessions, keys, worker kit, metrics, invoke |
| Customer | `sk-relay-` | `/v1/*` only |
| Worker | `wk-relay-` | `/api/worker/next`, `result`, `chunk` |

- Browser never receives a production customer key. Admin UI sees hints. Newly created keys are shown once.
- `/api/runtime` is public health: online workers and queue depth. No tokens.
- Admin session: HttpOnly cookie `relay_admin`. Automatic login is a development-only convenience and is always disabled in production. Set `RELAY_REQUIRE_ADMIN_LOGIN=1` to disable it in development too.
- Proxy passwords live in `storage/secrets.json` (mode 0600), not in `control-plane.json`.
- Worker claim returns cookies + the bound proxy password for that job only. Origins/localStorage stripped.
- Server functions that mutate plane/session require `assertAdminFromFn`.
