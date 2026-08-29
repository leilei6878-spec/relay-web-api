# Commercial launch evidence ledger

Configuration describes desired state; it does not prove an external fact.
Relay therefore requires a separate append-only launch-evidence ledger before
commercial traffic or Stripe Checkout can become ready.

## Required evidence

The fixed catalog includes:

- written commercial rights for every provider referenced by an active price;
- independent review of every exact active price version;
- independent review of every active plan snapshot; changing monthly fee,
  included credit, limits or features creates a new hash-bound requirement;
- Terms, Privacy, DPA and sales-scope legal approval;
- Stripe Tax configuration or a written tax exemption decision;
- live payment, Webhook, refund and dispute acceptance;
- production email delivery when registration is enabled;
- real HA topology and failover verification;
- restore from a distinct-account or distinct-region backup;
- alert delivery plus an external availability probe;
- the approved 200-request concurrency test;
- a 24-hour production-candidate soak;
- the authoritative repository's CI/security/build/SBOM release gates.

Provider and price requirements are dynamic. Publishing a new provider or
price version immediately creates a new unmet requirement; evidence for an old
price ID cannot satisfy the new one.

## Evidence contract

An evidence version contains only metadata:

- fixed requirement and subject;
- `passed`, `failed` or `revoked` conclusion;
- an HTTPS reference without credentials/query parameters, or an opaque ticket
  identifier;
- SHA-256 of the externally stored document or test artifact;
- recorder, distinct independent reviewer, observed time and expiry;
- a bounded non-secret note.

The application does not upload or retain the evidence file. API keys, Stripe
secrets, private keys and password-shaped notes are rejected. A database
trigger rejects every UPDATE and DELETE. Withdrawal is represented by a new
`revoked` version, preserving the earlier claim and audit trail.

Maximum validity is bounded by requirement: seven days for alert delivery,
30 days for infrastructure/load/soak/CI, 90 days for live payment acceptance,
and 365 days for legal, tax, provider-rights and exact-price review. Expired,
failed, revoked, missing or future-dated evidence is invalid.

## Operations

Administrators use `/commercial-readiness` and
`/api/admin/commercial-evidence`. Recording requires the exact confirmation
`EVIDENCE_REVIEWED`, a 64-character SHA-256 and a reviewer identity different
from the recording administrator.

`GET /api/saas/readiness` exposes only evidence counts. The detailed reference,
hash and reviewer remain administrator-only. When commercial mode is enabled,
any invalid requirement is a hard readiness and Checkout blocker. Monitoring
also opens `COMMERCIAL_LAUNCH_EVIDENCE_MISSING`; it is a warning during dark
launch and critical after commercial enablement.

The ledger makes missing evidence explicit and non-destructive. It cannot prove
that a manually referenced document is truthful; organizational access control
and the independent reviewer remain responsible for that fact. It does prevent
a single environment boolean from silently standing in for the required
evidence and ensures every claim is attributable, versioned and expiring.
