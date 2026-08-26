CREATE TABLE IF NOT EXISTS relay_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT,
  tenant_id TEXT,
  key_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  final_attempt_id TEXT,
  final_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  extra JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS relay_requests_idempotency
  ON relay_requests (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS relay_attempts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  job_id TEXT,
  account_id TEXT,
  proxy_id TEXT,
  worker_id TEXT,
  lease_id TEXT,
  fencing_token INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  fault_domain TEXT,
  result JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  extra JSONB
);

CREATE INDEX IF NOT EXISTS relay_attempts_request_idx ON relay_attempts (request_id);

CREATE TABLE IF NOT EXISTS relay_circuit (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  opened_at TIMESTAMPTZ,
  extra JSONB
);

CREATE TABLE IF NOT EXISTS relay_media (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  store TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS canary BOOLEAN NOT NULL DEFAULT FALSE;
