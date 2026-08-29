CREATE TABLE IF NOT EXISTS relay_provider_sandbox_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('openai','google','vertex','leonardo')),
  model TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('chat','image')),
  mode TEXT NOT NULL DEFAULT 'live' CHECK (mode='live'),
  status TEXT NOT NULL CHECK (status IN ('running','passed','failed')),
  currency TEXT NOT NULL,
  estimated_charge_minor BIGINT NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  upstream_reference TEXT,
  error_code TEXT,
  error_message TEXT,
  initiated_by TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  detail JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS relay_provider_sandbox_recent
  ON relay_provider_sandbox_runs(provider,model,capability,status,finished_at DESC);

CREATE OR REPLACE FUNCTION relay_protect_provider_sandbox_run()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'provider sandbox evidence is append-only'; END IF;
  IF NEW.provider<>OLD.provider OR NEW.model<>OLD.model OR NEW.capability<>OLD.capability OR
     NEW.mode<>OLD.mode OR NEW.currency<>OLD.currency OR
     NEW.estimated_charge_minor<>OLD.estimated_charge_minor OR
     NEW.initiated_by<>OLD.initiated_by OR NEW.started_at<>OLD.started_at THEN
    RAISE EXCEPTION 'provider sandbox identity is immutable';
  END IF;
  IF OLD.status IN ('passed','failed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'final provider sandbox evidence is immutable';
  END IF;
  IF OLD.status='running' AND NEW.status NOT IN ('running','passed','failed') THEN
    RAISE EXCEPTION 'provider sandbox status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relay_provider_sandbox_guard ON relay_provider_sandbox_runs;
CREATE TRIGGER relay_provider_sandbox_guard
BEFORE UPDATE OR DELETE ON relay_provider_sandbox_runs
FOR EACH ROW EXECUTE FUNCTION relay_protect_provider_sandbox_run();

INSERT INTO relay_meta(key,value) VALUES ('schema_version','10')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
