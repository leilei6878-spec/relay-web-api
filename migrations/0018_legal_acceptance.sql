CREATE TABLE IF NOT EXISTS relay_legal_acceptances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  ip_hmac TEXT NOT NULL,
  user_agent_hmac TEXT NOT NULL,
  acceptance_method TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(terms_version) BETWEEN 1 AND 80),
  CHECK (length(privacy_version) BETWEEN 1 AND 80),
  CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (ip_hmac ~ '^[0-9a-f]{64}$'),
  CHECK (user_agent_hmac ~ '^[0-9a-f]{64}$'),
  CHECK (acceptance_method IN ('registration','invite'))
);

CREATE INDEX IF NOT EXISTS relay_legal_acceptances_user_time
  ON relay_legal_acceptances(user_id,accepted_at DESC);
CREATE INDEX IF NOT EXISTS relay_legal_acceptances_tenant_time
  ON relay_legal_acceptances(tenant_id,accepted_at DESC);

CREATE OR REPLACE FUNCTION relay_protect_legal_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legal acceptance is append-only';
END;
$$;

DROP TRIGGER IF EXISTS relay_legal_acceptance_guard ON relay_legal_acceptances;
CREATE TRIGGER relay_legal_acceptance_guard
BEFORE UPDATE OR DELETE ON relay_legal_acceptances
FOR EACH ROW EXECUTE FUNCTION relay_protect_legal_acceptance();

INSERT INTO relay_meta(key,value) VALUES ('schema_version','18')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();

