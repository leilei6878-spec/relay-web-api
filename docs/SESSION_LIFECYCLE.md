# Session Lifecycle

Fields on account:

- `sessionVersion`
- `lastRefreshAt`
- `lastValidatedAt`
- `expiresHint`
- `activeProbeAt`

Write-back CAS:

1. Worker is given `sessionVersion = N`
2. Worker returns `sessionBaseVersion = N`, `sessionVersion = N+1`, `sessionState`
3. Center writes only if `stored === N`
4. Older worker with `base < stored` is `STALE_SESSION_UPDATE` and does **not** overwrite

Tests: `session_refresh_race` / `stale_session_update` / `session_expiration` in `src/lib/provider/adapter.test.ts`.
