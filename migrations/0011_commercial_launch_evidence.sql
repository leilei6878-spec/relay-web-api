CREATE TABLE IF NOT EXISTS relay_commercial_launch_evidence (
  id TEXT PRIMARY KEY,
  requirement TEXT NOT NULL,
  subject TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  artifact_ref TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE(requirement,subject,version),
  CHECK (requirement IN (
    'provider_rights','price_review','legal_documents','tax_review',
    'payment_acceptance','email_delivery','ha_topology','offsite_restore',
    'alert_delivery','load_test_200','production_soak_24h','release_ci'
  )),
  CHECK (status IN ('passed','failed','revoked')),
  CHECK (source IN ('manual','automated')),
  CHECK (length(subject) BETWEEN 1 AND 200),
  CHECK (length(artifact_ref) BETWEEN 3 AND 500),
  CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (length(note) <= 500),
  CHECK (length(recorded_by) BETWEEN 1 AND 120),
  CHECK (length(reviewed_by) BETWEEN 3 AND 160),
  CHECK (lower(recorded_by) <> lower(reviewed_by)),
  CHECK (valid_until > observed_at)
);

CREATE INDEX IF NOT EXISTS relay_commercial_launch_evidence_latest
  ON relay_commercial_launch_evidence(requirement,subject,version DESC);
CREATE INDEX IF NOT EXISTS relay_commercial_launch_evidence_expiry
  ON relay_commercial_launch_evidence(valid_until) WHERE status='passed';

CREATE OR REPLACE FUNCTION relay_protect_commercial_launch_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial launch evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS relay_commercial_launch_evidence_guard ON relay_commercial_launch_evidence;
CREATE TRIGGER relay_commercial_launch_evidence_guard
BEFORE UPDATE OR DELETE ON relay_commercial_launch_evidence
FOR EACH ROW EXECUTE FUNCTION relay_protect_commercial_launch_evidence();

INSERT INTO relay_meta(key,value) VALUES ('schema_version','11')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
