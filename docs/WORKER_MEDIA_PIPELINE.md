# Worker media pipeline

Image bytes leave the worker through `POST /api/worker/media`, not through job JSON.

```
Provider download
→ magic (PNG/JPEG/WebP)
→ POST /api/worker/media
   (worker token + job_id + attempt_id + lease_id + fencing_token)
→ MediaStore
→ asset_id + stable url
→ /api/worker/result { url: /api/media/..., assetIds }
```

Stale fencing tokens are 409 `STALE_LEASE`. An old worker cannot write into a new attempt.

Job / Redis / result body store:

- `asset_id`
- `url`
- `sha256`
- `mime`
- `bytes`
- `width` / `height`

They do not store the image payload. `response_format=b64_json` reads the asset at the API edge.

Metrics: `worker_media_upload_ms`, `media_store_ms`.

Live 15MB soak: **NOT_EXECUTED**. Unit covers 1MB / 5MB / 15MB store put.
