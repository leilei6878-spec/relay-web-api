# Media Storage

`/api/media/:id` is **not** production-stable if bytes live only on the instance disk.

## Abstraction

```
MediaStore
  put(bytes, mime) → { id, url, mime, bytes }
  get(id) → { buf, mime } | null
```

| Implementation | When |
|---|---|
| `LocalMediaStore` | development / tests |
| `ObjectMediaStore` | production (S3 / R2 / OSS / MinIO-compatible) |

Flow after a successful Gemini generation:

Provider → Worker → download bytes → validate MIME/size → `MediaStore.put` → stable asset URL.

Temporary `googleusercontent` URLs must not be the long-term client URL.

## Production config

- `RELAY_S3_BUCKET`
- `RELAY_S3_ACCESS_KEY` or `AWS_ACCESS_KEY_ID`
- `RELAY_S3_SECRET_KEY` or `AWS_SECRET_ACCESS_KEY`
- optional `RELAY_S3_ENDPOINT`, `RELAY_S3_REGION`, `RELAY_S3_PUBLIC_BASE`

Missing any of the three required values ⇒ `ProductionReadinessCheck.media_store` fails. `getMediaStore()` throws in production.

## Verified

- MIME/size validation + local round-trip: **PASS** (`media-store.test.ts`).
- AWS SigV4 header generation for PUT: **PASS** (no live S3/MinIO was written).
- Live object-store PUT/GET against R2/S3/MinIO: **not executed** in this sandbox.
