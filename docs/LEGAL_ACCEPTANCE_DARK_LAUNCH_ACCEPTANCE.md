# Versioned legal acceptance dark-launch acceptance

Date: 2026-08-31 (Asia/Shanghai)

## Release

- version: `0.10.0-rc18`;
- schema: `18`;
- runtime/deployment commit:
  `9146eccd33036752e1a53bf4d4029c0f7809fa27`;
- public charging, registration and legal-approval gates remain disabled.

## Delivered

- versioned operator name, public legal contact, Terms version, Privacy version
  and effective date in Commercial Configuration;
- one canonical public content revision shared by the rendered Terms/Privacy
  pages and SHA-256 bundle calculation;
- public no-store legal metadata endpoint with configured/approved status,
  versions, revision and exact bundle hash;
- explicit unchecked acceptance controls on registration and invitation forms;
  submit buttons remain disabled until the active approved bundle is checked;
- server-side rejection of missing, unapproved or stale version/hash input;
- registration commits user, tenant, membership, optional verification Outbox
  and legal acceptance in one PostgreSQL statement;
- invitation acceptance commits user/membership, invite consumption and legal
  acceptance in one PostgreSQL statement;
- append-only `relay_legal_acceptances` with user/tenant IDs, both versions,
  exact bundle hash, method, timestamp and HMAC-only IP/User-Agent evidence;
- Commercial Operations exposes safe acceptance metadata without raw email,
  IP, User-Agent, cookies or tokens;
- no synthetic backfill for existing users and no retention deletion path.

## Verification

- Relay tests: 346 passed;
- commercial tests: 73 passed;
- CI operations/security/recovery tests: 35 passed, with two Windows-only
  symlink cases skipped;
- template/release/backup tests: 117 passed, with the same platform skips;
- TypeScript, ESLint, production build and dependency audit passed; audit found
  zero known vulnerabilities;
- tests cover deterministic hash binding, changed-version hash change, strict
  date/email/version validation, stale/unapproved/unchecked rejection,
  edge-overwritten IP HMAC, absence of raw network evidence, append-only DB
  triggers, atomic registration rollback and production invite acceptance;
- browser QA with configured test metadata verified both explicit checkboxes,
  disabled-until-checked buttons, operator/contact, document versions,
  effective date and identical full bundle hash on Terms/Privacy pages, with no
  console warnings/errors.

## Production and recovery evidence

- pre-deploy accepted backup:
  `/opt/backups/relay-client-network-final-20260830054626`;
- isolated schema17 restore plus migration18 produced schema18, 47 tables and
  five unchanged accounts; update/delete of a test acceptance were rejected;
- public HTTPS health reports rc18/schema18/exact commit; Terms and Privacy
  routes return 200 with valid TLS;
- public legal metadata correctly reports `configured=false` and
  `approved=false`; SaaS readiness reports the same and registration remains
  disabled, so no acceptance was fabricated;
- production database reports 18 migrations, 47 tables, five internal
  accounts, zero tenants, zero legal acceptances and zero email deliveries;
- one Worker and the dedicated Scheduler remain online;
- release evidence:
  `/opt/backups/relay-release-evidence-9146eccd3303`;
- release-manifest SHA-256:
  `b44daa9a078081c05c4b4f1fc02d53d0b8f421dd12d7c2eab826d928477238d8`;
- CycloneDX production SBOM SHA-256:
  `de75a476797530c18466bf7188143cea1724180e5f343e4086dec3b178ffeb79`;
- final backup:
  `/opt/backups/relay-legal-acceptance-final-20260831025159`;
- every checksum, control-plane dry-run, complete Git bundle, PostgreSQL restore
  and object manifest passed; restored state matched schema18, 47 tables,
  18 migrations, five accounts, zero tenants/legal rows and 102 objects /
  46,172,450 bytes;
- the isolated restore database and staging directory were removed.

## External approval remains pending

No operator identity, contact, version or approval was invented in production.
Counsel must review the actual operator/jurisdictions/Terms/Privacy/DPA, then
the operator must activate the five metadata values, open the separate legal
hard gate and record independently reviewed `legal_documents` evidence before
registration can be enabled.

