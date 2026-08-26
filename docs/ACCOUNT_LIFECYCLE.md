# Account Lifecycle

```
pending_login → (session + sticky proxy) → healthy
healthy → account fault (failCount++) → cooling when failThreshold hit
cooling → lockedUntil expired → probing
probing → successful job → healthy
SESSION_INVALID → invalid
BANNED → banned
```

- Infra / proxy / worker / provider faults do not increment `failCount`.
- `pickAccount` may schedule `healthy` or `probing`.
- Session writes from the worker bump `sessionVersion` in the center store.
