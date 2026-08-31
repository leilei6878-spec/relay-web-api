ALTER TABLE relay_saas_sessions
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT,
  ADD COLUMN IF NOT EXISTS revoked_by_session_id TEXT;

ALTER TABLE relay_saas_sessions
  DROP CONSTRAINT IF EXISTS relay_saas_sessions_revoked_reason_check;
ALTER TABLE relay_saas_sessions
  ADD CONSTRAINT relay_saas_sessions_revoked_reason_check CHECK (
    revoked_reason IS NULL OR revoked_reason IN (
      'logout','password_reset','tenant_closed','user_revoke',
      'user_revoke_others','mfa_recovery_rotation'
    )
  );

CREATE INDEX IF NOT EXISTS relay_saas_sessions_user_active
  ON relay_saas_sessions(user_id,last_seen_at DESC,id)
  WHERE revoked_at IS NULL;

INSERT INTO relay_meta(key,value) VALUES ('schema_version','21')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
