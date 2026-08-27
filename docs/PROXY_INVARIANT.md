# Proxy invariant

Account A → Proxy A → Session A.

A production job that already has `proxy_id` / `proxy.server` may only use that proxy.

```
Account A
Proxy A unavailable
→ PROXY_UNAVAILABLE
→ job fails
→ scheduler decides (never bind Account A to Proxy B)
```

Local SOCKS fallback (`pick_proxy` on 18080/10808/10809) is allowed only when:

```
NODE_ENV != production
AND RELAY_ALLOW_PROXY_FALLBACK=1
```

Production default: **off**.

If the BrowserContext egress does not match the assigned proxy:

```
PROXY_IDENTITY_MISMATCH
```

Stop. Do not continue on the provider page.

`proxy_drift` must stay 0.
