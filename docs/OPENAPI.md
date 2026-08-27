# OpenAPI

- Spec file: [`/openapi.yaml`](../openapi.yaml)
- Public paths only. Admin and Worker surfaces are excluded (contract test).
- Version: `0.9.0-rc2`

SDK contract tests that need a live gateway (401/400/429/stream) live in `scripts/qa-api-compat.test.mjs` and skip when the server is down.
