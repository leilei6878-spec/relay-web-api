# Backup / Restore

Production recovery has two independently verified parts:

1. control plane: PostgreSQL, encrypted session/control files and full Git
   history;
2. object media: an S3 API snapshot with a sorted per-object size/SHA-256
   manifest.

Never accept a live tar of a MinIO data volume as object recovery evidence.
MinIO changes internal metadata while serving traffic, so a readable archive
can still have a different file set from the live volume. Use the S3 API.

## Assets and invariants

| Asset | Backup evidence | Restore evidence |
|---|---|---|
| PostgreSQL | custom-format `relay.dump`, byte count and SHA-256; `pg_dump` failure makes the manifest incomplete | checksum verification, then `pg_restore`; production drills restore into an isolated database and compare signatures |
| Encrypted secrets/sessions | regular non-symlink files under `storage/`, each with byte count and SHA-256 | every file verified before any copy; unsafe paths and symlinks rejected |
| Git | complete current branch + tags bundle, separate SHA-256 | `git bundle verify`, isolated branch clone, `git fsck --full`, exact HEAD comparison |
| Object media | source bucket first mirrored to a private local stage; sorted path/size/SHA-256 manifest | offsite prefix mirrored back to a second stage and matched byte-for-byte before backup success |
| Environment secrets | approved secret manager, outside the backup bucket | separately authorized injection; never embedded in the manifest |

Object media keys are UUID-based and immutable in the application. The
offsite job still stages and re-downloads the captured set so success does not
depend on provider ETags, multipart semantics or raw-volume layout.

## Local control-plane backup

```bash
NODE_ENV=production node scripts/backup.mjs \
  --storage /opt/relay/data \
  --out /opt/backups/relay-$(date +%F) \
  --require-db

node scripts/restore.mjs --from /opt/backups/relay-YYYY-MM-DD --dry-run
```

`--dry-run` verifies file and database-dump hashes without requiring a
destination `DATABASE_URL`. A real restore requires `DATABASE_URL` and uses
`pg_restore --clean --if-exists --no-owner --no-privileges`.

`PG_DUMP_BIN` and `PG_RESTORE_BIN` may select packaged binaries. A production
backup never falls back to PGLite or a JSON stand-in.

## Offsite backup

Configure a destination account/region that is separate from production:

```bash
export RELAY_BACKUP_S3_ENDPOINT=https://offsite.example
export RELAY_BACKUP_S3_BUCKET=relay-offsite
export RELAY_BACKUP_S3_ACCESS_KEY=...
export RELAY_BACKUP_S3_SECRET_KEY=...
docker compose --profile ops run --rm backup
```

The command fails closed unless all of the following complete:

- the control-plane manifest is complete;
- the Git repository is non-shallow, passes fsck and clones from its bundle at
  the exact source HEAD;
- the production object bucket is mirrored to a private stage and hashed;
- control artifacts and object bytes are uploaded to a unique offsite prefix;
- the object prefix is downloaded again and matches every captured path, byte
  count and SHA-256;
- the final `offsite-manifest.json` is marked complete, uploaded, downloaded
  and checksum-matched together with `offsite-manifest.sha256`.

The job refuses an offsite endpoint/bucket pair identical to production.
The offsite endpoint must be a credential-free HTTPS origin and both bucket
names must satisfy the safe S3 naming contract.
Genuine distinct-account/region ownership remains an external launch-evidence
requirement. The opt-in `backup` profile contains PostgreSQL 16 `pg_dump`,
Node, Git and `mc`; it read-only mounts the repository and application storage
and writes only to `RELAY_BACKUP_HOST`. For an external runner, `MC_BIN` can
select the approved MinIO client binary.

## Download and verify before restore

Mirror one offsite prefix to an empty directory so it contains
`control-plane/` and `object-media/`, then run:

```bash
docker compose --profile ops run --rm --no-deps --entrypoint node backup \
  scripts/verify-offsite-snapshot.mjs \
  --from /opt/backups/relay-offsite-TIMESTAMP
```

The verifier performs the control-plane dry-run, full Git clone/fsck/HEAD
comparison and exact object-media manifest check. It makes no database or
bucket mutation.

Store the printed `offsiteManifestSha256` in the independently controlled
evidence/secret system. A checksum stored only beside the same backup protects
against corruption, but cannot authenticate the backup against a party that
can rewrite the entire bucket.

Only after that verifier passes:

1. restore `control-plane/` with `scripts/restore.mjs` into an isolated
   database and compare the documented production signature;
2. mirror `object-media/` into an empty replacement bucket;
3. verify the replacement bucket by downloading it again and checking
   `object-media.manifest.json`;
4. inject secrets from the secret manager;
5. boot the exact recovered Git commit and run `/healthz`, `/readyz`, customer
   authentication, billing-ledger and provider smoke checks;
6. record independently reviewed `offsite_restore` launch evidence.

The accepted rc13 drill is documented in
`TENANT_AUDIT_DARK_LAUNCH_ACCEPTANCE.md`: PostgreSQL schema 15, 44 tables,
eight triggers, complete Git history, 272 filesystem files and 96 S3 objects
were independently restored and matched.
