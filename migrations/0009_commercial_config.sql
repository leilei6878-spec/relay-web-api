CREATE TABLE IF NOT EXISTS relay_commercial_config_versions (
  id TEXT PRIMARY KEY,
  config_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  value_json JSONB,
  secret_ciphertext TEXT,
  secret_hint TEXT,
  validation_status TEXT NOT NULL DEFAULT 'untested',
  test_detail JSONB NOT NULL DEFAULT '{}'::JSONB,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  tested_by TEXT,
  activated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tested_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(config_key,version),
  CHECK ((secret_ciphertext IS NULL) <> (value_json IS NULL)),
  CHECK (status IN ('draft','active','retired','rejected')),
  CHECK (validation_status IN ('untested','passed','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS relay_commercial_config_one_active
  ON relay_commercial_config_versions(config_key) WHERE status='active';
CREATE INDEX IF NOT EXISTS relay_commercial_config_history
  ON relay_commercial_config_versions(config_key,version DESC);

CREATE OR REPLACE FUNCTION relay_protect_commercial_config_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial configuration history is append-only';
  END IF;
  IF NEW.config_key <> OLD.config_key OR NEW.version <> OLD.version OR
     NEW.value_json IS DISTINCT FROM OLD.value_json OR
     NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext OR
     NEW.secret_hint IS DISTINCT FROM OLD.secret_hint OR
     NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'commercial configuration value is immutable';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relay_commercial_config_version_guard ON relay_commercial_config_versions;
CREATE TRIGGER relay_commercial_config_version_guard
BEFORE UPDATE OR DELETE ON relay_commercial_config_versions
FOR EACH ROW EXECUTE FUNCTION relay_protect_commercial_config_version();

INSERT INTO relay_meta(key,value) VALUES ('schema_version','9')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
