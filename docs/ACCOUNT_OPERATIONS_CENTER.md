# Account Operations Center

Production status: **DEPLOYED**  
First production release: `aefc2b0f27c5e761ab6ee38c9b7a0580c84cdd66`  
Schema: **6**  
Secure administrator origin: `https://relay.38.175.201.137.nip.io`

## Purpose

The account pool is now an operations surface rather than a flat list. It
tracks business lifecycle, session lifecycle, proxy/IP identity, health history
and daily capacity without exposing raw cookies or browser debugging ports.

## Account fields

- Existing identity: platform, email, proxy, status, remark, created time.
- Business metadata: business expiry, batch, tags, update time and auto-check
  participation.
- Session lifecycle: saved/refresh/validation times, inferred session expiry,
  cookie count, session version, last page state and available models.
- IP lifecycle: baseline login IP, latest observed exit IP and one of
  `matched`, `drift`, `unknown`, `proxy_unavailable`.
- Health lifecycle: last static/proxy/live check, next due check, consecutive
  failures, health score, last error and account lock/inspection state.

Business expiry and session expiry are intentionally separate. Business expiry
is administrator-owned and prevents scheduling after the deadline. Session
expiry is inferred from the stored login state.

## Availability definitions

**Healthy available** means the account status and Session are healthy, the
business/session deadlines have not passed, its bound proxy is active, IP has
not drifted and provider quota is not exhausted.

**Currently schedulable** additionally requires that the account is not leased
by an API job or administrator inspection. The dashboard displays both numbers
so normal short-lived leases do not look like account loss.

## Search and bulk operations

The combined query searches email, remark, tags, batch, proxy name/region,
login/observed/expected IP and supported model. Filters cover platform, status,
business expiry, IP state, batch and proxy. Administrators can bulk update
batch, tags, expiry, status and scheduled-check participation.

## Three-layer checks

1. `static` — parses the stored Session, validates provider cookies and records
   the earliest useful expiry without opening the provider.
2. `proxy` — checks the assigned node and obtains its real HTTPS exit IP. A
   changed IP is `IP_DRIFT` and is isolated immediately.
3. `live` — opens the actual provider through the exact account-bound proxy and
   runs the existing structural canary. It does not send ChatGPT text and does
   not click Gemini/Leonardo Generate.

Explicit Session expiry, invalid Session, login-required state and IP drift
isolate immediately. Network, challenge or DOM uncertainty requires two
consecutive failures before invalidation. Check jobs do not increment normal
customer request counts.

Default cadence:

| Check | Healthy account | Within 24h of business expiry |
|---|---:|---:|
| Static Session | 15 minutes | 30 minutes |
| Proxy / exit IP | 30 minutes | 30 minutes |
| Live structural page | 2 hours | 30 minutes |

Runs are globally bounded by `RELAY_ACCOUNT_CHECK_CONCURRENCY` (default 2).
Manual runs can target selected rows, the current combined search or the full
pool. Each run and step is durable and cancellable before a step starts.

## Daily capacity

Hourly samples retain total, available, schedulable, busy, expiring, invalid
and IP-drift counts for the full pool and every platform. The UI presents
7/30/90-day current, minimum, maximum and average availability plus additions,
expiries and recoveries. Per-account daily snapshots preserve the reason an
account was unavailable.

## Secure login-state inspection

Inspection is production-disabled on plain HTTP. The administrator must use
the HTTPS origin above.

Start sequence:

1. Require the normal administrator cookie or administrator bearer.
2. Reject missing Session/proxy and reject an account already leased.
3. Mint a random 256-bit, 30-minute inspection token and store only its SHA-256
   hash.
4. Lease the exact account; inspection never falls back to another account.
5. The Worker opens the saved Session through the bound proxy and sends only
   compressed screenshots through a Worker-authenticated endpoint.
6. `view` permits scroll/reload/history only. `maintenance` also permits
   coordinate click and bounded text/key input.
7. Commands live in Redis for at most 60 seconds; typed text is never written
   to PostgreSQL or audit logs.
8. Close/expiry writes Session state with the existing version CAS, releases
   the account lease and deletes the temporary frame.

Production acceptance returned an authenticated Leonardo frame over HTTPS,
reported the real exit IP, accepted a read-only scroll, ended
`closed_by_admin`, left zero inspection frames and zero account locks, and did
not persist a command.

## Administrator endpoints

All endpoints below require the administrator session/token and are excluded
from the public OpenAPI surface.

- `GET/PATCH /api/admin/account-operations`
- `GET/POST /api/admin/account-checks`
- `GET/POST /api/admin/account-analytics`
- `GET/POST /api/admin/account-inspections`

The matching `/api/worker/account-inspections` endpoint requires the Worker
credential. Raw Session JSON remains available only to the existing protected
server-to-Worker job claim path.

## Recovery

The verified pre-deploy backup is
`/opt/backups/relay-pre-account-ops-20260829-025617` and includes PostgreSQL,
storage/Sessions, MinIO, environment, Compose, Caddy and Git metadata with
`SHA256SUMS`. Restoring the database also restores check history and capacity
samples. Frame files are intentionally ephemeral and are not required for
recovery.
