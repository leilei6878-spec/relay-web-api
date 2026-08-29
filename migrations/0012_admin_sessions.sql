CREATE TABLE IF NOT EXISTS relay_admin_sessions (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  auth_method TEXT NOT NULL,
  mfa_verified_at TIMESTAMPTZ,
  client_ip_sha256 TEXT NOT NULL,
  user_agent_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (client_ip_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (user_agent_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (auth_method IN ('password','recovery_token','development')),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS relay_admin_sessions_expiry
  ON relay_admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS relay_admin_sessions_active
  ON relay_admin_sessions(token_sha256,expires_at) WHERE revoked_at IS NULL;

INSERT INTO relay_meta(key,value) VALUES ('schema_version','12')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
