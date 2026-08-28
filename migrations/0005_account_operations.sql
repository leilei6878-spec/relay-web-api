ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS batch TEXT NOT NULL DEFAULT '';
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS login_ip TEXT;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS last_probe_ip TEXT;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS ip_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS next_probe_at TIMESTAMPTZ;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS last_health_at TIMESTAMPTZ;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS last_static_probe_at TIMESTAMPTZ;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS last_proxy_probe_at TIMESTAMPTZ;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS last_live_probe_at TIMESTAMPTZ;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS consecutive_probe_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS health_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS auto_check BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE relay_accounts ADD COLUMN IF NOT EXISTS inspection_id TEXT;

UPDATE relay_accounts
   SET health_score = CASE WHEN status = 'healthy' THEN 100 ELSE health_score END,
       updated_at = COALESCE(updated_at, created_at, now());

CREATE INDEX IF NOT EXISTS relay_accounts_status_idx ON relay_accounts (status);
CREATE INDEX IF NOT EXISTS relay_accounts_platform_idx ON relay_accounts (platform);
CREATE INDEX IF NOT EXISTS relay_accounts_expires_idx ON relay_accounts (expires_at);
CREATE INDEX IF NOT EXISTS relay_accounts_next_probe_idx ON relay_accounts (next_probe_at) WHERE auto_check = TRUE;
CREATE INDEX IF NOT EXISTS relay_accounts_email_lower_idx ON relay_accounts (lower(email));

CREATE TABLE IF NOT EXISTS relay_account_check_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT 'admin',
  scope JSONB NOT NULL DEFAULT '{}'::JSONB,
  levels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  extra JSONB
);

CREATE INDEX IF NOT EXISTS relay_account_check_runs_created_idx
  ON relay_account_check_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS relay_account_checks (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  trigger TEXT NOT NULL,
  level TEXT NOT NULL,
  status TEXT NOT NULL,
  result_code TEXT,
  detail TEXT,
  expected_ip TEXT,
  observed_ip TEXT,
  ip_state TEXT,
  page_state TEXT,
  latency_ms INTEGER,
  worker_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  extra JSONB
);

CREATE INDEX IF NOT EXISTS relay_account_checks_account_idx
  ON relay_account_checks (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS relay_account_checks_run_idx
  ON relay_account_checks (run_id, started_at ASC);
CREATE INDEX IF NOT EXISTS relay_account_checks_result_idx
  ON relay_account_checks (result_code, started_at DESC);

CREATE TABLE IF NOT EXISTS relay_account_daily_snapshots (
  day DATE NOT NULL,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  available BOOLEAN NOT NULL,
  schedulable BOOLEAN NOT NULL,
  reason TEXT,
  observed_ip TEXT,
  expires_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra JSONB,
  PRIMARY KEY (day, account_id)
);

CREATE INDEX IF NOT EXISTS relay_account_daily_platform_idx
  ON relay_account_daily_snapshots (day DESC, platform);

CREATE TABLE IF NOT EXISTS relay_account_inspections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT 'admin',
  proxy_id TEXT,
  expected_ip TEXT,
  observed_ip TEXT,
  session_base_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  close_reason TEXT,
  extra JSONB
);

CREATE INDEX IF NOT EXISTS relay_account_inspections_account_idx
  ON relay_account_inspections (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS relay_account_inspections_expiry_idx
  ON relay_account_inspections (expires_at) WHERE status IN ('queued', 'active');

INSERT INTO relay_meta (key, value)
VALUES ('schema_version', '5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
