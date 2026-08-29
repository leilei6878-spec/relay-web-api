# Official provider live sandbox

Route: `/commercial-sandbox`

The sandbox provides bounded real-upstream evidence before an official model is
allowed to serve paid traffic. It is separate from unit mocks and read-only
credential tests because neither proves that a model, IAM permission, region,
quota and response parser work together.

## Hard controls

- `RELAY_ALLOW_LIVE_PROVIDER_CANARY=1` must be set by deployment operations.
- The administrator must type `LIVE_COST_ACCEPTED` for every run.
- The exact provider/model/capability/currency must have an active price-book
  version.
- Estimated customer charge must be positive and no greater than
  `RELAY_CANARY_MAX_CHARGE_MINOR` (default 100 minor units).
- One Chat response or one 1024×1024 image is requested. Leonardo Chat is
  rejected because its official API has no Chat capability.
- Prompts are fixed in code. Administrators cannot submit arbitrary content.

## Data minimization

Chat asks for exactly `RELAY_CANARY_OK`. Image asks for a neutral gray square.
Prompt, response text, image bytes/URLs and raw provider response are never
written to PostgreSQL. Evidence stores only provider/model/capability, status,
bounded usage counts, upstream reference, sanitized error code/message,
estimated charge and timestamps.

Evidence identity is immutable and rows cannot be deleted. Status may move only
from running to passed/failed. Provider errors remove URLs, emails, Bearer values
and common key prefixes before persistence.

## Readiness requirement

For every active price-book route, Readiness requires an exact passed live
canary for provider/model/capability within
`RELAY_PROVIDER_CANARY_MAX_AGE_HOURS` (default 24 hours). Missing evidence is a
critical durable alert. Republishing a model, changing capability or allowing
evidence to expire blocks commercial readiness until a new run passes.

## Operating sequence

1. Configure and test the provider secret in `/commercial-config`.
2. Publish the reviewed exact model price.
3. Temporarily open the live-canary deployment hard gate.
4. Run the exact route in `/commercial-sandbox` and inspect sanitized evidence.
5. Close the hard gate when canaries are complete.
6. Confirm Readiness reports zero missing canaries.

Canary success proves only technical connectivity at that moment. It does not
replace commercial rights, model launch-stage approval, tax/legal review or the
24-hour system soak.
