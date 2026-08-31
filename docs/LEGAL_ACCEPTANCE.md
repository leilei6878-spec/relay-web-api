# Versioned legal documents and explicit acceptance

Schema 18 records the exact Terms/Privacy bundle accepted during public
registration or invitation acceptance. This is an evidence mechanism, not a
substitute for counsel approval.

## Configuration

Create and activate immutable versions in `/commercial-config`:

- `legal.operatorName` / `RELAY_LEGAL_OPERATOR_NAME`;
- `legal.contactEmail` / `RELAY_LEGAL_CONTACT_EMAIL`;
- `legal.termsVersion` / `RELAY_TERMS_VERSION`;
- `legal.privacyVersion` / `RELAY_PRIVACY_VERSION`;
- `legal.effectiveDate` / `RELAY_LEGAL_EFFECTIVE_DATE` (`YYYY-MM-DD`).

The deployment hard gate `RELAY_LEGAL_APPROVED=1` and the independently
reviewed `legal_documents` launch-evidence item remain mandatory. Activating
metadata does not claim legal approval.

The public `GET /api/saas/legal` response includes the active metadata, source
content revision and SHA-256 of the canonical bundle. The hash covers operator,
contact, versions, effective date and every displayed Terms/Privacy section.
When text changes, publish new version identifiers and obtain a fresh legal
review; never reuse an old version name for new content.

## Acceptance contract

Registration and invite forms require an explicit unchecked checkbox. They
submit the current terms version, privacy version and bundle SHA-256. The
server recomputes all values from effective configuration and rejects missing,
unapproved or stale submissions.

`relay_legal_acceptances` stores:

- user and tenant IDs;
- both document versions and exact bundle SHA-256;
- `registration` or `invite` method;
- acceptance timestamp;
- HMAC-only client IP and User-Agent evidence.

It stores no raw IP, User-Agent, email, cookie or action token. Database
triggers reject updates/deletes. The business user/tenant/membership write and
acceptance record are one PostgreSQL statement, so a failed record cannot leave
an activated account without matching consent evidence.

Existing users are deliberately not backfilled: fabricated historical consent
is worse than a missing record. Before relying on an older account for paid
service, obtain a new explicit acceptance through a reviewed re-consent flow or
contract process and retain the external evidence.

## Version changes and re-consent

When any effective operator/contact/version/date or bundled legal text changes,
the canonical SHA-256 changes. Existing browser sessions remain authenticated
only for consent, logout, data-rights access and the MFA enrollment needed to
protect a sensitive export/closure operation; service and billing APIs return
`LEGAL_RECONSENT_REQUIRED`, and Login/Portal redirect to `/saas/consent`.
The consent page links to `/saas/privacy-center`, so declining a new agreement
never removes access to export or tenant-closure rights.

The consent page displays the new versions and full bundle hash, requires a new
unchecked explicit action and appends a `reconsent` record. Replaying the same
accepted bundle is idempotent. A later bundle change makes the record stale
without editing history.

Paid machine credentials also fail closed: a `sk-saas-*` key is not accepted
unless at least one active Owner/Admin membership has accepted the exact current
bundle. This prevents unattended paid traffic from continuing under superseded
commercial terms. Internal `sk-relay-*` web-pool operations remain outside this
customer legal gate.

## Acceptance test

Before opening registration:

1. Verify public pages show the reviewed operator, contact, versions, effective
   date and bundle hash.
2. Confirm unchecked, stale-version and unapproved submissions fail.
3. Complete both registration and invite flows and compare the two immutable
   database rows with the public bundle hash.
4. Verify raw email/IP/User-Agent values do not appear in the acceptance table
   or commercial admin response.
5. Attempt update/delete in an isolated restore and confirm both are rejected.
6. Publish a new test version, confirm sessions redirect to re-consent and paid
   keys fail, then record Owner/Admin re-consent and confirm both resume.
