ALTER TABLE relay_saas_users
  ADD COLUMN IF NOT EXISTS mfa_pending_secret_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS mfa_pending_expires_at TIMESTAMPTZ;

ALTER TABLE relay_saas_users
  DROP CONSTRAINT IF EXISTS relay_saas_users_mfa_pending_pair_check;
ALTER TABLE relay_saas_users
  ADD CONSTRAINT relay_saas_users_mfa_pending_pair_check CHECK (
    (mfa_pending_secret_ciphertext IS NULL) = (mfa_pending_expires_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS relay_saas_users_mfa_pending_expiry
  ON relay_saas_users(mfa_pending_expires_at)
  WHERE mfa_pending_secret_ciphertext IS NOT NULL;

ALTER TABLE relay_saas_sessions
  DROP CONSTRAINT IF EXISTS relay_saas_sessions_revoked_reason_check;
ALTER TABLE relay_saas_sessions
  ADD CONSTRAINT relay_saas_sessions_revoked_reason_check CHECK (
    revoked_reason IS NULL OR revoked_reason IN (
      'logout','password_reset','tenant_closed','user_revoke',
      'user_revoke_others','mfa_recovery_rotation','mfa_reenrollment'
    )
  );

INSERT INTO relay_meta(key,value) VALUES ('schema_version','22')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
