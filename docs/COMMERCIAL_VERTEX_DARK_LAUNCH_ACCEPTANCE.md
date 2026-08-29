# Vertex AI commercial transport dark-launch acceptance

Date: 2026-08-29 (Asia/Shanghai)

## Release

- version: `0.10.0-rc5`
- schema: `9`
- runtime commit: `e4b307b949bf726f5f9fc94acf43e9735bc55993`
- commercial and registration hard gates remain closed

## Delivered

- `vertex:<model>` resolves to an independent `vertex` commercial provider and
  price-book namespace; it no longer falls through to the Gemini API-key path;
- strict service-account JSON parsing with fixed Google OAuth token URI;
- bounded RS256 JWT assertion using service account issuer, Cloud Platform
  scope, fixed audience and less-than-one-hour lifetime;
- URL-encoded JWT-bearer exchange for a short-lived access token;
- access token cached only in process memory and keyed by credential material;
- project and region validation with fixed regional/global
  `aiplatform.googleapis.com` publisher-model endpoint construction;
- Vertex `generateContent` Chat usage settlement and Gemini image inline-data
  extraction;
- Vertex service account, project and location configuration-center entries;
- OAuth connection test before secret activation;
- Vertex provider option in commercial price publishing and Readiness.

## Evidence

- service-account JWT signature is verified with the generated public key in
  automated tests;
- assertion algorithm, audience, scope and lifetime are asserted;
- token cache avoids a second OAuth exchange and never persists the token;
- arbitrary token URI, project, location and model path inputs fail closed;
- Chat and image adapter tests verify exact regional URL, Bearer token, response
  parsing and authoritative usage metadata;
- active encrypted Vertex configuration is proven to feed the runtime adapter;
- arbitrary price providers are rejected while `vertex` is accepted;
- Relay tests: 291 passed;
- operations/migration/security tests: 21 passed;
- template/restore tests: 101 passed;
- commercial tests: 42 passed;
- type, lint, production build and dependency audit: passed; 0 vulnerabilities.

Production reports `0.10.0-rc5`, schema 9 and the exact commit above. The
administrator catalog exposes 21 fixed entries including three Vertex entries.
There are zero production configuration versions and zero commercial tenants,
so no service account was stored and no Vertex request was attempted.

## Remaining live acceptance

Before enabling Vertex models, operations must create a dedicated least-
privilege service account with `aiplatform.endpoints.predict`, activate the
project/location/credential versions, publish reviewed Vertex prices, run the
OAuth connection test and execute separately approved low-value Chat/image
canaries. Preview image models must not be sold unless their terms and launch
stage are explicitly accepted.

Official references:

- service-account OAuth: https://developers.google.com/identity/protocols/oauth2/service-account
- Vertex regional `generateContent`: https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling
- Vertex Gemini image quickstart: https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart
