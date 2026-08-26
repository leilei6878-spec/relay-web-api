CREATE TABLE IF NOT EXISTS relay_accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  email TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  proxy_id TEXT,
  session_path TEXT,
  session_version INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  last_probe_at TIMESTAMPTZ,
  session_warning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay_proxies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  sticky_session_id TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  max_accounts INTEGER NOT NULL DEFAULT 8,
  remark TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scopes TEXT NOT NULL DEFAULT 'chat,image',
  daily_limit INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay_jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  platform TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  account_id TEXT,
  account_email TEXT,
  worker_id TEXT,
  attempt_id TEXT,
  lease_id TEXT,
  fencing_token INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER NOT NULL,
  fault TEXT,
  error TEXT,
  text TEXT,
  url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS relay_jobs_idempotency ON relay_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS relay_usage (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id TEXT,
  job_id TEXT,
  attempt_id TEXT,
  worker_id TEXT,
  account_id TEXT,
  proxy_id TEXT,
  key_id TEXT,
  key_name TEXT,
  platform TEXT,
  model TEXT,
  ok BOOLEAN NOT NULL,
  latency_ms INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  mode TEXT
);

CREATE TABLE IF NOT EXISTS relay_audit (
  id TEXT PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  body JSONB NOT NULL
);
